const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const players = {}; // playerName => { socketId, inGame, opponentName, secret, currentTurn, disconnected, timer }
const chatHistory = []; // Stores last 20 messages

function appendToChatHistory(name, message) {
  chatHistory.push({ name, message });
  if (chatHistory.length > 20) chatHistory.shift();
}

function broadcastChat(message) {
  appendToChatHistory('System', message);
  io.emit('chatMessage', { name: 'System', message });
}

function getLobbySnapshot() {
  return Object.entries(players).map(([name, data]) => ({
    name,
    inGame: data.inGame
  }));
}

function resetGame(name1, name2) {
  if (players[name1]) {
    if (players[name1].timer) clearTimeout(players[name1].timer);
    players[name1].inGame = false;
    players[name1].opponentName = null;
    players[name1].secret = null;
    players[name1].currentTurn = false;
    players[name1].disconnected = false;
    players[name1].timer = null;
  }
  if (players[name2]) {
    if (players[name2].timer) clearTimeout(players[name2].timer);
    players[name2].inGame = false;
    players[name2].opponentName = null;
    players[name2].secret = null;
    players[name2].currentTurn = false;
    players[name2].disconnected = false;
    players[name2].timer = null;
  }
}

function getBullsAndCows(guess, secret) {
  let bulls = 0;
  let cows = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) {
      bulls++;
    } else if (secret.includes(guess[i])) {
      cows++;
    }
  }
  return { bulls, cows };
}

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('registerName', (name) => {
    console.log(`Received registerName on socket: ${socket.id} Name: ${name}`);

    const existing = players[name];
    if (existing) {
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit('forceDisconnect');
      }
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = null;
      }
      existing.socketId = socket.id;
      existing.disconnected = false;
    } else {
      players[name] = {
        socketId: socket.id,
        inGame: false,
        opponentName: null,
        secret: null,
        currentTurn: false,
        disconnected: false,
        timer: null
      };
    }

    socket.data.playerName = name;
    io.to(socket.id).emit('nameRegistered');
    io.to(socket.id).emit('chatHistory', chatHistory);
    io.emit('updateLobby', getLobbySnapshot());
    broadcastChat(`${name} has joined the lobby.`);
  });

  socket.on('challengePlayer', (targetName) => {
    const challengerName = socket.data.playerName;
    const challenger = players[challengerName];
    const target = players[targetName];

    if (!challenger || !target || challenger.inGame || target.inGame) {
      console.log('Challenge failed: invalid challenger or target');
      return;
    }

    io.to(target.socketId).emit('challengeReceived', challengerName);
    broadcastChat(`${challengerName} challenged ${targetName}`);
    console.log(`Challenge sent from ${challengerName} to ${targetName}`);
  });

  socket.on('acceptChallenge', (challengerName) => {
    const opponentName = socket.data.playerName;
    const challenger = players[challengerName];
    const opponent = players[opponentName];

    if (!challenger || !opponent) return;

    challenger.inGame = true;
    opponent.inGame = true;
    challenger.opponentName = opponentName;
    opponent.opponentName = challengerName;

    io.to(challenger.socketId).emit('redirectToMatch');
    io.to(opponent.socketId).emit('redirectToMatch');

    io.emit('updateLobby', getLobbySnapshot());
    broadcastChat(`${challengerName} and ${opponentName} have started a match.`);
  });

  socket.on('lockSecret', (secret) => {
    const name = socket.data.playerName;
    const player = players[name];
    if (!player) return;

    const opponentName = player.opponentName;
    const opponent = players[opponentName];

    if (!opponentName || !opponent) {
      if (player.socketId) {
        io.to(player.socketId).emit('gameCanceled');
      }
      resetGame(name, opponentName);
      console.log(`Game canceled for ${name}: opponent not found`);
      return;
    }

    player.secret = secret;
    console.log(`Player ${name} locked secret: ${secret}`);

    if (opponent.secret) {
      const firstTurn = Math.random() < 0.5 ? name : opponentName;
      players[firstTurn].currentTurn = true;
      if (players[firstTurn].socketId) {
        io.to(players[firstTurn].socketId).emit('startGame', true);
      }
      const other = firstTurn === name ? opponentName : name;
      if (players[other].socketId) {
        io.to(players[other].socketId).emit('startGame', false);
      }
    } else if (!opponent.disconnected && opponent.socketId) {
      io.to(opponent.socketId).emit('opponentLocked');
    }
  });

  socket.on('submitGuess', (guess) => {
    const name = socket.data.playerName;
    const player = players[name];
    if (!player || !player.currentTurn) return;

    const opponent = players[player.opponentName];
    if (!opponent || !opponent.secret) return;

    const { bulls, cows } = getBullsAndCows(guess, opponent.secret);
    io.to(player.socketId).emit('guessResult', { guess, bulls, cows });
    io.to(opponent.socketId).emit('opponentGuess', { guess, bulls, cows });

    if (bulls === 4) {
      broadcastChat(`${name} guessed ${guess} and won against ${player.opponentName}`);
      io.to(player.socketId).emit('gameOver', 'win');
      io.to(opponent.socketId).emit('gameOver', 'lose');
      resetGame(name, player.opponentName);
      io.emit('updateLobby', getLobbySnapshot());
    } else {
      player.currentTurn = false;
      opponent.currentTurn = true;
      io.to(opponent.socketId).emit('startGame', true);
    }
  });

  socket.on('timerExpired', () => {
    const name = socket.data.playerName;
    const player = players[name];
    if (!player || !player.currentTurn) return;

    const opponentName = player.opponentName;
    const opponent = players[opponentName];

    broadcastChat(`${name} timed out. ${opponentName} wins by forfeit.`);
    io.to(player.socketId).emit('gameOver', 'forfeit_lose');
    io.to(opponent.socketId).emit('gameOver', 'forfeit_win');

    resetGame(name, opponentName);
    io.emit('updateLobby', getLobbySnapshot());
    console.log(`Player ${name} forfeited due to timeout vs ${opponentName}`);
  });

  socket.on('disconnect', () => {
    const name = socket.data.playerName;
    console.log(`User disconnected: ${socket.id}`);
    if (!name) return;

    const player = players[name];
    if (!player) return;

    if (player.inGame) {
      player.disconnected = true;
      player.socketId = null;
      player.timer = setTimeout(() => {
        if (players[name] && players[name].disconnected) {
          const opponentName = player.opponentName;
          const opponent = players[opponentName];
          if (opponent && opponent.socketId) {
            io.to(opponent.socketId).emit('gameOver', 'opponent_disconnected');
            broadcastChat(`${name} disconnected. ${opponentName} wins by default.`);
          }
          resetGame(name, opponentName);
          delete players[name];
          io.emit('updateLobby', getLobbySnapshot());
          broadcastChat(`${name} has left the lobby.`);
        }
      }, 185000);
    } else {
      delete players[name];
      io.emit('updateLobby', getLobbySnapshot());
      broadcastChat(`${name} has left the lobby.`);
    }
  });

  socket.on('chatMessage', ({ name, message }) => {
    appendToChatHistory(name, message);
    io.emit('chatMessage', { name, message });
  });
});

server.listen(10000, () => {
  console.log('Server running on port 10000');
});

