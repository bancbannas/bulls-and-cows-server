// server.js — Bulls & Cows Versus (Render-hosted)
// iOS-resilient reconnect + authoritative state sync
// + lobby history feed + visible lock/turn timers
// + server-driven post-game return countdown
// + duplicate-name auto-suffix + same-device reclaim + lobby cap
// + idle player sweep + server-side turn timer + heartbeat
// Last updated: 2026-08-02

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: ['https://www.bullsandcowsgame.com', 'https://bullsandcowsgame.com'] },
  pingTimeout:  70000,
  pingInterval: 25000,
});

app.get('/health', (_req, res) => res.json({ ok: true, players: Object.keys(players).length }));

// ===== Config =====
const DISCONNECT_GRACE_MS    = 30000; // 30s grace before DC = forfeit
const RETURN_TO_LOBBY_SECONDS = 10;  // countdown after game ends
const MAX_LOBBY              = parseInt(process.env.MAX_LOBBY || '200', 10);
const TURN_LIMIT_MS          = 195000; // 3m15s server-side turn limit (15s buffer over client's 3m)
const LOCK_LIMIT_MS          = 195000; // same for secret lock-in phase
const IDLE_SWEEP_MS          = 120000; // sweep lobby every 2 minutes
const IDLE_TIMEOUT_MS        = 300000; // remove lobby players idle for 5+ minutes

// ===== Data stores =====
// players[name] = {
//   name, socketId, deviceId,
//   inGame, opponentName,
//   secret, currentTurn,
//   role: 'challenger'|'challenged'|null,
//   disconnectTs: number|null,
//   disconnectTimer: Timeout|null,
//   turnTimer: Timeout|null,
//   lockTimer: Timeout|null,
//   lastSeen: number,
//   turnStartedAt: number|null,  // ms timestamp when current turn began
//   lockStartedAt: number|null,  // ms timestamp when lock-in phase began
// }
const players     = {};
const chatHistory = [];
const MAX_CHAT    = 200;

// ===== Name helpers =====
function normalizeBaseName(name) {
  const trimmed = String(name || '').trim().slice(0, 20);
  const m = trimmed.match(/^(.+?)\s*\(\d+\)\s*$/);
  return m ? m[1] : trimmed;
}
function getUniqueName(base, map) {
  const root = normalizeBaseName(base);
  if (!map[root]) return root;
  for (let i = 2; i < 1000; i++) {
    const c = `${root} (${i})`;
    if (!map[c]) return c;
  }
  return `${root} (${Date.now() % 10000})`;
}

// ===== Chat =====
function pushChat(name, message) {
  const entry = { name, message, ts: Date.now() };
  chatHistory.push(entry);
  while (chatHistory.length > MAX_CHAT) chatHistory.shift();
  io.emit('chatMessage', entry);
}

// ===== Lobby =====
function lobbySnapshot() {
  return Object.values(players).map(p => ({
    name:     p.name,
    inGame:   !!p.inGame,
    opponent: p.opponentName || null,
  }));
}
function broadcastLobby() {
  io.emit('updateLobby', lobbySnapshot());
}

// ===== Player helpers =====
function opponentOf(name) {
  const p = players[name];
  if (!p || !p.opponentName) return null;
  return players[p.opponentName] || null;
}

function clearPlayerTimers(p) {
  if (!p) return;
  if (p.disconnectTimer) { clearTimeout(p.disconnectTimer);  p.disconnectTimer = null; }
  if (p.turnTimer)       { clearTimeout(p.turnTimer);        p.turnTimer = null; }
  if (p.lockTimer)       { clearTimeout(p.lockTimer);        p.lockTimer = null; }
}

function resetPlayerState(name) {
  const p = players[name];
  if (!p) return;
  clearPlayerTimers(p);
  p.inGame         = false;
  p.opponentName   = null;
  p.secret         = null;
  p.currentTurn    = false;
  p.role           = null;
  p.turnStartedAt  = null;
  p.lockStartedAt  = null;
}

function removePlayer(name) {
  const p = players[name];
  if (p) clearPlayerTimers(p);
  delete players[name];
}

function emitState(toSocketId, whoName) {
  const me  = players[whoName];
  if (!me) return;
  const opp = opponentOf(whoName);
  io.to(toSocketId).emit('syncState', {
    inGame:         !!me.inGame,
    you:            me.name,
    opponent:       opp ? opp.name : null,
    yourTurn:       !!me.currentTurn,
    youLocked:      !!me.secret,
    opponentLocked: !!(opp && opp.secret),
    turnStartedAt:  me.turnStartedAt || null,
    lockStartedAt:  me.lockStartedAt || null,
    turnLimitMs:    180000,
  });
}

// ===== Server-side timers =====
function startLockTimer(name) {
  const me = players[name];
  if (!me) return;
  if (me.lockTimer) clearTimeout(me.lockTimer);
  me.lockTimer = setTimeout(() => {
    const still = players[name];
    if (still && still.inGame && !still.secret) {
      pushChat('SYSTEM', `${name} ran out of time to lock in`);
      endMatch(name, 'forfeit_lose');
    }
  }, LOCK_LIMIT_MS);
}

function startTurnTimer(name) {
  const me = players[name];
  if (!me) return;
  if (me.turnTimer) clearTimeout(me.turnTimer);
  me.turnTimer = setTimeout(() => {
    const still = players[name];
    if (still && still.currentTurn && still.inGame) {
      pushChat('SYSTEM', `${name} ran out of time on their turn`);
      endMatch(name, 'forfeit_lose');
    }
  }, TURN_LIMIT_MS);
}

// ===== Game logic =====
function bullsAndCows(guess, secret) {
  let bulls = 0, cows = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) bulls++;
  for (const g of guess) if (secret.includes(g)) cows++;
  cows -= bulls;
  return { bulls, cows };
}

function tryBeginTurns(name) {
  const me  = players[name];
  const opp = opponentOf(name);
  if (!me || !opp || !me.secret || !opp.secret) return;

  // Challenged player goes first
  const first  = (me.role  === 'challenged') ? me  :
                 (opp.role === 'challenged') ? opp : me;
  const second = (first.name === me.name) ? opp : me;

  first.currentTurn  = true;
  second.currentTurn = false;

  const turnNow = Date.now();
  first.turnStartedAt  = turnNow;
  second.turnStartedAt = turnNow;
  if (first.socketId)  io.to(first.socketId).emit('gameStarted',  { isMyTurn: true,  turnStartedAt: turnNow, turnLimitMs: 180000 });
  if (second.socketId) io.to(second.socketId).emit('gameStarted', { isMyTurn: false, turnStartedAt: turnNow, turnLimitMs: 180000 });

  emitState(first.socketId,  first.name);
  emitState(second.socketId, second.name);

  // Start server-side turn timer for the first player
  startTurnTimer(first.name);
}

function endMatch(name, reason) {
  const me  = players[name];
  if (!me) return;
  const opp = opponentOf(name);

  // Clear all timers for both players
  clearPlayerTimers(me);
  if (opp) clearPlayerTimers(opp);

  // Notify both sides
  const oppReason =
    reason === 'win'                   ? 'lose' :
    reason === 'lose'                  ? 'win'  :
    reason === 'forfeit_win'           ? 'forfeit' :
    reason === 'forfeit_lose'          ? 'forfeit_win' :
    'win'; // opponent_disconnected

  if (me.socketId)         io.to(me.socketId).emit('gameOver', reason);
  if (opp && opp.socketId) io.to(opp.socketId).emit('gameOver', oppReason);

  // Countdown back to lobby
  if (me.socketId)         io.to(me.socketId).emit('returnToLobbyIn', RETURN_TO_LOBBY_SECONDS);
  if (opp && opp.socketId) io.to(opp.socketId).emit('returnToLobbyIn', RETURN_TO_LOBBY_SECONDS);

  // Announce result in chat
  const isWin = ['win', 'forfeit_win', 'opponent_disconnected'].includes(reason);
  const winner = isWin ? me.name  : (opp ? opp.name : '');
  const loser  = isWin ? (opp ? opp.name : '') : me.name;
  if (winner && loser) {
    const tag = reason.includes('forfeit') ? ' (forfeit)' :
                reason === 'opponent_disconnected' ? ' (disconnect)' : '';
    pushChat('SYSTEM', `Match result: ${winner} defeated ${loser}${tag}.`);
  }

  // Reset and remove both — they return via lobby redirect
  const oppName = opp ? opp.name : null;
  resetPlayerState(name);
  if (oppName) resetPlayerState(oppName);

  // Remove from players map so they don't linger as ghosts
  removePlayer(name);
  if (oppName) removePlayer(oppName);

  broadcastLobby();
}

// ===== Idle sweep =====
// Removes lobby players (not in a game) who haven't been seen for IDLE_TIMEOUT_MS
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  let swept = 0;
  for (const [name, p] of Object.entries(players)) {
    if (!p.inGame && p.lastSeen && p.lastSeen < cutoff) {
      removePlayer(name);
      swept++;
    }
  }
  if (swept > 0) {
    console.log(`Idle sweep: removed ${swept} inactive lobby player(s)`);
    broadcastLobby();
  }
}, IDLE_SWEEP_MS);

// ===== Socket handlers =====
io.on('connection', (socket) => {

  // ---- Register / reclaim ----
  socket.on('registerName', (requestedName, deviceId) => {
    if (!requestedName || typeof requestedName !== 'string') return;
    const base = normalizeBaseName(requestedName);
    if (!base) return;

    const totalPlayers     = Object.keys(players).length;
    const existingBase     = players[base];
    const isSameDevice     = existingBase && existingBase.deviceId && deviceId &&
                             existingBase.deviceId === deviceId;

    // Lobby cap — allow same-device reclaim even at cap
    if (totalPlayers >= MAX_LOBBY && !isSameDevice && !existingBase) {
      socket.emit('lobbyFull', { max: MAX_LOBBY });
      return;
    }

    let assignedName;

    if (existingBase) {
      if (isSameDevice) {
        // Reclaim — bump old socket if different
        if (existingBase.socketId && existingBase.socketId !== socket.id) {
          io.to(existingBase.socketId).emit('forceDisconnect');
        }
        assignedName = base;
      } else {
        // Name taken by someone else — auto-suffix
        assignedName = getUniqueName(base, players);
      }
    } else {
      assignedName = base;
    }

    // Clean up previous identity for this socket
    const previousName = socket.data.playerName;
    if (previousName && previousName !== assignedName &&
        players[previousName] && players[previousName].socketId === socket.id) {
      removePlayer(previousName);
    }

    const prior = players[assignedName];
    const isNew = !prior;

    players[assignedName] = {
      ...(prior || {}),
      name:            assignedName,
      socketId:        socket.id,
      deviceId:        deviceId || prior?.deviceId || null,
      inGame:          prior?.inGame          || false,
      opponentName:    prior?.opponentName    || null,
      secret:          prior?.secret          || null,
      currentTurn:     prior?.currentTurn     || false,
      role:            prior?.role            || null,
      disconnectTs:    null,
      disconnectTimer: prior?.disconnectTimer || null,
      turnTimer:       prior?.turnTimer       || null,
      lockTimer:       prior?.lockTimer       || null,
      lastSeen:        Date.now(),
    };

    socket.data.playerName = assignedName;

    socket.emit('nameRegistered', { assignedName });

    if (assignedName !== requestedName) {
      socket.emit('chatMessage', {
        name: 'SYSTEM',
        message: `Your name is now "${assignedName}" (duplicate avoided).`,
        ts: Date.now(),
      });
    }

    socket.emit('chatHistory', chatHistory);
    broadcastLobby();

    if (isNew) pushChat('SYSTEM', `${assignedName} joined the lobby`);

    // Rejoin mid-game
    const me = players[assignedName];
    if (me && me.inGame) {
      socket.emit('redirectToMatch');
      emitState(socket.id, assignedName);
    }
  });

  // ---- Heartbeat — keeps lastSeen fresh for idle sweep ----
  socket.on('heartbeat', () => {
    const name = socket.data.playerName;
    if (name && players[name]) {
      players[name].lastSeen = Date.now();
    }
  });

  // ---- Challenge flow ----
  socket.on('challengePlayer', ({ challengerName, opponentName }) => {
    const challenger = players[challengerName];
    const opponent   = players[opponentName];
    if (!challenger || !opponent) return;
    if (challenger.inGame || opponent.inGame) return;

    pushChat('SYSTEM', `${challengerName} challenged ${opponentName}`);
    if (opponent.socketId) io.to(opponent.socketId).emit('incomingChallenge', { from: challengerName });
  });

  socket.on('declineChallenge', ({ opponentName, challengerName }) => {
    const ch = players[challengerName];
    pushChat('SYSTEM', `${opponentName} declined ${challengerName}'s challenge`);
    if (ch && ch.socketId) io.to(ch.socketId).emit('challengeDeclined', { by: opponentName });
  });

  socket.on('acceptChallenge', ({ challengerName, opponentName }) => {
    const challenger = players[challengerName];
    const opponent   = players[opponentName];
    if (!challenger || !opponent) return;
    if (challenger.inGame || opponent.inGame) return;

    challenger.inGame       = true;
    opponent.inGame         = true;
    challenger.opponentName = opponentName;
    opponent.opponentName   = challengerName;
    challenger.role         = 'challenger';
    opponent.role           = 'challenged';

    pushChat('SYSTEM', `${opponentName} accepted ${challengerName}'s challenge — match starting!`);

    if (challenger.socketId) io.to(challenger.socketId).emit('redirectToMatch');
    if (opponent.socketId)   io.to(opponent.socketId).emit('redirectToMatch');

    broadcastLobby();

    // Stamp lock-in start time and begin server timers
    const lockNow = Date.now();
    if (players[challengerName]) players[challengerName].lockStartedAt = lockNow;
    if (players[opponentName])   players[opponentName].lockStartedAt   = lockNow;
    startLockTimer(challengerName);
    startLockTimer(opponentName);
  });

  // ---- Secret lock-in ----
  socket.on('lockSecret', (secret) => {
    const name = socket.data.playerName;
    const me   = players[name];
    if (!me || !me.inGame) return;

    // Validate: 4 unique digits
    if (!/^\d{4}$/.test(secret) || new Set(secret).size !== 4) return;

    const opp = opponentOf(name);
    if (!opp) {
      // Opponent vanished before lock-in
      socket.emit('gameCanceled');
      socket.emit('returnToLobbyIn', RETURN_TO_LOBBY_SECONDS);
      resetPlayerState(name);
      removePlayer(name);
      broadcastLobby();
      return;
    }

    me.secret = secret;
    if (me.lockTimer) { clearTimeout(me.lockTimer); me.lockTimer = null; }

    pushChat('SYSTEM', `${name} locked their secret`);
    if (opp.socketId) io.to(opp.socketId).emit('opponentLocked');

    tryBeginTurns(name);
  });

  // ---- Guess submission ----
  socket.on('submitGuess', (guess) => {
    const name = socket.data.playerName;
    const me   = players[name];
    const opp  = opponentOf(name);
    if (!me || !opp || !me.currentTurn || !opp.secret) return;

    if (!/^\d{4}$/.test(guess) || new Set(guess).size !== 4) return;

    // Clear turn timer — valid guess received
    if (me.turnTimer) { clearTimeout(me.turnTimer); me.turnTimer = null; }

    const { bulls, cows } = bullsAndCows(guess, opp.secret);

    if (me.socketId)  io.to(me.socketId).emit('guessResult',    { guess, bulls, cows });
    if (opp.socketId) io.to(opp.socketId).emit('opponentGuess', { guess, bulls, cows });

    if (bulls === 4) {
      endMatch(name, 'win');
      return;
    }

    // Switch turns
    me.currentTurn  = false;
    opp.currentTurn = true;

    const now = Date.now();
    opp.turnStartedAt = now;
    me.turnStartedAt  = now;
    if (opp.socketId) io.to(opp.socketId).emit('turnChanged', { isMyTurn: true,  turnStartedAt: now, turnLimitMs: 180000 });
    if (me.socketId)  io.to(me.socketId).emit('turnChanged',  { isMyTurn: false, turnStartedAt: now, turnLimitMs: 180000 });

    emitState(me.socketId,  me.name);
    emitState(opp.socketId, opp.name);

    // Start server-side timer for opponent's turn
    startTurnTimer(opp.name);
  });

  // ---- Client timer events (kept for UX but server timer is authoritative) ----
  socket.on('timerExpired', () => {
    const name = socket.data.playerName;
    const me   = players[name];
    if (!me || !me.currentTurn || !me.inGame) return;
    pushChat('SYSTEM', `${name} ran out of time`);
    endMatch(name, 'forfeit_lose');
  });

  socket.on('lockTimerExpired', () => {
    const name = socket.data.playerName;
    const me   = players[name];
    if (!me || !me.inGame || me.secret) return;
    pushChat('SYSTEM', `${name} failed to lock in on time`);
    endMatch(name, 'forfeit_lose');
  });

  // ---- State sync ----
  socket.on('requestState', () => {
    const name = socket.data.playerName;
    if (name && players[name]) {
      players[name].lastSeen = Date.now();
      emitState(socket.id, name);
    }
  });

  // ---- Chat ----
  socket.on('chatMessage', ({ name, message }) => {
    if (!message || typeof message !== 'string') return;
    const safe = message.trim().slice(0, 300);
    if (!safe) return;
    pushChat(name || 'anon', safe);
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    const name = socket.data.playerName;
    const me   = players[name];
    if (!name || !me) return;

    me.disconnectTs = Date.now();
    pushChat('SYSTEM', `${name} disconnected`);

    if (!me.inGame) {
      // Not in a game — remove immediately
      removePlayer(name);
      broadcastLobby();
      return;
    }

    // In a game — give them grace period to reconnect
    if (me.disconnectTimer) clearTimeout(me.disconnectTimer);
    me.disconnectTimer = setTimeout(() => {
      const still = players[name];
      if (!still) return;
      const reconnected = still.socketId && still.disconnectTs === null;
      if (!reconnected) {
        // Still gone — award win to opponent, clean up both
        endMatch(name, 'opponent_disconnected');
      }
    }, DISCONNECT_GRACE_MS);
  });

});

server.listen(process.env.PORT || 10000, () => {
  console.log(`Bulls & Cows server running on port ${process.env.PORT || 10000}`);
});
