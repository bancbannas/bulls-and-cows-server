// server.js — Bulls & Cows Versus (Render-hosted)
// Adds iOS-resilient reconnect + authoritative state sync
// Last updated: 2025-08-09

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Give iOS backgrounding more breathing room
  pingTimeout: 70000,
  pingInterval: 25000,
});

// Data stores
// players[name] = {
//   name, socketId, deviceId,
//   inGame, opponentName,
//   secret, currentTurn,
//   role: 'challenger'|'challenged'|null,
//   disconnectTs: number|null,
//   disconnectTimer: NodeJS.Timeout|null,
// }
const players = {};
const chatHistory = []; // keep last 50 messages

const MAX_CHAT = 50;
const DISCONNECT_GRACE_MS = 30000; // 30s grace before forfeit

function pushChat(name, message) {
  chatHistory.push({ name, message, ts: Date.now() });
  while (chatHistory.length > MAX_CHAT) chatHistory.shift();
}

function lobbySnapshot() {
  return Object.values(players).map(p => ({
    name: p.name,
    inGame: !!p.inGame,
    opponent: p.opponentName || null,
  }));
}

function broadcastLobby() {
  io.emit('updateLobby', lobbySnapshot());
}

function opponentOf(name) {
  const p = players[name];
  if (!p || !p.opponentName) return null;
  return players[p.opponentName] || null;
}

function resetPlayerState(name) {
  const p = players[name];
  if (!p) return;
  p.inGame = false;
  p.opponentName = null;
  p.secret = null;
  p.currentTurn = false;
  p.role = null;
}

function endMatch(name, reason) {
  // reason: 'win' | 'lose' | 'forfeit_win' | 'forfeit_lose' | 'opponent_disconnected'
  const me = players[name];
  if (!me) return;
  const opp = opponentOf(name);

  if (me.socketId) io.to(me.socketId).emit('gameOver', reason);

  if (opp && opp.socketId) {
    const oppReason =
      reason === 'win' ? 'lose' :
      reason === 'lose' ? 'win' :
      reason === 'forfeit_win' ? 'forfeit_lose' :
      reason === 'forfeit_lose' ? 'forfeit_win' :
      // opponent_disconnected for me => I win
      'win';
    io.to(opp.socketId).emit('gameOver', oppReason);
  }

  if (opp) { resetPlayerState(opp.name); }
  resetPlayerState(name);
  broadcastLobby();
}

function emitState(toSocketId, whoName) {
  const me = players[whoName];
  if (!me) return;
  const opp = opponentOf(whoName);
  const payload = {
    inGame: !!me.inGame,
    you: me.name,
    opponent: opp ? opp.name : null,
    yourTurn: !!me.currentTurn,
    youLocked: !!me.secret,
    opponentLocked: !!(opp && opp.secret),
  };
  io.to(toSocketId).emit('syncState', payload);
}

function startGameForPair(challengerName, opponentName) {
  const a = players[challengerName];
  const b = players[opponentName];
  if (!a || !b) return;

  // Roles
  a.role = 'challenger';
  b.role = 'challenged';

  // Wait for both lockSecret
  // First turn will be given to the challenged player by rule
}

function tryBeginTurns(name) {
  // Called after any lockSecret; if both have secrets, start turn sequence
  const me = players[name];
  const opp = opponentOf(name);
  if (!me || !opp) return;
  if (me.secret && opp.secret) {
    const first = me.role === 'challenged' ? me : (opp.role === 'challenged' ? opp : me);
    const second = first.name === me.name ? opp : me;
    first.currentTurn = true;
    second.currentTurn = false;

    if (first.socketId) io.to(first.socketId).emit('startGame', true);
    if (second.socketId) io.to(second.socketId).emit('startGame', false);

    // Sync both
    if (first.socketId) emitState(first.socketId, first.name);
    if (second.socketId) emitState(second.socketId, second.name);
  }
}

function bullsAndCows(guess, secret) {
  let bulls = 0, cows = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) bulls++;
  for (let g of guess) if (secret.includes(g)) cows++;
  cows -= bulls;
  return { bulls, cows };
}

io.on('connection', (socket) => {
  // --- Registration ---
  socket.on('registerName', (name, deviceId) => {
    if (!name || typeof name !== 'string') return;
    name = name.trim();

    // If someone with same name exists, decide if it's a legit handover
    const existing = players[name];
    if (existing) {
      // If deviceId differs, kick old socket (assume real user reclaiming name)
      if (deviceId && existing.deviceId && deviceId !== existing.deviceId) {
        if (existing.socketId) io.to(existing.socketId).emit('forceDisconnect');
      }
      // Rebind this connection to the name
      players[name] = {
        ...existing,
        name,
        socketId: socket.id,
        deviceId: deviceId || existing.deviceId || null,
        disconnectTs: null,
      };
    } else {
      players[name] = {
        name,
        socketId: socket.id,
        deviceId: deviceId || null,
        inGame: false,
        opponentName: null,
        secret: null,
        currentTurn: false,
        role: null,
        disconnectTs: null,
        disconnectTimer: null,
      };
    }

    socket.data.playerName = name;

    socket.emit('nameRegistered');
    socket.emit('chatHistory', chatHistory);
    broadcastLobby();

    // If this player was already mid-match, push them back and sync
    const me = players[name];
    if (me && me.inGame) {
      socket.emit('redirectToMatch');
      emitState(socket.id, name);
    }
  });

  // --- Lobby: challenge flow ---
  socket.on('challengePlayer', ({ challengerName, opponentName }) => {
    const challenger = players[challengerName];
    const opponent = players[opponentName];
    if (!challenger || !opponent) return;
    if (challenger.inGame || opponent.inGame) return;

    if (opponent.socketId) io.to(opponent.socketId).emit('incomingChallenge', { from: challengerName });
  });

  socket.on('declineChallenge', ({ opponentName, challengerName }) => {
    const ch = players[challengerName];
    if (ch && ch.socketId) io.to(ch.socketId).emit('challengeDeclined', { by: opponentName });
  });

  socket.on('acceptChallenge', ({ challengerName, opponentName }) => {
    const challenger = players[challengerName];
    const opponent = players[opponentName];
    if (!challenger || !opponent) return;

    challenger.inGame = true;
    opponent.inGame = true;
    challenger.opponentName = opponentName;
    opponent.opponentName = challengerName;

    startGameForPair(challengerName, opponentName);

    if (challenger.socketId) io.to(challenger.socketId).emit('redirectToMatch');
    if (opponent.socketId) io.to(opponent.socketId).emit('redirectToMatch');

    broadcastLobby();
    pushChat('SYSTEM', `${challengerName} and ${opponentName} started a match.`);
  });

  // --- Secret lock-in ---
  socket.on('lockSecret', (secret) => {
    const name = socket.data.playerName;
    const me = players[name];
    if (!me) return;

    const opp = opponentOf(name);
    if (!opp) {
      if (me.socketId) io.to(me.socketId).emit('gameCanceled');
      resetPlayerState(name);
      broadcastLobby();
      return;
    }

    // Validate secret: 4 unique digits
    if (!/^\d{4}$/.test(secret) || new Set(secret.split('')).size !== 4) return;

    me.secret = secret;
    if (opp.socketId) io.to(opp.socketId).emit('opponentLocked');

    tryBeginTurns(name);
  });

  // --- Turn submission ---
  socket.on('submitGuess', (guess) => {
    const name = socket.data.playerName;
    const me = players[name];
    const opp = opponentOf(name);
    if (!me || !opp) return;
    if (!me.currentTurn) return; // not your turn

    // Validate guess: 4 unique digits
    if (!/^\d{4}$/.test(guess) || new Set(guess.split('')).size !== 4) return;

    const { bulls, cows } = bullsAndCows(guess, opp.secret);

    if (me.socketId) io.to(me.socketId).emit('guessResult', { guess, bulls, cows });
    if (opp.socketId) io.to(opp.socketId).emit('opponentGuess', { guess, bulls, cows });

    if (bulls === 4) {
      endMatch(name, 'win');
      return;
    }

    // Toggle turns
    me.currentTurn = false;
    opp.currentTurn = true;

    if (opp.socketId) io.to(opp.socketId).emit('startGame', true);
    if (me.socketId) io.to(me.socketId).emit('startGame', false);

    // Sync both after every turn
    if (me.socketId) emitState(me.socketId, me.name);
    if (opp.socketId) emitState(opp.socketId, opp.name);
  });

  // --- Timer expiry (client tells server) ---
  socket.on('timerExpired', () => {
    const name = socket.data.playerName;
    const me = players[name];
    if (!me) return;
    const opp = opponentOf(name);
    if (!opp) return;

    // Only forfeit if it was actually your turn
    if (me.currentTurn) {
      endMatch(name, 'forfeit_lose');
    }
  });

  // --- State sync on demand ---
  socket.on('requestState', () => {
    const name = socket.data.playerName;
    if (name && players[name]) emitState(socket.id, name);
  });

  // --- Chat ---
  socket.on('chatMessage', ({ name, message }) => {
    if (!message || typeof message !== 'string') return;
    pushChat(name || 'anon', message.trim());
    io.emit('chatMessage', { name, message });
  });

  // --- Disconnect handling with grace ---
  socket.on('disconnect', () => {
    const name = socket.data.playerName;
    const me = players[name];
    if (!name || !me) return;

    // mark disconnect time
    me.disconnectTs = Date.now();

    // If in lobby only, remove immediately
    if (!me.inGame) {
      delete players[name];
      broadcastLobby();
      return;
    }

    // In a game: start grace timer; if not back, opponent wins
    if (me.disconnectTimer) clearTimeout(me.disconnectTimer);
    me.disconnectTimer = setTimeout(() => {
      // If still disconnected or not rebound, forfeit
      const still = players[name];
      if (!still) return; // already cleaned
      const reconnected = still.socketId && still.disconnectTs === null;
      if (!reconnected) {
        endMatch(name, 'opponent_disconnected'); // from their POV, they win
        // Also clean up records
        const opp = opponentOf(name);
        if (opp) resetPlayerState(opp.name);
        resetPlayerState(name);
        broadcastLobby();
      }
    }, DISCONNECT_GRACE_MS);
  });
});

server.listen(process.env.PORT || 10000, () => {
  console.log('Server running on port', process.env.PORT || 10000);
});
