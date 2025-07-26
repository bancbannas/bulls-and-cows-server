// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server);

let games = {}; // { room: { players: [], secrets: {}, guesses: {}, timers: {}, turn: 0, lastActivity: timestamp, reconnect: {} } }
let chatHistory = []; // Stores last 20 chat messages globally
let names = {}; // socket.id => player name

function evaluate(guess, secret) {
  let bulls = 0, cows = 0;
  const g = guess.split('');
  const s = secret.split('');
  for (let i = 0; i < 4; i++) if (g[i] === s[i]) bulls++;
  for (let i = 0; i < 4; i++) if (g[i] !== s[i] && s.includes(g[i])) cows++;
  return { bulls, cows };
}

function nextTurn(room) {
  games[room].turn = 1 - games[room].turn;
  games[room].lastActivity = Date.now();
  io.to(room).emit('updateTurn', games[room].players[games[room].turn]);
}

function checkTimeouts() {
  const now = Date.now();
  for (const room in games) {
    const game = games[room];
    if (now - game.lastActivity > 180000) {
      io.to(room).emit('gameTimeout');
      chatHistory.push({ text: `Game in ${room} ended due to inactivity.` });
      if (chatHistory.length > 20) chatHistory.shift();
      delete games[room];
    }
  }
}

setInterval(checkTimeouts, 10000);

io.on('connection', socket => {
  socket.on('registerName', name => {
    names[socket.id] = name;
    io.emit('lobbyUpdate', Object.entries(names).map(([id, name]) => ({ id, name })));
  });

  socket.on('joinRoom', room => {
    socket.join(room);
    if (!games[room]) {
      games[room] = { players: [socket.id], secrets: {}, guesses: {}, turn: 0, lastActivity: Date.now(), reconnect: {} };
    } else {
      if (!games[room].players.includes(socket.id)) {
        games[room].players.push(socket.id);
      }
    }
    socket.emit('chatHistory', chatHistory);
    if (games[room].players.length === 2) {
      games[room].players.forEach(id => io.to(id).emit('bothJoined'));
      const name1 = names[games[room].players[0]] || games[room].players[0];
      const name2 = names[games[room].players[1]] || games[room].players[1];
      chatHistory.push({ text: `${name1} challenged ${name2}` });
      if (chatHistory.length > 20) chatHistory.shift();
    }
  });

  socket.on('lockSecret', ({ room, code }) => {
    const game = games[room];
    game.secrets[socket.id] = code;
    if (Object.keys(game.secrets).length === 2) {
      io.to(room).emit('startGame');
      io.to(game.players[game.turn]).emit('yourTurn');
    }
  });

  socket.on('submitGuess', ({ room, guess }) => {
    const game = games[room];
    if (game.players[game.turn] !== socket.id) return;
    const opponent = game.players.find(p => p !== socket.id);
    const result = evaluate(guess, game.secrets[opponent]);
    io.to(socket.id).emit('guessResult', { guess, ...result });
    io.to(opponent).emit('opponentGuess', { guess, ...result });
    if (result.bulls === 4) {
      io.to(room).emit('gameOver', { winner: socket.id });
      const winnerName = names[socket.id] || socket.id;
      const loserName = names[opponent] || opponent;
      chatHistory.push({ text: `${winnerName} won against ${loserName}` });
      if (chatHistory.length > 20) chatHistory.shift();
      setTimeout(() => io.to(room).emit('redirectLobby'), 15000);
      delete games[room];
    } else {
      nextTurn(room);
    }
  });

  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (games[room]) {
        games[room].reconnect[socket.id] = Date.now();
        setTimeout(() => {
          if (games[room] && Date.now() - games[room].reconnect[socket.id] > 30000) {
            io.to(room).emit('playerLeft');
            chatHistory.push({ text: `${names[socket.id] || socket.id} left the game.` });
            if (chatHistory.length > 20) chatHistory.shift();
            delete games[room];
          }
        }, 30000);
      }
    }
    delete names[socket.id];
    io.emit('lobbyUpdate', Object.entries(names).map(([id, name]) => ({ id, name })));
  });
});

app.use(express.static('public'));
server.listen(3000, () => console.log('Server running on port 3000'));
