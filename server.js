const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {}; // { LOBBY_ID: { players: [], host: socket.id } }

app.use(express.static('public'));

io.on('connection', (socket) => {
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
