const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*'
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

let players = {}; // socket.id => { name, inGame, opponent, secret, guesses }
let nameToSocketId = {}; // name => socket.id

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('registerName', (name) => {
    console.log('Received registerName on socket:', socket.id, 'Name:', name);

    // Prevent duplicate names
    if (Object.values(players).some(p => p.name === name)) {
      socket.emit('nameTaken');
      return;
    }

    players[socket.id] = {
      name,
      inGame: false,
      opponent: null,
      secret: null,
      guesses: []
    };
    nameToSocketId[name] = socket.id;

    console.log(`Player registered: ${name}, ID: ${socket.id}`);
    socket.emit('nameRegistered');
    updateLobby();
  });

  socket.on('challengePlayer', (targetId) => {
    const challenger = players[socket.id];
    const target = players[targetId];

    if (!challenger || !target) {
      console.log('Challenge failed:\n', {
        'challenger socket': socket.id,
        'target socket': targetId,
        'challenger found': !!challenger,
        'target found': !!target,
        'challenger inGame': challenger?.inGame,
        'target inGame': target?.inGame
      });
      return;
    }

    if (challenger.inGame || target.inGame) return;

    target.opponent = socket.id;
    challenger.opponent = targetId;

    io.to(targetId).emit('incomingChallenge', challenger.name);
    console.log(`Challenge sent from ${challenger.name} to ${target.name}`);
  });

  socket.on('acceptChallenge', () => {
    const accepter = players[socket.id];
    const challengerId = accepter.opponent;
    const challenger = players[challengerId];

    if (!challenger || challenger.opponent !== socket.id) return;

    accepter.inGame = true;
    challenger.inGame = true;

    io.to(socket.id).emit('challengeAccepted');
    io.to(challengerId).emit('challengeAccepted');

    console.log(`Challenge accepted: ${challenger.name} vs ${accepter.name}`);
    updateLobby();
  });

  socket.on('lockSecret', (code) => {
    const player = players[socket.id];
    if (!player) return;
    player.secret = code;
    console.log(`Player ${player.name} locked secret: ${code}`);

    const opponentId = player.opponent;
    const opponent = players[opponentId];
    if (opponent) {
      io.to(opponentId).emit('opponentLocked');
      if (opponent.secret) {
        // Start the game: challenged player goes first
        const challengerId = opponent.opponent === socket.id ? opponentId : socket.id;
        io.to(challengerId).emit('startGame', true);
        io.to(socket.id === challengerId ? opponentId : socket.id).emit('startGame', false);
      }
    } else {
      console.log(`Opponent ${opponentId} not found for ${player.name}`);
    }
  });

  socket.on('submitGuess', (guess) => {
    const player = players[socket.id];
    if (!player || !player.opponent) return;

    const opponent = players[player.opponent];
    if (!opponent || !opponent.secret) return;

    const feedback = getFeedback(guess, opponent.secret);
    io.to(socket.id).emit('guessResult', { guess, feedback });
    io.to(player.opponent).emit('opponentGuess', { guess, feedback });

    if (feedback === '🐂🐂🐂🐂') {
      io.to(socket.id).emit('gameOver', 'win');
      io.to(player.opponent).emit('gameOver', 'lose');
      endGame(socket.id);
    }
  });

  socket.on('disconnect', () => {
    const player = players[socket.id];
    if (!player) return;

    const opponentId = player.opponent;
    const opponent = players[opponentId];

    if (opponent) {
      io.to(opponentId).emit('gameOver', 'opponentDisconnected');
      opponent.inGame = false;
      opponent.opponent = null;
      opponent.secret = null;
      opponent.guesses = [];
    }

    console.log(`Player ${player.name} disconnected, ending game`);
    delete nameToSocketId[player.name];
    delete players[socket.id];
    updateLobby();
  });

  function updateLobby() {
    const lobby = Object.entries(players).map(([id, p]) => ({
      id,
      name: p.name,
      inGame: p.inGame
    }));
    io.emit('updateLobby', lobby);
  }

  function endGame(id) {
    const player = players[id];
    const opponentId = player.opponent;
    const opponent = players[opponentId];

    if (player) {
      player.inGame = false;
      player.opponent = null;
      player.secret = null;
      player.guesses = [];
    }

    if (opponent) {
      opponent.inGame = false;
      opponent.opponent = null;
      opponent.secret = null;
      opponent.guesses = [];
    }

    updateLobby();
  }

  function getFeedback(guess, secret) {
    let bulls = 0, cows = 0;
    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) {
        bulls++;
      } else if (secret.includes(guess[i])) {
        cows++;
      }
    }
    return '🐂'.repeat(bulls) + '🐄'.repeat(cows) + '💩'.repeat(4 - bulls - cows);
  }
});
