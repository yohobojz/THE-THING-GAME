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

  for (let i = 2; i < shuffled.length; i++) {
    roles[shuffled[i]] = "Intern";
  }

  const optionalRoles = ["Comms Expert", "Soldier", "Houndmaster", "Night Owl", "Defense Expert", "Tracker", "Security Expert"];
  const internIds = shuffled.slice(2);

  let guaranteedInternCount = 0;
  if (players.length >= 8) guaranteedInternCount = 2;
  else if (players.length >= 6) guaranteedInternCount = 1;

  const assignableCount = Math.max(0, internIds.length - guaranteedInternCount);
  const shuffledOptional = optionalRoles.sort(() => Math.random() - 0.5);

  for (let i = 0; i < assignableCount && i < shuffledOptional.length; i++) {
    const playerId = internIds[i];
    roles[playerId] = shuffledOptional[i];
  }

  return roles;
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('createLobby', () => {
    const lobbyId = Math.random().toString(36).substr(2, 6).toUpperCase();
    lobbies[lobbyId] = { players: [socket.id], host: socket.id };
    playerData[socket.id] = {
      lobbyId,
      role: 'unknown',
      displayName: '',
      messagesThisRound: 0,
      currentRoom: socket.id,
      lastAction: null,
      intendedAction: null,
      intendedTarget: null,
      endedTurn: false,
      roundsSurvived: 0,
      bioscannerReady: false
    };
    emergencyMeeting[lobbyId] = null;
    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.push(socket.id);
      playerData[socket.id] = {
        lobbyId,
        role: 'unknown',
        displayName: '',
        messagesThisRound: 0,
        currentRoom: socket.id,
        lastAction: null,
        intendedAction: null,
        intendedTarget: null,
        endedTurn: false,
        roundsSurvived: 0,
        bioscannerReady: false
      };
      socket.join(lobbyId);
      emitPlayerLists(lobbyId);
      socket.emit('lobbyJoined', { lobbyId, isHost: false });
    } else {
      socket.emit('lobbyError', 'Lobby does not exist.');
    }
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
    
    if (player.role === "THE THING" && player.intendedAction === "visit" && player.intendedTarget) {
      const target = playerData[player.intendedTarget];
      if (target && target.currentRoom === player.currentRoom) {
        // Prevent the THING from visiting the consumed player's room
        socket.emit("chatError", "You cannot visit the room of the player you have consumed.");
        return;
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

    const allDone = lobbies[lobbyId].players.every(id => playerData[id]?.endedTurn || playerData[id]?.role === "DEAD");

    if (allDone) {
      roundNumber[lobbyId]++;

      io.to(lobbyId).emit("newRoundStarted", { round: roundNumber[lobbyId] });

      for (const id of lobbies[lobbyId].players) {
        const p = playerData[id];
        if (p) {
          p.messagesThisRound = 0;
          p.endedTurn = false;

          // 🧪 New bioscanner survival tracking
          if (p.role === "Engineer" && !p.bioscannerReady) {
            p.roundsSurvived = (p.roundsSurvived || 0) + 1;
            if (p.roundsSurvived >= 3) {
              p.bioscannerReady = true;
              io.to(id).emit("bioscannerUnlocked");
              console.log(`[DEBUG] ${p.displayName} has unlocked the bioscanner!`);
            }
          }
        }
      }

      // Check if it's an even-numbered round (Comms Expert should send a message)
      if (roundNumber[lobbyId] % 2 === 0) {
        // Find all Comms Experts in the lobby
        const commsExpert = Object.entries(playerData).find(([id, player]) => player.role === 'Comms Expert');

        if (commsExpert) {
          const commsExpertName = commsExpert[1].displayName;

          // Send message to Comms Expert to show popup
          io.to(commsExpert[0]).emit('showCommsPopup', { message: "You can send a global message to everyone!" });

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

    if (me.role !== "THE THING" || me.endedTurn) {
      socket.emit("consumeFailed", "Can't consume!");
      return;
    }

    const lobbyId = me.lobbyId;

 // Ensure the lobby exists
    if (!lobbies[lobbyId]) {
        console.error(`Error: Lobby with ID ${lobbyId} does not exist!`);
        return;
    }

    // Get the roommates in the current room
    const roomMates = Object.entries(playerData).filter(([id, p]) => p.lobbyId === lobbyId && p.currentRoom === me.currentRoom && id !== socket.id && p.role !== "DEAD");

    if (roundNumber[lobbyId] === 1) {
      socket.emit("consumeFailed", "You can't consume on Round 1.");
      return;
    }

    if (roomMates.length !== 1) {
      socket.emit("consumeFailed", "You must be alone with exactly one other player.");
      return;
    }

    const [victimId, victim] = roomMates[0]; // Get the victim's ID and data

    // Consume the player: Change roles
    playerData[socket.id].role = "DEAD";  // The THING dies (consumes)
    playerData[victimId].role = "THE THING";  // The consumed player becomes THE THING
    playerData[socket.id].currentRoom = null;  // The THING is no longer in the room

    // Set the THING's new room to the consumed player's room
    playerData[socket.id].currentRoom = playerData[victimId].currentRoom;

    // Track the consumed player's identity for the THING
    playerData[socket.id].consumedPlayer = {
      id: victimId,
      name: victim.displayName,
      playerNumber: victimId.substring(0, 5) // Extract player number
    };

    // Broadcast messages to the players (don't broadcast a "System" message)
    io.to(victimId).emit("youHaveBeenConsumed");
    io.to(victimId).emit("gameStarted", { playerNumber: "???", totalPlayers: "???", role: "DEAD" });
    io.to(socket.id).emit("youAreNowTheThing");

    // Update the dropdown (exclude the room of the consumed player from the list)
    emitPlayerLists(lobbyId);

    // Update the chat to reflect the new identity of the THING
    const newName = victim.displayName; // The THING now uses the consumed player's name
    io.to(lobbyId).emit('receiveMessage', { from: newName, text: `THE THING has consumed Player ${victim.displayName}.` });

    // Ensure that the THING can no longer visit the room of the consumed player
    io.to(socket.id).emit('updatePlayerList', playerData[lobbyId].players.filter(id => id !== victimId));

    // Update player list to reflect that the THING's room and identity have changed
    // You should probably also reset the old identity’s room.
    io.to(lobbyId).emit('updatePlayerList', playerData[lobbyId].players);
     
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
  const playerInfos = lobbies[lobbyId].players.map(id => ({ id, name: playerData[id]?.displayName || "Unknown" }));
  io.to(lobbyId).emit('playerListUpdated', names);
  io.to(lobbyId).emit('updatePlayerList', playerInfos);
}

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
