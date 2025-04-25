const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const lobbies = {}; // { lobbyId: { players: [], host: socket.id } }
const playerData = {}; // { socketId: { lobbyId, hasCalledMeeting, messagesThisRound, currentRoom } }
const emergencyMeeting = {}; // { lobbyId: socketId or null }

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
      currentRoom: socket.id
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
        currentRoom: socket.id
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
      io.to(lobbyId).emit('
