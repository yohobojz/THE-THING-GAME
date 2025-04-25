// Updated SERVER.JS!
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

  const optionalRoles = ["Comms Expert", "Soldier", "Vlogger", "Houndmaster", "Night Owl", "Defense Expert"];
  const internIds = shuffled.slice(2);
  let guaranteedInternCount = 0;
  if (players.length >= 8) guaranteedInternCount = 2;
  else if (players.length >= 6) guaranteedInternCount = 1;

  const assignableCount = Math.max(0, internIds.length - guaranteedInternCount);
  const shuffledOptional = optionalRoles.sort(() => Math.random() - 0.5);

  for (let i = 0; i < assignableCount && i < shuffledOptional.length; i++) {
    roles[internIds[i]] = shuffledOptional[i];
  }

  return roles;
}

function emitPlayerLists(lobbyId) {
  const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || id.substring(0, 5));
  const playerInfos = lobbies[lobbyId].players.map(id => ({ id, name: playerData[id]?.displayName || "Unknown" }));
  io.to(lobbyId).emit('playerListUpdated', names);
  io.to(lobbyId).emit('updatePlayerList', playerInfos);
}

io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('createLobby', () => {
    const lobbyId = Math.random().toString(36).substr(2, 6).toUpperCase();
    lobbies[lobbyId] = { players: [socket.id], host: socket.id };
    playerData[socket.id] = { lobbyId, hasCalledMeeting: false, messagesThisRound: 0, currentRoom: socket.id, role: 'unknown', lastAction: null, endedTurn: false, roundsSurvived: 0, bioscannerReady: false };
    emergencyMeeting[lobbyId] = null;
    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
  });

  socket.on('joinLobby', (lobbyId) => {
    if (lobbies[lobbyId]) {
      lobbies[lobbyId].players.push(socket.id);
      playerData[socket.id] = { lobbyId, hasCalledMeeting: false, messagesThisRound: 0, currentRoom: socket.id, role: 'unknown', lastAction: null, endedTurn: false, roundsSurvived: 0, bioscannerReady: false };
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
      recipients.forEach(id => io.to(id).emit('receiveMessage', { from: playerData[socket.id]?.displayName || "Unknown", text: msg }));
    }
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

    console.log(`[SERVER] ${socket.id} plans to ${action} ${target || ''}`);
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

    if (player.intendedAction === "hold") {
      player.currentRoom = socket.id;
    } else if (player.intendedAction === "visit" && player.intendedTarget) {
      player.currentRoom = player.intendedTarget;
    }

    player.lastAction = player.intendedAction;
    player.intendedAction = null;
    player.intendedTarget = null;
    player.endedTurn = false;
  });

  socket.on('endTurn', () => {
    const player = playerData[socket.id];
    if (!player) return;

    player.endedTurn = true;

    const lobbyId = player.lobbyId;

    lobbies[lobbyId].players.forEach(id => {
      if (playerData[id]?.role === 'Engineer' && !playerData[id]?.endedTurn) {
        playerData[id].roundsSurvived++;

        if (playerData[id].roundsSurvived >= 3 && !playerData[id].bioscannerReady) {
          playerData[id].bioscannerReady = true;
          io.to(id).emit('bioscannerReady');
        }
      }
    });

    if (lobbies[lobbyId].players.every(id => playerData[id]?.endedTurn || playerData[id]?.role === "DEAD")) {
      roundNumber[lobbyId]++;
      lobbies[lobbyId].players.forEach(id => playerData[id].messagesThisRound = 0);
      lobbies[lobbyId].players.forEach(id => playerData[id].endedTurn = false);
      io.to(lobbyId).emit("newRoundStarted", { round: roundNumber[lobbyId] });
    }
  });

  socket.on('consumePlayer', () => {
    const me = playerData[socket.id];
    if (!me) return;

    const lobbyId = me.lobbyId;
    if (roundNumber[lobbyId] === 1) return socket.emit("consumeFailed", "Can't consume on Round 1.");

    if (me.role !== "THE THING") return socket.emit("consumeFailed", "You're not THE THING!");

    if (me.endedTurn) return socket.emit("consumeFailed", "You already ended your turn!");

    const roomMates = Object.entries(playerData).filter(([id, p]) => p.lobbyId === lobbyId && p.currentRoom === me.currentRoom && id !== socket.id && p.role !== "DEAD");

    if (roomMates.length !== 1) return socket.emit("consumeFailed", "You must be alone with exactly one other player.");

    const [victimId] = roomMates[0];
    playerData[socket.id].role = "DEAD";
    playerData[victimId].role = "THE THING";
    playerData[socket.id].currentRoom = null;

    io.to(victimId).emit("youHaveBeenConsumed");
    io.to(victimId).emit("gameStarted", { playerNumber: "???", totalPlayers: "???", role: "DEAD" });
    io.to(socket.id).emit("youAreNowTheThing");

    console.log(`[SERVER] ${socket.id} consumed ${victimId}`);
  });

  socket.on('scanPlayer', ({ target }) => {
    const player = playerData[socket.id];
    const targetPlayer = playerData[target];
    if (!player || !targetPlayer) return;

    if (player.role !== 'Engineer') return;
    if (!player.bioscannerReady) return socket.emit('chatError', 'Bioscanner not unlocked yet!');

    if (player.currentRoom !== targetPlayer.currentRoom) {
      socket.emit('chatError', 'You can only scan players in the same room!');
      return;
    }

    const isTheThing = targetPlayer.role === 'THE THING';

    socket.emit('scanResult', { playerName: targetPlayer.displayName, isTheThing });
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

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
