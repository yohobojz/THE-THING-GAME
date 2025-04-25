const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const lobbies = {}; // { lobbyId: { players: [], host: socket.id } }
const playerData = {}; // { socketId: { lobbyId, hasCalledMeeting, messagesThisRound, currentRoom, role } }
const emergencyMeeting = {}; // { lobbyId: socketId or null }

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

  // Set guaranteed Intern count based on total player count
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
      role: 'unknown'
    };
    emergencyMeeting[lobbyId] = null;

    socket.join(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
    io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId].players);
    io.to(lobbyId).emit('updatePlayerList', lobbies[lobbyId].players);
  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.push(socket.id);
      playerData[socket.id] = {
        lobbyId,
        hasCalledMeeting: false,
        messagesThisRound: 0,
        currentRoom: socket.id,
        role: 'unknown'
      };
      socket.join(lobbyId);
      socket.emit('lobbyJoined', { lobbyId, isHost: false });
      io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId].players);
      io.to(lobbyId).emit('updatePlayerList', lobbies[lobbyId].players);
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
        from: socket.id,
        text: msg
      });
    } 
      else {
      const recipients = Object.keys(playerData).filter(
        id => playerData[id].lobbyId === lobbyId && playerData[id].currentRoom === currentRoom
      );
      recipients.forEach(id => {
        io.to(id).emit('receiveMessage', {
          from: socket.id,
          text: msg
        });
      });
    }
  });

  socket.on('callEmergencyMeeting', () => {socket.on('consumePlayer', () => {
  console.log(`[SERVER] Consume attempt from ${socket.id}`);

  const me = playerData[socket.id];
  if (!me) {
    console.log(`[SERVER] No player data found for ${socket.id}`);
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

  const [victimId, victimData] = roomMates[0];

  // Transfer THE THING’s role
  playerData[socket.id].role = "DEAD";
  playerData[victimId].role = "THE THING";
  playerData[socket.id].currentRoom = null;

  // Notify both players
  io.to(victimId).emit("youHaveBeenConsumed");
  io.to(victimId).emit("gameStarted", {
    playerNumber: "???",
    totalPlayers: "???",
    role: "DEAD"
  });

  io.to(socket.id).emit("youAreNowTheThing");

  console.log(`[SERVER] ${socket.id} successfully consumed ${victimId}`);
});

    const data = playerData[socket.id];
    if (!data || data.hasCalledMeeting || emergencyMeeting[data.lobbyId]) return;

    data.hasCalledMeeting = true;
    emergencyMeeting[data.lobbyId] = socket.id;

    io.to(data.lobbyId).emit('emergencyMeetingStarted', {
      calledBy: socket.id
    });
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      delete playerData[socket.id];

      io.to(lobbyId).emit('playerListUpdated', lobby.players);

      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
        delete emergencyMeeting[lobbyId];
      }
    }
    console.log('A user disconnected:', socket.id);
  });

  socket.on('startGame', (lobbyId) => {
  const lobby = lobbies[lobbyId];
  if (!lobby) return;

  const assignedRoles = assignRoles(lobby.players);

  lobby.players.forEach((playerId, index) => {
    if (playerData[playerId]) {
      playerData[playerId].role = assignedRoles[playerId];
    }

    io.to(playerId).emit('gameStarted', {
      playerNumber: index + 1,
      totalPlayers: lobby.players.length,
      role: assignedRoles[playerId]
    });
  });
});

});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
