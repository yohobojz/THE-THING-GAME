const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {}; // { LOBBY_ID: { players: [], host: socket.id } }

app.use(express.static('public'));

io.on('connection', (socket) => {
// Data we'll need to manage
const playerData = {}; // { socketId: { lobbyId, hasCalledMeeting, messagesThisRound, currentRoom, role } }
let emergencyMeeting = {}; // { lobbyId: socketId or null }

// New events
socket.on('registerPlayer', ({ lobbyId }) => {
  playerData[socket.id] = {
    lobbyId,
    hasCalledMeeting: false,
    messagesThisRound: 0,
    currentRoom: socket.id, // default: in their own room
    role: 'unknown'
  };
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

  // During emergency meeting, send to all
  if (emergencyMeeting[lobbyId]) {
    io.to(lobbyId).emit('receiveMessage', {
      from: socket.id,
      text: msg
    });
  } else {
    // Normal: only players in the same room
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

  console.log('A user connected:', socket.id);

  socket.on('createLobby', () => {
    const lobbyId = Math.random().toString(36).substr(2, 6).toUpperCase();
    lobbies[lobbyId] = {
      players: [socket.id],
      host: socket.id
    };
    socket.join(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
    io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId].players);
  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.push(socket.id);
      socket.join(lobbyId);
      socket.emit('lobbyJoined', { lobbyId, isHost: false });
      io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId].players);
    } else {
      socket.emit('lobbyError', 'Lobby does not exist.');
    }
  });

  socket.on('startGame', (lobbyId) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    const players = lobby.players;

    players.forEach((playerId, index) => {
      io.to(playerId).emit('gameStarted', {
        playerNumber: index + 1,
        totalPlayers: players.length
      });
    });
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      io.to(lobbyId).emit('playerListUpdated', lobby.players);
      // Clean up empty lobbies
      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
      }
    }
    console.log('A user disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
