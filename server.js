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
    id,
    name: p.name,
    inGame: p.inGame
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
    if (p.inGame && p.turn && p.lastTurnTime && now - p.lastTurnTime > 45000) {
      const opponent = players[p.opponentId];
      if (opponent) {
        // End this turn and give it to opponent
        p.turn = false;
        opponent.turn = true;
        opponent.lastTurnTime = Date.now();
        io.to(opponent.opponentId).emit('opponentGuess', { guess: '⏱️ Timeout', feedback: 'Turn skipped' });
        io.to(opponentId).emit('startGame', true);
        io.to(id).emit('startGame', false);
      }
    }
  }
}
setInterval(checkTimeouts, 5000);

io.on('connection', (socket) => {
  console.log('User connected: ' + socket.id);

  socket.on('registerName', (name) => {
    console.log('Received registerName on socket:', socket.id, 'Name:', name);

    // Remove any ghost entries using this name
    for (const [id, p] of Object.entries(players)) {
      if (p.name === name && id !== socket.id) {
        delete players[id];
      }
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
      console.log('Challenge failed:\n  challenger socket:', socket.id,
        '\n  target socket:', targetId,
        '\n  challenger found:', !!challenger, 'inGame:', challenger?.inGame,
        '\n  target found:', !!target, 'inGame:', target?.inGame);
      return;
    }

    challenger.opponentId = targetId;
    target.opponentId = socket.id;
    console.log('Challenge sent from', challenger.name, 'to', target.name);
    io.to(targetId).emit('incomingChallenge', challenger.name);
  });

  socket.on('acceptChallenge', () => {
    const player = players[socket.id];
    const opponent = players[player.opponentId];
    if (!player || !opponent) return;

    player.inGame = true;
    opponent.inGame = true;
    // Opponent goes first (challenger is second to act)
    player.turn = false;
    opponent.turn = true;
    opponent.lastTurnTime = Date.now();

    console.log(`Challenge accepted: ${opponent.name} vs ${player.name}`);
    io.to(socket.id).emit('challengeAccepted');
    io.to(opponent.opponentId).emit('challengeAccepted');

    updateLobby();
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
    p.guesses.push({ guess, feedback });

    io.to(socket.id).emit('guessResult', { guess, feedback });
    io.to(opponent.opponentId).emit('opponentGuess', { guess, feedback });

    if (guess === opponent.secret) {
      console.log(`${p.name} guessed correctly!`);
      endGame(socket.id, opponent.opponentId, 'win');
    } else {
      p.turn = false;
      opponent.turn = true;
      opponent.lastTurnTime = Date.now();
      io.to(p.opponentId).emit('startGame', true);
      io.to(socket.id).emit('startGame', false);
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
