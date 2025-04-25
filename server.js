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

  const availableOptionalRoles = optionalRoles.sort(() => Math.random() - 0.5);
  const numberOfOptionalRoles = Math.min(availableOptionalRoles.length, internIds.length);

  const assigned = new Set();
  for (let i = 0; i < numberOfOptionalRoles; i++) {
    const internId = internIds[i];
    if (roles[internId] === "Intern") {
      roles[internId] = availableOptionalRoles[i];
      assigned.add(availableOptionalRoles[i]);
    }
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
    } else {
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

  socket.on('callEmergencyMeeting', () => {
    const data = playerData[socket.id];
    if (!data || data.hasCalledMeeting || emergencyMeeting[data.lobbyId]) return;

    data.hasCalledMeeting = true;
    emergencyMeeting[data.lobbyId] = socket.id;

    io.to(data.lobbyId).emit('emergencyMeetingStarted', {
      calledBy: socket.id
    });
  });

  socket.on('startGame', (lobbyId) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const players = lobby.players;
    const assignedRoles = assignRoles(players);

    players.forEach((playerId, index) => {
      if (playerData[playerId]) {
        playerData[playerId].role = assignedRoles[playerId];
      }

      io.to(playerId).emit('gameStarted', {
        playerNumber: index + 1,
        totalPlayers: players.length,
        role: assignedRoles[playerId]
      });
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
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
