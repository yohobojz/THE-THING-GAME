const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const lobbies = {};
const playerData = {};
const emergencyMeeting = {};
const roundNumber = {};

function assignRoles(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const roles = {};
  roles[shuffled[0]] = "THE THING";
  roles[shuffled[1]] = "Engineer";
  for (let i = 2; i < shuffled.length; i++) roles[shuffled[i]] = "Intern";
  const optionalRoles = ["Comms Expert","Soldier","Houndmaster","Night Owl","Defense Expert","Tracker","Security Expert"];
  const internIds = shuffled.slice(2);
  let guaranteed = players.length >= 8 ? 2 : players.length >= 6 ? 1 : 0;
  const assignable = Math.max(0, internIds.length - guaranteed);
  optionalRoles.sort(() => Math.random() - 0.5).slice(0, assignable)
    .forEach((role, i) => { roles[internIds[i]] = role; });
  return roles;
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // --- LOBBY CREATION / JOINING ---
  socket.on('createLobby', () => {
    const lobbyId = Math.random().toString(36).substr(2,6).toUpperCase();
    lobbies[lobbyId] = { players: [socket.id], host: socket.id };
    playerData[socket.id] = {
      lobbyId, role: 'unknown', displayName: '',
      messagesThisRound:0, currentRoom:socket.id,
      lastAction:null, intendedAction:null,intendedTarget:null,
      endedTurn:false, roundsSurvived:0, bioscannerReady:false,
      soldierUsed: false
    };
    emergencyMeeting[lobbyId] = null;
    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyCreated',{ lobbyId, isHost:true });
  });

  socket.on('joinLobby', (lobbyId) => {
    if (!lobbies[lobbyId]) return socket.emit('lobbyError','Lobby does not exist.');
    lobbies[lobbyId].players.push(socket.id);
    playerData[socket.id] = {
      lobbyId, role:'unknown', displayName:'',
      messagesThisRound:0, currentRoom:socket.id,
      lastAction:null, intendedAction:null,intendedTarget:null,
      endedTurn:false, roundsSurvived:0, bioscannerReady:false,
      soldierUsed: false
    };
    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyJoined',{ lobbyId, isHost:false });
  });

  socket.on('sendMessage', (msg) => {
    const data = playerData[socket.id];
    if (!data) return;

    if (msg.length > 120) {
      socket.emit('chatError', 'Message too long!');
      return;
    }

    if (data.messagesThisRound >= 1) {
      socket.emit('chatError', 'Only 1 message per round!');
      return;
    }

    data.messagesThisRound++;

    const { lobbyId, currentRoom } = data;

    if (emergencyMeeting[lobbyId]) {
      io.to(lobbyId).emit('receiveMessage', { from: playerData[socket.id]?.displayName || "Unknown", text: msg });
    } else {
      const recipients = Object.keys(playerData).filter(id => playerData[id].lobbyId === lobbyId && playerData[id].currentRoom === currentRoom);
      recipients.forEach(id => {
        io.to(id).emit('receiveMessage', { from: playerData[socket.id]?.displayName || "Unknown", text: msg });
      });
    }
  });

  socket.on('callEmergencyMeeting', () => {
    const data = playerData[socket.id];
    if (!data || data.hasCalledMeeting || emergencyMeeting[data.lobbyId]) return;

    data.hasCalledMeeting = true;
    emergencyMeeting[data.lobbyId] = socket.id;

    io.to(data.lobbyId).emit('emergencyMeetingStarted', { calledBy: socket.id });
  });

  socket.on('roomAction', ({ action, target }) => {
    const player = playerData[socket.id];
    if (!player) return;

    if (action === "hold") {
      player.intendedAction = "hold";
      player.intendedTarget = null;
    } else if (action === "visit" && target && playerData[target]) {
      if (target === socket.id) {
        socket.emit("chatError", "You can't visit yourself!");
        return;
      }
      player.intendedAction = "visit";
      player.intendedTarget = target;
    } else {
      return;
    }
  });

  socket.on('submitAction', () => {
    const player = playerData[socket.id];
    if (!player) return;

    if (!player.intendedAction) {
      socket.emit("chatError", "Choose hold or visit first!");
      return;
    }

    if (player.lastAction && player.intendedAction === player.lastAction) {
      socket.emit("chatError", "Can't do the same move two rounds in a row!");
      return;
    }

    // Tracker logic: If the player is a Tracker, store the last visited room of the target player
    if (player.role === 'Tracker' && player.intendedAction === 'visit' && player.intendedTarget) {
      const target = playerData[player.intendedTarget];
      if (target) {
        // Track the last visited room of the target
        player.lastVisitedRoom = target.currentRoom;  // Store the last visited room
        console.log(`[DEBUG] Tracker learned that ${target.displayName} last visited ${target.currentRoom}`);
      }
    }

    // Security Expert logic: If the player is a Security Expert, inform them of a visitor
    if (player.role === 'Security Expert' && player.intendedAction === 'visit') {
      const target = playerData[player.intendedTarget];
      if (target && target.currentRoom !== socket.id) {
        io.to(socket.id).emit('chatMessage', { from: 'System', text: 'Someone visited your room.' });
      }
    }

    if (player.intendedAction === "hold") {
      player.currentRoom = socket.id;
    } else if (player.intendedAction === "visit" && player.intendedTarget) {
      player.currentRoom = player.intendedTarget;
    }

    player.lastAction = player.intendedAction;
    player.intendedAction = null;
    player.intendedTarget = null;
  });

  socket.on('endTurn', () => {
  const player = playerData[socket.id];
  if (!player) return;
  if (player.endedTurn) return;
  player.endedTurn = true;

  const lobbyId = player.lobbyId;
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  // === DEBUG LOGGING START ===
  console.log(`\n[DEBUG endTurn] lobbyId=${lobbyId}`);
  console.log(`  All players: ${lobby.players.join(', ')}`);
  lobby.players.forEach(id => {
    const pd = playerData[id];
    console.log(`    ${id}: role=${pd.role}, endedTurn=${pd.endedTurn}`);
  });
  // === DEBUG LOGGING END ===

   // Only count players who are not DEAD
  const alivePlayers = lobby.players.filter(
  id => playerData[id].role !== "DEAD"
);

 // === DEBUG: alivePlayers list ===
  console.log(`  Alive players: ${alivePlayers.join(', ')}`);

  // Advance when every ALIVE player has ended their turn
  const allDone = alivePlayers.every(id => playerData[id].endedTurn);

// === DEBUG: allDone value ===
  console.log(`  allDone = ${allDone}\n`);

  if (allDone) {
    roundNumber[lobbyId]++;

    io.to(lobbyId).emit("newRoundStarted", { round: roundNumber[lobbyId] });

    // Reset per-round flags *only* for alive players
    alivePlayers.forEach(id => {
      const p = playerData[id];
      p.messagesThisRound = 0;
      p.endedTurn = false;

      // Engineer-survival tracking (unchanged)
      if (p.role === "Engineer" && !p.bioscannerReady) {
        p.roundsSurvived = (p.roundsSurvived || 0) + 1;
        if (p.roundsSurvived >= 3) {
          p.bioscannerReady = true;
          io.to(id).emit("bioscannerUnlocked");
        }
      }
    });

    // Comms Expert logic (unchanged)
    if (roundNumber[lobbyId] % 2 === 0) {
      const commsEntry = Object.entries(playerData).find(([id, p]) => p.lobbyId === lobbyId && p.role === 'Comms Expert');
      if (commsEntry) {
        const [commsId] = commsEntry;
        io.to(commsId).emit('showCommsPopup', { message: "You can send a global message to everyone!" });
    // The message will be displayed anonymously to everyone
          const globalMessage = "A global message from the Comms Expert!";
          io.to(lobbyId).emit('receiveMessage', { from: 'System', text: globalMessage });  // Broadcast the message to the lobby
      }
    }
  }
});

  socket.on('sendCommsMessage', ({ text }) => {
    const lobbyId = playerData[socket.id].lobbyId;

    // Send the global message to the entire lobby (anonymously)
    io.to(lobbyId).emit('receiveMessage', { from: 'System', text: text });

    // Optionally, hide the popup for the Comms Expert after sending the message
    socket.emit('hideCommsPopup');
  });

socket.on('consumePlayer', () => {
  const me = playerData[socket.id];
  if (!me) return;

  // Only the Thing, and only before ending your turn
  if (me.role !== "THE THING" || me.endedTurn) {
    socket.emit("consumeFailed", "Can't consume!");
    return;
  }

  const lobbyId = me.lobbyId;
  const roomMates = Object.entries(playerData)
    .filter(([id,p]) =>
      p.lobbyId === lobbyId &&
      p.currentRoom === me.currentRoom &&
      id !== socket.id &&
      p.role !== "DEAD"
    );

  if (roundNumber[lobbyId] === 1) {
    socket.emit("consumeFailed", "You can't consume on Round 1.");
    return;
  }
  if (roomMates.length !== 1) {
    socket.emit("consumeFailed", "You must be alone with exactly one other player.");
    return;
  }

  const [victimId, victim] = roomMates[0];

  // 1) Kill the victim
  victim.role       = "DEAD";
  victim.endedTurn  = true;
  victim.currentRoom = null;

  // 2) You stay THE THING, but inherit their room & name
  me.currentRoom   = victimId;
  // Optional: swap displayName so chat shows "Player X"
  me.displayName   = victim.displayName;

  // 3) Tell the victim they’ve been consumed
  io.to(victimId).emit("youHaveBeenConsumed");
  io.to(victimId).emit("gameStarted", {
    playerNumber: "???",
    totalPlayers: "???",
    role: "DEAD"
  });

  // 4) Tell you that you’ve successfully consumed
  io.to(socket.id).emit("youAreNowTheThing");

  // 5) Refresh everyone’s UI
  emitPlayerLists(lobbyId);
});

  socket.on('scanPlayer', ({ target }) => {
    const player = playerData[socket.id];
    const targetPlayer = playerData[target];

    // Check if the player exists, is an Engineer, and has a ready bioscanner
    if (!player || !targetPlayer || player.role !== 'Engineer' || !player.bioscannerReady) return;

    // Check if the Engineer has ended their turn
    if (player.endedTurn) {
      socket.emit('chatError', "You can no longer scan after ending your turn!");
      return;
    }

    // Check if both players are in the same room
    if (player.currentRoom !== targetPlayer.currentRoom) {
      socket.emit('chatError', "You can only scan players in the same room!");
      return;
    }

    // Perform the scan if both players are in the same room and scan conditions are met
    const isTheThing = targetPlayer.role === 'THE THING';
    socket.emit('scanResult', { playerName: targetPlayer.displayName, isTheThing });
  });

  socket.on('startGame', (lobbyId) => {
    if (!lobbies[lobbyId]) return;

    roundNumber[lobbyId] = 1;

    const assignedRoles = assignRoles(lobbies[lobbyId].players);

    lobbies[lobbyId].players.forEach((id, index) => {
      playerData[id].role = assignedRoles[id];
      playerData[id].displayName = `Player ${index + 1}`;
      playerData[id].messagesThisRound = 0;
      playerData[id].endedTurn = false;
      playerData[id].roundsSurvived = 0;
      playerData[id].bioscannerReady = false;
      io.to(id).emit('gameStarted', { playerNumber: index + 1, totalPlayers: lobbies[lobbyId].players.length, role: assignedRoles[id] });
    });

    emitPlayerLists(lobbyId);
  });

// --- SOLDIER ABILITY ---
socket.on('useSoldier', ({ target }) => {
  const me     = playerData[socket.id];
  const victim = playerData[target];
  if (!me || !victim) return socket.emit('chatError','Cannot use your kill right now.');

  // Pre‐checks
  if (me.role !== 'Soldier' || me.soldierUsed || me.endedTurn) {
    return socket.emit('chatError','Cannot use your kill right now.');
  }
  if (me.currentRoom !== victim.currentRoom) {
    return socket.emit('chatError','Target not in your room.');
  }

  try {
    // ——— Now we _know_ it’s valid, so mark it used ———
    me.soldierUsed = true;

    if (victim.role === 'THE THING') {
      // successful Thing kill…
      victim.role      = 'DEAD';
      victim.endedTurn = true;
      io.to(target).emit('youWereKilledBySoldier');
      io.to(socket.id).emit('soldierKillResult',{
        killedThing: true,
        targetName: victim.displayName
      });
    } else {
      // innocent→both die…
      victim.role      = 'DEAD';
      victim.endedTurn = true;
      me.role          = 'DEAD';
      me.endedTurn     = true;
      io.to(target).emit('youWereKilledBySoldier');
      io.to(socket.id).emit('soldierKillResult',{
        killedThing: false,
        targetName: victim.displayName
      });
    }

    emitPlayerLists(me.lobbyId);
  } catch (err) {
    // On any unexpected error, roll back the “used” flag
    me.soldierUsed = false;
    console.error('Error in useSoldier:', err);
    socket.emit('chatError','Something went wrong — your kill is still available.');
  }
});

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      lobbies[lobbyId].players = lobbies[lobbyId].players.filter(id => id !== socket.id);
      delete playerData[socket.id];

      if (lobbies[lobbyId].players.length === 0) {
        delete lobbies[lobbyId];
        delete emergencyMeeting[lobbyId];
      } else {
        emitPlayerLists(lobbyId);
      }
    }
    console.log('A user disconnected:', socket.id);
  });
});

function emitPlayerLists(lobbyId) {
  const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || id.substring(0, 5));
  const playerInfos = lobbies[lobbyId].players.map(id => ({ id, name: playerData[id]?.displayName || "Unknown", currentRoom: playerData[id]?.currentRoom }));
  io.to(lobbyId).emit('playerListUpdated', names);
  io.to(lobbyId).emit('updatePlayerList', playerInfos);
}

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
