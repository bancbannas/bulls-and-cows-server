const express = require('express');
const http = require('http');
const path = require('path');
const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server, {
  cors: {
    origin: 'https://bullsandcowsgame.com',
    methods: ['GET', 'POST'],
    credentials: true
  }
});

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
    if (p.inGame && p.lastTurnTime && now - p.lastTurnTime > 45000) {
      const opponent = players[p.opponentId];
      if (opponent) {
        endGame(p.opponentId, id, 'win');
      }
    }
  }
}
setInterval(checkTimeouts, 10000);

io.on('connection', (socket) => {
  console.log('User connected: ' + socket.id);

  socket.on('registerName', (name) => {
    console.log('Received registerName on socket:', socket.id, 'Name:', name);

    const nameTaken = Object.values(players).some(p => p.name === name);
    if (nameTaken) {
      console.log('Name taken: ' + name);
      socket.emit('nameTaken');
      return;
    }

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
    console.log('Player registered: ' + name + ', ID: ' + socket.id);
    socket.emit('nameRegistered');
    updateLobby();
  });

  socket.on('challengePlayer', (targetId) => {
    const challenger = players[socket.id];
    const target = players[targetId];

    if (!challenger || !target || challenger.inGame || target.inGame) {
      console.log('Challenge failed:');
      console.log('  challenger socket:', socket.id);
      console.log('  target socket:', targetId);
      console.log('  challenger found:', !!challenger, 'inGame:', challenger?.inGame);
      console.log('  target found:', !!target, 'inGame:', target?.inGame);
      return;
    }

    challenger.inGame = true;
    target.inGame = true;
    challenger.opponentId = targetId;
    target.opponentId = socket.id;
    challenger.turn = false;
    target.turn = true;

    io.to(targetId).emit('incomingChallenge', challenger.name);
    target.pendingChallengeFrom = socket.id;

    console.log(`Challenge sent from ${challenger.name} to ${target.name}`);
  });

socket.on('acceptChallenge', () => {
  const player = players[socket.id];
  const challengerId = player?.pendingChallengeFrom;
  const challenger = players[challengerId];

  if (player && challenger) {
    // 🟢 Ensure both players are re-linked properly
    player.opponentId = challengerId;
    player.inGame = true;
    player.turn = false;
    player.lockedIn = false;

    challenger.opponentId = socket.id;
    challenger.inGame = true;
    challenger.turn = true;
    challenger.lockedIn = false;

    io.to(challengerId).emit('challengeAccepted');
    io.to(socket.id).emit('challengeAccepted');

    console.log(`Challenge accepted: ${challenger.name} vs ${player.name}`);
  }
});

  socket.on('lockSecret', (code) => {
    const p = players[socket.id];
    if (!p) {
      console.log('Lock secret failed: player ' + socket.id + ' not found');
      socket.emit('notRegistered');
      return;
    }
    p.secret = code;
    p.lockedIn = true;
    console.log('Player ' + p.name + ' locked secret: ' + code);

    const opponent = players[p.opponentId];
    if (!opponent) {
      console.log('Opponent ' + p.opponentId + ' not found for ' + p.name);
      return;
    }

    if (opponent.lockedIn) {
      console.log('Both players locked in: ' + p.name + ' and ' + opponent.name);
      io.to(socket.id).emit('startGame', p.turn);
      io.to(p.opponentId).emit('startGame', opponent.turn);
      p.lastTurnTime = opponent.lastTurnTime = Date.now();
    } else {
      console.log('Waiting for opponent ' + p.opponentId + ' to lock in');
      io.to(p.opponentId).emit('opponentLocked');
    }
  });

  socket.on('submitGuess', (guess) => {
    const p = players[socket.id];
    const opponent = players[p?.opponentId];
    if (!p || !opponent || !p.turn) return;

    const feedback = emojiFeedback(guess, opponent.secret);
    io.to(socket.id).emit('guessResult', { guess, feedback });
    io.to(p.opponentId).emit('opponentGuess', { guess, feedback });

    if (feedback === '🐂🐂🐂🐂') {
      endGame(socket.id, p.opponentId, 'win');
    } else {
      p.turn = false;
      opponent.turn = true;
      p.lastTurnTime = Date.now();
      opponent.lastTurnTime = Date.now();
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    const oppId = p?.opponentId;
    if (p?.inGame && players[oppId]) {
      console.log('Player ' + p.name + ' disconnected, ending game');
      endGame(oppId, socket.id, 'win');
    }
    delete players[socket.id];
    console.log('User disconnected: ' + socket.id);
    updateLobby();
  });
});

const port = process.env.PORT || 10000;
server.listen(port, () => {
  console.log('Server running on port ' + port);
});
