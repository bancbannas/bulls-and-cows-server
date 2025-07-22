```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fetch = require('node-fetch');
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
  }
});

const players = {};

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
      existing.inGame = false; // Reset inGame on new registration
      existing.opponentName = null;
      existing.secret = null;
      existing.currentTurn = false;
    } else {
      players[name] = {
        socketId: socket.id,
        inGame: false,
        opponentName: null,
        secret: null,
        currentTurn: false,
        disconnected: false,
        timer: null,
        wins: 0,
        losses: 0
      };
    }

    socket.data.playerName = name;

    io.to(socket.id).emit('nameRegistered');
    io.emit('updateLobby', getLobbySnapshot());
    io.emit('leaderboardUpdate', getLeaderboard());
    console.log(`Player registered: ${name}, ID: ${socket.id}`);
    broadcastChat(`${name} has joined the lobby.`);
  });

  socket.on('rejoinLobby', () => {
    const name = socket.data.playerName;
    if (players[name]) {
      players[name].socketId = socket.id;
      players[name].inGame = false;
      players[name].opponentName = null;
      players[name].secret = null;
      players[name].currentTurn = false;
      players[name].disconnected = false;
      if (players[name].timer) {
        clearTimeout(players[name].timer);
        players[name].timer = null;
      }
      console.log(`Player ${name} rejoined lobby with socket: ${socket.id}`);
      io.emit('updateLobby', getLobbySnapshot());
      io.emit('leaderboardUpdate', getLeaderboard());
      broadcastChat(`${name} has returned to the lobby.`);
    } else {
      console.log(`Rejoin failed for ${name}: not found`);
      io.to(socket.id).emit('forceDisconnect');
    }
  });

  socket.on('challengePlayer', (targetName) => {
    const challengerName = socket.data.playerName;
    const challenger = players[challengerName];
    const target = players[targetName];

    if (!challenger || !target || challenger.inGame || target.inGame || !target.socketId) {
      console.log(`Challenge failed: invalid challenger (${challengerName}) or target (${targetName}, socket: ${target?.socketId})`);
      return;
    }

    io.to(target.socketId).emit('challengeReceived', challengerName);
    console.log(`Challenge sent from ${challengerName} to ${targetName} (socket: ${target.socketId})`);
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
    io.emit('leaderboardUpdate', getLeaderboard());

    console.log(`Challenge accepted: ${challengerName} vs ${opponentName}`);
    broadcastChat(`${challengerName} and ${opponentName} are now in a game.`);
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
      players[name].wins += 1;
      players[opponentName].losses += 1;
      submitToLeaderboard(name, opponentName);
      io.to(player.socketId).emit('gameOver', 'win');
      io.to(opponent.socketId).emit('gameOver', 'lose');
      resetGame(name, player.opponentName);
      io.emit('updateLobby', getLobbySnapshot());
      io.emit('leaderboardUpdate', getLeaderboard());
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

    players[name].losses += 1;
    if (opponent) players[opponentName].wins += 1;
    submitToLeaderboard(name, opponentName);

    io.to(player.socketId).emit('gameOver', 'forfeit_lose');
    if (opponent && opponent.socketId) io.to(opponent.socketId).emit('gameOver', 'forfeit_win');

    resetGame(name, opponentName);
    io.emit('updateLobby', getLobbySnapshot());
    io.emit('leaderboardUpdate', getLeaderboard());
    console.log(`Player ${name} forfeited due to timeout vs ${opponentName}`);
  });

  socket.on('disconnect', () => {
    const name = socket.data.playerName;
    console.log(`User disconnected: ${socket.id}`);

    if (!name) return;

    const player = players[name];
    if (!player) return;

    player.disconnected = true;
    player.socketId = null;

    if (player.inGame) {
      const opponentName = player.opponentName;
      const opponent = players[opponentName];

      player.timer = setTimeout(() => {
        if (players[name] && players[name].disconnected) {
          if (opponent && opponent.disconnected) {
            // Both players disconnected: reset game and update leaderboard
            players[name].losses += 1;
            if (opponent) players[opponentName].wins += 1;
            submitToLeaderboard(name, opponentName);
            resetGame(name, opponentName);
            console.log(`Game timed out for ${name} and ${opponentName} after 3 minutes inactivity`);
            broadcastChat(`Game between ${name} and ${opponentName} timed out due to inactivity.`);
            if (!opponent) delete players[name];
          } else if (opponent && opponent.socketId) {
            // One player disconnected: opponent wins
            players[name].losses += 1;
            players[opponentName].wins += 1;
            submitToLeaderboard(name, opponentName);
            io.to(opponent.socketId).emit('gameOver', 'opponent_disconnected');
            resetGame(name, opponentName);
            console.log(`Cleanup timer fired for disconnected player: ${name}`);
            broadcastChat(`${name} has left the lobby.`);
          }
          delete players[name];
          io.emit('updateLobby', getLobbySnapshot());
          io.emit('leaderboardUpdate', getLeaderboard());
        }
      }, 180000); // 3 minutes
    } else {
      delete players[name];
      io.emit('updateLobby', getLobbySnapshot());
      io.emit('leaderboardUpdate', getLeaderboard());
      broadcastChat(`${name} has left the lobby.`);
    }
  });

  socket.on('chatMessage', ({ name, message }) => {
    broadcastChat(`${name}: ${message}`);
  });

  function broadcastChat(message) {
    io.emit('chatMessage', { name: 'System', message });
  }

  function resetGame(name1, name2) {
    if (players[name1]) {
      if (players[name1].timer) {
        clearTimeout(players[name1].timer);
        players[name1].timer = null;
      }
      players[name1].inGame = false;
      players[name1].opponentName = null;
      players[name1].secret = null;
      players[name1].currentTurn = false;
      players[name1].disconnected = false;
    }
    if (players[name2]) {
      if (players[name2].timer) {
        clearTimeout(players[name2].timer);
        players[name2].timer = null;
      }
      players[name2].inGame = false;
      players[name2].opponentName = null;
      players[name2].secret = null;
      players[name2].currentTurn = false;
      players[name2].disconnected = false;
    }
  }

  function getLobbySnapshot() {
    return Object.entries(players).map(([name, data]) => ({
      name,
      inGame: data.inGame
    }));
  }

  function getLeaderboard() {
    return Object.entries(players)
      .map(([name, data]) => {
        const totalGames = data.wins + data.losses;
        const winPercentage = totalGames > 0 ? ((data.wins / totalGames) * 100).toFixed(1) : 0;
        return { name, winPercentage, wins: data.wins, losses: data.losses, games: totalGames };
      })
      .filter(player => player.games > 0)
      .sort((a, b) => b.winPercentage - a.winPercentage || b.games - a.games)
      .slice(0, 10);
  }

  async function submitToLeaderboard(name, opponentName) {
    const player = players[name];
    const opponent = players[opponentName];
    const submissions = [];

    if (player && player.wins + player.losses > 0) {
      const totalGames = player.wins + player.losses;
      submissions.push({
        name: name.slice(0, 10),
        mode: 'versus',
        avgAttempts: 0,
        games: totalGames,
        wins: player.wins
      });
    }

    if (opponent && opponent.wins + opponent.losses > 0) {
      const totalGames = opponent.wins + opponent.losses;
      submissions.push({
        name: opponentName.slice(0, 10),
        mode: 'versus',
        avgAttempts: 0,
        games: totalGames,
        wins: opponent.wins
      });
    }

    for (const submission of submissions) {
      try {
        const response = await fetch('https://bullsandcowsgame.com/scripts/submit-leaderboard.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(submission)
        });
        const result = await response.json();
        console.log(`Leaderboard submission for ${submission.name}:`, result);
      } catch (error) {
        console.error(`Error submitting leaderboard for ${submission.name}:`, error);
      }
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
});

server.listen(10000, () => {
  console.log('Server running on port 10000');
});
