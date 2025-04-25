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
const hasEndedTurn = {};
const bioscannerBuilt = {};

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
    lobbies[lobbyId] = { players: [socket.id], host: socket.id };
    playerData[socket.id] = createNewPlayer(socket.id, lobbyId);
    emergencyMeeting[lobbyId] = null;

    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyCreated', { lobbyId, isHost: true });
  });

  socket.on('joinLobby', (lobbyId) => {
    if (!lobbies[lobbyId]) return socket.emit('lobbyError', 'Lobby does not exist.');
    lobbies[lobbyId].players.push(socket.id);
    playerData[socket.id] = createNewPlayer(socket.id, lobbyId);

    socket.join(lobbyId);
    emitPlayerLists(lobbyId);
    socket.emit('lobbyJoined', { lobbyId, isHost: false });
  });

  socket.on('sendMessage', (msg) => {
    const data = playerData[socket.id];
    if (!data) return;

    if (msg.length > 120) return socket.emit('chatError', 'Message too long!');
    if (data.messagesThisRound >= 1) return socket.emit('chatError', 'Only 1 message per round!');

    data.messagesThisRound++;

    if (emergencyMeeting[data.lobbyId]) {
      io.to(data.lobbyId).emit('receiveMessage', { from: data.displayName || "Unknown", text: msg });
    } else {
      const recipients = Object.keys(playerData).filter(id =>
        playerData[id].lobbyId === data.lobbyId &&
        playerData[id].currentRoom === data.currentRoom
      );
      recipients.forEach(id => {
        io.to(id).emit('receiveMessage', { from: data.displayName || "Unknown", text: msg });
      });
    }
  });

  socket.on('callEmergencyMeeting', () => {
    const data = playerData[socket.id];
    if (!data || data.hasCalledMeeting || emergencyMeeting[data.lobbyId]) return;

    data.hasCalledMeeting = true;
    emergencyMeeting[data.lobbyId] = socket.id;
    io.to(data.lobbyId).emit('emergencyMeetingStarted', { calledBy: data.displayName || socket.id });
  });

  socket.on('roomAction', ({ action, target }) => {
    const player = playerData[socket.id];
    if (!player) return;

    if (action === "hold") {
      player.intendedAction = "hold";
      player.intendedTarget = null;
    } else if (action === "visit" && target && playerData[target]) {
      if (target === socket.id) return socket.emit("chatError", "You can't visit yourself!");
      player.intendedAction = "visit";
      player.intendedTarget = target;
    } else {
      return;
    }

    console.log(`[SERVER] ${socket.id} plans to ${action}${target ? " " + target : ""}`);
  });

  socket.on('endTurn', () => {
    const player = playerData[socket.id];
    if (!player) return;

    const lobbyId = player.lobbyId;
    if (!hasEndedTurn[lobbyId]) hasEndedTurn[lobbyId] = new Set();

    if (!player.intendedAction) return socket.emit("chatError", "You must choose hold or visit before ending your turn!");

    if (player.lastAction && player.intendedAction === player.lastAction) {
      return socket.emit("chatError", "You can't do the same move two rounds in a row!");
    }

    // Lock action officially
    player.currentRoom = (player.intendedAction === "hold") ? socket.id : player.intendedTarget;
    player.lastAction = player.intendedAction;
    player.intendedAction = null;
    player.intendedTarget = null;
    hasEndedTurn[lobbyId].add(socket.id);

    const allDone = lobbies[lobbyId].players.every(id =>
      hasEndedTurn[lobbyId].has(id) || playerData[id]?.role === "DEAD"
    );

    if (allDone) {
      roundNumber[lobbyId]++;
      hasEndedTurn[lobbyId].clear();

      io.to(lobbyId).emit("newRoundStarted", { round: roundNumber[lobbyId] });
      console.log(`[ROUND DEBUG] Round advanced to ${roundNumber[lobbyId]}`);

      lobbies[lobbyId].players.forEach(id => {
        if (playerData[id]) {
          playerData[id].messagesThisRound = 0;
          if (playerData[id].role === "Engineer") {
            playerData[id].roundsSurvived++;
            console.log(`[ENGINEER DEBUG] ${id} has survived ${playerData[id].roundsSurvived} rounds.`);

            if (playerData[id].roundsSurvived >= 3 && !playerData[id].bioscannerBuilt) {
              playerData[id].bioscannerBuilt = true;
              io.to(id).emit("bioscannerReady");
              console.log(`[ENGINEER DEBUG] ${id} built bioscanner!`);
            }
          }
        }
      });
    }
  });

  socket.on('consumePlayer', () => {
    console.log(`[SERVER] Consume attempt by ${socket.id}`);
    const me = playerData[socket.id];
    if (!me) return;

    const lobbyId = me.lobbyId;
    if (roundNumber[lobbyId] === 1) return socket.emit("consumeFailed", "You can't consume on Round 1.");
    if (me.role !== "THE THING") return console.log(`[SERVER] ${socket.id} attempted to consume but is not THE THING.`);

    const roomMates = Object.entries(playerData).filter(([id, p]) =>
      p.lobbyId === lobbyId &&
      p.currentRoom === me.currentRoom &&
      id !== socket.id &&
      p.role !== "DEAD"
    );

    if (roomMates.length !== 1) return socket.emit("consumeFailed", "You must be alone with exactly one other player.");

    const [victimId] = roomMates[0];

    playerData[socket.id].role = "DEAD";
    playerData[victimId].role = "THE THING";
    playerData[socket.id].currentRoom = null;

    io.to(victimId).emit("youHaveBeenConsumed");
    io.to(victimId).emit("gameStarted", { playerNumber: "???", totalPlayers: "???", role: "DEAD" });
    io.to(socket.id).emit("youAreNowTheThing");

    console.log(`[SERVER] ${socket.id} successfully consumed ${victimId}`);
  });

  socket.on('disconnect', () => {
    for (const lobbyId in lobbies) {
      const lobby = lobbies[lobbyId];
      lobby.players = lobby.players.filter(id => id !== socket.id);
      delete playerData[socket.id];

      if (lobby.players.length === 0) {
        delete lobbies[lobbyId];
        delete emergencyMeeting[lobbyId];
      } else {
        emitPlayerLists(lobbyId);
      }
    }
    console.log('A user disconnected:', socket.id);
  });

  socket.on('startGame', (lobbyId) => {
    const lobby = lobbies[lobbyId];
    if (!lobby) return;

    roundNumber[lobbyId] = 1;
    hasEndedTurn[lobbyId] = new Set();

    const assignedRoles = assignRoles(lobby.players);

    lobby.players.forEach((playerId, index) => {
      playerData[playerId].role = assignedRoles[playerId];
      playerData[playerId].displayName = "Player " + (index + 1);
      playerData[playerId].roundsSurvived = 0;
    });

    lobby.players.forEach((playerId, index) => {
      io.to(playerId).emit('gameStarted', {
        playerNumber: index + 1,
        totalPlayers: lobby.players.length,
        role: assignedRoles[playerId]
      });
    });

    emitPlayerLists(lobbyId);
  });
});

function createNewPlayer(id, lobbyId) {
  return {
    lobbyId,
    hasCalledMeeting: false,
    messagesThisRound: 0,
    currentRoom: id,
    role: 'unknown',
    lastAction: null,
    intendedAction: null,
    intendedTarget: null,
    roundsSurvived: 0,
    bioscannerBuilt: false,
  };
}

function emitPlayerLists(lobbyId) {
  const names = lobbies[lobbyId].players.map(id => playerData[id]?.displayName || id.substring(0, 5));
  const playerInfos = lobbies[lobbyId].players.map(id => ({
    id,
    name: playerData[id]?.displayName || "Unknown"
  }));
  io.to(lobbyId).emit('playerListUpdated', names);
  io.to(lobbyId).emit('updatePlayerList', playerInfos);
}

server.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
