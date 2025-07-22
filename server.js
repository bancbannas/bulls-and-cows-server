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

const players = {}; // socket.id -> player data
const playersByName = {}; // name -> player data (for rejoin)

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
  console.log('User connected: ' + socket.id);

  socket.on('registerName', (name) => {
    const existingPlayer = playersByName[name];
    if (existingPlayer) {
      if (existingPlayer.disconnected) {
        // Rejoin: Update socket.id and restore state
        delete players[existingPlayer.socketId]; // Remove old socket entry
        existingPlayer.socketId = socket.id;
        existingPlayer.disconnected = false;
        players[socket.id] = existingPlayer;
        console.log('Player ' + name + ' rejoined with socket: ' + socket.id);
        if (existingPlayer.inGame) {
          // Resynchronize game state
          socket.emit('rejoinGame', {
            opponentId: existingPlayer.opponentId,
            turn: existingPlayer.turn,
            lockedIn: existingPlayer.lockedIn
          });
        }
        updateLobby();
        return;
      } else {
        console.log('Name taken: ' + name);
        socket.emit('nameTaken');
        return;
      }
    }
    // New player
    const player = {
      name: name,
      socketId: socket.id,
      inGame: false,
      opponentId: null,
      secret: '',
      guesses: [],
      lastTurnTime: null,
      turn: false,
      lockedIn: false,
      disconnected: false
    };
    players[socket.id] = player;
    playersByName[name] = player;
    console.log('Player registered: ' + name + ', ID: ' + socket.id);
    updateLobby();
  });

  socket.on('challengePlayer', (targetId) => {
    const challenger = players[socket.id];
    const target = players[targetId];
    if (challenger && target && !challenger.inGame && !target.inGame) {
      target.pendingChallenge = socket.id;
      console.log('Challenge sent from ' + challenger.name + ' to ' + target.name);
      io.to(targetId).emit('incomingChallenge', challenger.name);
    } else {
      console.log('Challenge failed: challenger=' + socket.id + ', target=' + targetId);
    }
  });

  socket.on('acceptChallenge', () => {
    const challenged = players[socket.id];
    const challengerId = challenged ? challenged.pendingChallenge : null;
    const challenger = challengerId ? players[challengerId] : null;
    if (challenger && challenged) {
      challenger.inGame = challenged.inGame = true;
      challenger.opponentId = socket.id;
      challenged.opponentId = challengerId;
      challenger.turn = false;
      challenged.turn = true;
      challenger.lastTurnTime = challenged.lastTurnTime = Date.now();
      console.log('Challenge accepted: ' + challenger.name + ' vs ' + challenged.name);
      console.log('Set opponent IDs: ' + challenger.name + ' -> ' + socket.id + ', ' + challenged.name + ' -> ' + challengerId);
      io.to(challengerId).emit('challengeAccepted');
      io.to(socket.id).emit('challengeAccepted');
      updateLobby();
    } else {
      console.log('Accept challenge failed: challenged=' + socket.id + ', challenger=' + (challengerId || 'none'));
    }
  });

  socket.on('lockSecret', (code) => {
    const p = players[socket.id];
    if (!p) {
      console.log('Lock secret failed: player ' + socket.id + ' not found');
      return;
    }
    p.secret = code;
    p.lockedIn = true;
    console.log('Player ' + p.name + ' locked secret: ' + code);
    const opponent = players[p.opponentId];
    if (!opponent) {
      console.log('Opponent ' + (p.opponentId || 'none') + ' not found for ' + p.name);
      return;
    }
    if (opponent.disconnected) {
      console.log('Opponent disconnected for ' + p.name);
      io.to(socket.id).emit('gameCanceled');
      return;
    }
    if (opponent.lockedIn) {
      console.log('Both players locked in: ' + p.name + ' and ' + opponent.name);
      io.to(socket.id).emit('startGame', p.turn);
      io.to(p.opponentId).emit('startGame', opponent.turn);
    } else {
      console.log('Waiting for opponent ' + p.opponentId + ' to lock in');
      io.to(p.opponentId).emit('opponentLocked');
      setTimeout(() => {
        if (p && opponent && p.lockedIn && opponent.lockedIn) {
          console.log('Retry: Both players locked in: ' + p.name + ' and ' + opponent.name);
          io.to(socket.id).emit('startGame', p.turn);
          io.to(p.opponentId).emit('startGame', opponent.turn);
        } else {
          console.log('Retry failed: player=' + (p ? p.name : 'none') + ', opponent=' + (opponent ? opponent.name : 'none'));
        }
      }, 1000);
    }
  });

  socket.on('submitGuess', (guess) => {
    const p = players[socket.id];
    const opponent = p ? players[p.opponentId] : null;
    if (!p || !opponent || !p.turn) {
      console.log('Submit guess failed: player=' + socket.id + ', opponent=' + (p ? p.opponentId : 'none') + ', turn=' + (p ? p.turn : 'none'));
      return;
    }
    const feedback = emojiFeedback(guess, opponent.secret);
    const correct = guess === opponent.secret;
    p.guesses.push({ guess, feedback, correct });
    p.lastTurnTime = Date.now();
    p.turn = false;
    opponent.turn = true;
    opponent.lastTurnTime = Date.now();
    console.log('Guess by ' + p.name + ': ' + guess + ', Feedback: ' + feedback);
    io.to(socket.id).emit('guessResult', { guess, feedback });
    io.to(p.opponentId).emit('opponentGuess', { guess, feedback });
    if (correct) {
      console.log('Player ' + p.name + ' won against ' + opponent.name);
      endGame(socket.id, p.opponentId, 'win');
    }
  });

  socket.on('disconnect', () => {
    const p = players[socket.id];
    if (p) {
      p.disconnected = true;
      console.log('Player ' + p.name + ' disconnected, starting grace period');
      io.to(p.opponentId).emit('opponentDisconnected');
      p.disconnectTimeout = setTimeout(() => {
        if (p.disconnected) {
          const oppId = p.opponentId;
          if (p.inGame && oppId && players[oppId]) {
            console.log('Player ' + p.name + ' disconnection timeout expired, ending game');
            endGame(oppId, socket.id, 'disconnect');
          }
          delete players[socket.id];
          delete playersByName[p.name];
          console.log('Player ' + p.name + ' removed after disconnection timeout');
          updateLobby();
        }
      }, 30000); // 30-second grace period
    } else {
      console.log('Disconnect: player ' + socket.id + ' not found');
    }
  });
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log('Server started on port ' + port);
});
