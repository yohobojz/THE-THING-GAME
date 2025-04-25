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
const roundNumber = {}; // { lobbyId: number }
const hasEndedTurn = {}; // { lobbyId: Set of players who clicked "End Turn" }

function assignRoles(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const roles = {};

  roles[shuffled[0]] = "THE THING";
  roles[shuffled[1]] = "Engineer";

  for (let i = 2; i < shuffled.length; i++) {
    roles[shuffled[i]] = "Intern";
  }

  const optionalRoles = ["Comms Expert", "Soldier", "Vlogger", "Houndmaster", "Night Owl", "Defense Expert"];
  const internIds = shuffled.slice(2);
  const playerCount = players.length;

  let guaranteedInternCount = 0;
  if (playerCount >= 8) guaranteedInternCount = 2;
  else if (playerCount >= 6) guaranteedInternCount = 1;

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
    lobbies[lobbyId] = {
      players: [socket.id],
      host: socket.id
    };
    playerData[socket.id] = {
      lobbyId,
      hasCalledMeeting: false,
      messagesThisRound: 0,
      currentRoom: socket.id,
      role: 'unknown',
      lastAction: null
    };
    emergencyMeeting[lobbyId] = null;

    socket.join(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
    const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || "Unknown");
    io.to(lobbyId).emit('playerListUpdated', names);
    io.to(lobbyId).emit('updatePlayerList', names);

  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.push(socket.id);
      playerData[socket.id] = {
        lobbyId,
        hasCalledMeeting: false,
        messagesThisRound: 0,
        currentRoom: socket.id,
        role: '',
        lastAction: null
      };
      socket.join(lobbyId);
      socket.emit('lobbyJoined', { lobbyId, isHost: false });
      const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || id.substring(0, 5));
    io.to(lobbyId).emit('playerListUpdated', names);
    io.to(lobbyId).emit('updatePlayerList', names);

    } else {
      socket.emit('lobbyError', 'Lobby does not exist.');
    }
  });

  socket.on('sendMessage', (msg) => {
    const data = playerData[socket.id];
    if (!data) return;

    const { lobbyId, currentRoom } = data;

    if (msg.length > 120) {
      socket.emit('chatError', 'Message too long!');
      return;
    }

    if (data.messagesThisRound >= 1) {
      socket.emit('chatError', 'Only 1 message per round!');
      return;
    }

    data.messagesThisRound++;

    if (emergencyMeeting[lobbyId]) {
  io.to(lobbyId).emit('receiveMessage', {
    from: playerData[socket.id]?.displayName || "Unknown",
    text: msg
  });
} else {
  const recipients = Object.keys(playerData).filter(
    id => playerData[id].lobbyId === lobbyId && playerData[id].currentRoom === currentRoom
  );
  recipients.forEach(id => {
    io.to(id).emit('receiveMessage', {
      from: playerData[socket.id]?.displayName || "Unknown",
      text: msg
    });
  });
}

  });

  socket.on('callEmergencyMeeting', () => {
    const data = playerData[socket.id];
    if (!data || data.hasCalledMeeting || emergencyMeeting[data.lobbyId]) return;

    data.hasCalledMeeting = true;
    emergencyMeeting[data.lobbyId] = socket.id;

    io.to(data.lobbyId).emit('emergencyMeetingStarted', {
      calledBy: socket.id
    });
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
    return; // Invalid action
  }

  console.log(`[SERVER] ${socket.id} chose to ${action}${target ? " " + target : ""} (waiting to end turn)`);
});

  socket.on("endTurn", () => {
  const player = playerData[socket.id];
  if (!player) return;

  const lobbyId = player.lobbyId;
  if (!hasEndedTurn[lobbyId]) hasEndedTurn[lobbyId] = new Set();

  // Validate if player even chose an action
  if (!player.intendedAction) {
    socket.emit("chatError", "You must choose hold or visit before ending your turn!");
    return;
  }

  // Lock in action officially
  if (player.intendedAction === "hold") {
    player.currentRoom = socket.id;
  } else if (player.intendedAction === "visit" && player.intendedTarget) {
    player.currentRoom = player.intendedTarget;
  }

  player.lastAction = player.intendedAction; // Set lastAction here at END TURN
  player.intendedAction = null; // Clear for next round
  player.intendedTarget = null; // Clear for next round

  hasEndedTurn[lobbyId].add(socket.id);

  const allDone = lobbies[lobbyId].players.every(id =>
    hasEndedTurn[lobbyId].has(id) || playerData[id]?.role === "DEAD"
  );

  if (allDone) {
    roundNumber[lobbyId]++;
    hasEndedTurn[lobbyId].clear();

    io.to(lobbyId).emit("newRoundStarted", {
      round: roundNumber[lobbyId]
    });

    console.log(`[ROUND DEBUG] All players ended turn. Advancing to round ${roundNumber[lobbyId]}.`);

    for (const id of lobbies[lobbyId].players) {
      if (playerData[id]) {
        playerData[id].messagesThisRound = 0;
      }
    }
  }
});


  socket.on('consumePlayer', () => {
    console.log(`[SERVER] Consume attempt from ${socket.id}`);

    const me = playerData[socket.id];
    if (!me) {
      console.log(`[SERVER] No player data found for ${socket.id}`);
      return;
    }

    const lobbyId = me.lobbyId;
    if (roundNumber[lobbyId] === 1) {
      socket.emit("consumeFailed", "You can't consume on Round 1.");
      return;
    }

    if (me.role !== "THE THING") {
      console.log(`[SERVER] ${socket.id} is not THE THING (they are ${me.role})`);
      return;
    }

    console.log(`[SERVER] ${socket.id} is in room: ${me.currentRoom}`);

    const roomMates = Object.entries(playerData).filter(([id, p]) =>
      p.lobbyId === me.lobbyId &&
      p.currentRoom === me.currentRoom &&
      id !== socket.id &&
      p.role !== "DEAD"
    );

    console.log(`[SERVER] Found ${roomMates.length} roommates:`, roomMates.map(([id]) => id));

    if (roomMates.length !== 1) {
      socket.emit("consumeFailed", "You must be alone with exactly one other player.");
      return;
    }

    const [victimId] = roomMates[0];

    playerData[socket.id].role = "DEAD";
    playerData[victimId].role = "THE THING";
    playerData[socket.id].currentRoom = null;

    io.to(victimId).emit("youHaveBeenConsumed");
    io.to(victimId).emit("gameStarted", {
      playerNumber: "???",
      totalPlayers: "???",
      role: "DEAD"
    });

    io.to(socket.id).emit("youAreNowTheThing");

    console.log(`[SERVER] ${socket.id} successfully consumed ${victimId}`);
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      delete playerData[socket.id];

     const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || "Unknown");
     io.to(lobbyId).emit('playerListUpdated', names);
     io.to(lobbyId).emit('updatePlayerList', names);

      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
        delete emergencyMeeting[lobbyId];
      }
    }
    console.log('A user disconnected:', socket.id);
  });

  socket.on('startGame', (lobbyId) => {
  const lobby = lobbies[lobbyId];
  roundNumber[lobbyId] = 1;
  hasEndedTurn[lobbyId] = new Set();
  if (!lobby) return;

  const assignedRoles = assignRoles(lobby.players);

  lobby.players.forEach((playerId, index) => {
    if (playerData[playerId]) {
      playerData[playerId].role = assignedRoles[playerId];
      playerData[playerId].displayName = "Player " + (index + 1);
    }

    io.to(playerId).emit('gameStarted', {
      playerNumber: index + 1,
      totalPlayers: lobby.players.length,
      role: assignedRoles[playerId]
    });
  });

  // 🆕 After setting names, re-emit updated player list
  const names = lobby.players.map(id => playerData[id]?.displayName || "Unknown");
  io.to(lobbyId).emit('playerListUpdated', names);
  io.to(lobbyId).emit('updatePlayerList', names);


  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
