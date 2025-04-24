const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const lobbies = {};

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('createLobby', () => {
    const lobbyId = Math.random().toString(36).substr(2, 6).toUpperCase();
    lobbies[lobbyId] = [socket.id];
    socket.join(lobbyId);
    socket.emit('lobbyCreated', lobbyId);
  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].push(socket.id);
      socket.join(lobbyId);
      io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId]);
    } else {
      socket.emit('lobbyError', 'Lobby does not exist.');
    }
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      lobbies[lobbyId] = lobbies[lobbyId].filter(id => id !== socket.id);
      io.to(lobbyId).emit('playerListUpdated', lobbies[lobbyId]);
    }
    console.log('A user disconnected:', socket.id);
  });
});

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
