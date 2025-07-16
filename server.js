```javascript
const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: {
    origin: '*', // Allow all origins for testing
    methods: ['GET', 'POST'],
    credentials: true
  }
});

app.use(express.static(path.join(__dirname)));

const players = {};

function emojiFeedback(guess, target) {
  let bulls = 0, cows = 0;
  const guessMap = {}, targetMap = {};
  for (let i = 0; i < 4; i++) {
    if (guess[i] === target[i]) bulls++;
    else {
      guessMap[guess[i]] = (guessMap[guess[i]] || 0) + 1;
      targetMap[target[i]] = (targetMap[target[i]] || 0) + 1;
    }
  }
  for (const d in guessMap) {
    if (targetMap[d]) cows += Math.min(guessMap[d], targetMap[d]);
  }
  return '🐂'.repeat(bulls) + '🐄'.repeat(cows) + '💩'.repeat(4 - bulls - cows);
}

function updateLobby() {
  const lobby = Object.entries(players).map(([id, p]) => ({
    id, name: p.name, inGame: p.inGame
  }));
  io.emit('updateLobby', lobby);
}

function endGame(winnerId, loserId, result) {
  const winner = players[winnerId];
  const loser = players[loserId];
  if (winner) {
    winner.inGame = false;
    winner.opponentId = null;
    winner.turn = false;
    winner.secret = '';
    winner.lockedIn = false;
    io.to(winnerId).emit('gameOver', result);
  }
  if (loser) {
    loser.inGame = false;
    loser.opponentId = null;
    loser.turn = false;
    loser.secret = '';
    loser.lockedIn = false;
    io.to(loserId).emit('gameOver', result === 'win' ? 'lose' : result);
  }
  updateLobby();
}

function checkTimeouts() {
  const now = Date.now();
  for (const [id, p] of Object.entries(players)) {
    if (p.inGame && p.lastTurnTime && now - p.lastTurnTime > 60000) {
      const opponent = players[p.opponentId];
      if (opponent) {
        endGame(opponent.opponentId, id, 'win');
      }
    }
  }
}
setInterval(checkTimeouts, 10000);

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('registerName', (name) => {
    if (Object.values(players).some(p => p.name === name)) {
      socket.emit('nameTaken');
    } else {
      players[socket.id] = {
        name,
        inGame: false,
        opponentId: null,
        secret: '',
        guesses: [],
        lastTurnTime: null,
        turn: false,
        lockedIn: false
      };
      updateLobby();
    }
  });

  socket.on('challengePlayer', (targetId) => {
    const challenger = players[socket.id];
    const target = players[targetId];
    if (challenger && target && !challenger.inGame && !target.inGame) {
      target.pendingChallenge = socket.id;
      io.to(targetId).emit('incomingChallenge', challenger.name);
    }
  });

  socket.on('acceptChallenge', () => {
    const challenged = players[socket.id];
    const challengerId = challenged?.pendingChallenge;
    const challenger = players[challengerId];
    if (challenger && challenged) {
      challenger.inGame = challenged.inGame = true;
      challenger.opponentId = socket.id;
      challenged.opponentId = challengerId;
      challenger.turn = false;
      challenged.turn = true;
      challenger.lastTurnTime = challenged.lastTurnTime = Date.now();
      io.to(challengerId).emit('challengeAccepted');
      io.to(socket.id).emit('challengeAccepted');
      updateLobby();
    }
  });

  socket.on('lockSecret', (code) => {
    const p = players[socket.id];
    if (!p) return;
    p.secret = code;
    p.lockedIn = true;
    const opponent = players[p.opponentId];
    if (opponent?.lockedIn) {
      io.to(socket.id).emit('startGame', p.turn);
      io.to(p.opponentId).emit('startGame', opponent.turn);
    } else {
      io.to(p.opponentId).emit('opponentLocked');
    }
  });

  socket.on('submitGuess', (guess) => {
    const p = players[socket.id];
    const opponent = players[p?.opponentId];
    if (!p || !opponent || !p.turn) return;
    const feedback = emojiFeedback(guess, opponent.secret);
    const correct = guess === opponent.secret;
    p.guesses.push({ guess, feedback, correct });
    p.lastTurnTime = Date.now();
    p.turn = false;
    opponent.turn = true;
    opponent.lastTurnTime = Date.now();
    io.to(socket.id).emit('guessResult', { guess, feedback });
    io.to(p.opponentId).emit('opponentGuess', { guess, feedback });
    if (correct) {
      endGame(socket.id, p.opponentId, 'win');
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    const oppId = p?.opponentId;
    if (p?.inGame && players[oppId]) {
      endGame(oppId, socket.id, 'win');
    }
    delete players[socket.id];
    updateLobby();
    console.log('User disconnected:', socket.id);
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Server started on port', port);
});
