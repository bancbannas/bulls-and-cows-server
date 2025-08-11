// server.js — Bulls & Cows Versus (Render-hosted)
// iOS-resilient reconnect + authoritative state sync
// + lobby history feed + visible lock/turn timers
// + server-driven post-game return countdown
// + duplicate-name auto-suffix + same-device reclaim + optional lobby cap
// Last updated: 2025-08-11

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  // Helps iOS when the app backgrounds
  pingTimeout: 70000,
  pingInterval: 25000,
});

// ===== Config =====
const DISCONNECT_GRACE_MS = 30000;        // 30s grace before deciding a DC = loss for the DC'd player
const RETURN_TO_LOBBY_SECONDS = 10;       // server-driven countdown duration after game ends
const MAX_LOBBY = parseInt(process.env.MAX_LOBBY || '200', 10); // optional cap

// ===== Data stores =====
// players[name] = {
//   name, socketId, deviceId,
//   inGame, opponentName,
//   secret, currentTurn,
//   role: 'challenger'|'challenged'|null,
//   disconnectTs: number|null,
//   disconnectTimer: NodeJS.Timeout|null,
// }
const players = {};
const chatHistory = []; // last 200 messages
const MAX_CHAT = 200;

// ===== Helpers =====
function normalizeBaseName(name) {
  const trimmed = String(name || '').trim();
  const m = trimmed.match(/^(.+?)\s*\((\d+)\)\s*$/);
  return m ? m[1] : trimmed;
}
function getUniqueName(base, playersMap) {
  const root = normalizeBaseName(base);
  if (!playersMap[root]) return root;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${root} (${i})`;
    if (!playersMap[candidate]) return candidate;
  }
  return `${root} (${Date.now() % 10000})`;
}

function pushChat(name, message) {
  chatHistory.push({ name, message, ts: Date.now() });
  while (chatHistory.length > MAX_CHAT) chatHistory.shift();
  io.emit('chatMessage', { name, message });
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
  a.role = 'challenger';
  b.role = 'challenged';
}

function tryBeginTurns(name) {
  const me = players[name];
  const opp = opponentOf(name);
  if (!me || !opp) return;
  if (me.secret && opp.secret) {
    // Challenged goes first
    const first = me.role === 'challenged' ? me : (opp.role === 'challenged' ? opp : me);
    const second = first.name === me.name ? opp : me;
    first.currentTurn = true;
    second.currentTurn = false;

    if (first.socketId) io.to(first.socketId).emit('startGame', true);
    if (second.socketId) io.to(second.socketId).emit('startGame', false);

    emitState(first.socketId, first.name);
    emitState(second.socketId, second.name);
  }
}

function bullsAndCows(guess, secret) {
  let bulls = 0, cows = 0;
  for (let i = 0; i < 4; i++) if (guess[i] === secret[i]) bulls++;
  for (let g of guess) if (secret.includes(g)) cows++;
  cows -= bulls;
  return { bulls, cows };
}

function endMatch(name, reason) {
  // reason: 'win' | 'lose' | 'forfeit_win' | 'forfeit_lose' | 'opponent_disconnected'
  const me = players[name];
  if (!me) return;
  const opp = opponentOf(name);

  // Notify both sides of result
  if (me.socketId) io.to(me.socketId).emit('gameOver', reason);
  if (opp && opp.socketId) {
    const oppReason =
      reason === 'win' ? 'lose' :
      reason === 'lose' ? 'win' :
      reason === 'forfeit_win' ? 'forfeit_lose' :
      reason === 'forfeit_lose' ? 'forfeit_win' :
      'win'; // opponent_disconnected → opponent sees win
    io.to(opp.socketId).emit('gameOver', oppReason);
  }

  // Tell both sides when to return to lobby (visible countdown on client)
  if (me.socketId) io.to(me.socketId).emit('returnToLobbyIn', RETURN_TO_LOBBY_SECONDS);
  if (opp && opp.socketId) io.to(opp.socketId).emit('returnToLobbyIn', RETURN_TO_LOBBY_SECONDS);

  // Publish result to lobby chat
  const winner = (reason === 'win' || reason === 'forfeit_win' || reason === 'opponent_disconnected') ? me.name : (opp ? opp.name : '');
  const loser = (winner === me?.name) ? (opp?.name || '') : me?.name;
  if (winner && loser) {
    const forfeited = String(reason).includes('forfeit') ? ' (forfeit)' : '';
    pushChat('SYSTEM', `Match result: ${winner} defeated ${loser}${forfeited}.`);
  }

  // Reset states
  if (opp) resetPlayerState(opp.name);
  resetPlayerState(name);
  broadcastLobby();
}

// ===== Socket handlers =====
io.on('connection', (socket) => {

  // ---- Register Name (auto-suffix, same-device reclaim, lobby cap) ----
  socket.on('registerName', (requestedName, deviceId) => {
    if (!requestedName || typeof requestedName !== 'string') return;
    let base = normalizeBaseName(requestedName);

    const totalPlayers = Object.keys(players).length;
    const existingBase = players[base];
    const isSameDeviceReclaim = existingBase && existingBase.deviceId && deviceId && existingBase.deviceId === deviceId;

    // LOBBY CAP: allow same-device reclaim even if at cap; otherwise block new entries
    if (totalPlayers >= MAX_LOBBY && !isSameDeviceReclaim && !existingBase) {
      socket.emit('lobbyFull', { max: MAX_LOBBY });
      return;
    }

    let assignedName;

    if (existingBase) {
      if (isSameDeviceReclaim) {
        // Bump the old socket if needed, reclaim base
        if (existingBase.socketId && existingBase.socketId !== socket.id) {
          io.to(existingBase.socketId).emit('forceDisconnect');
        }
        assignedName = base;
      } else {
        // Someone else has this base → assign suffix
        assignedName = getUniqueName(base, players);
      }
    } else {
      // Base free
      assignedName = base;
    }

    // Clean possible previous identity for this socket
    const previousName = socket.data.playerName;
    if (previousName && previousName !== assignedName && players[previousName] && players[previousName].socketId === socket.id) {
      delete players[previousName];
    }

    // Upsert player
    const prior = players[assignedName];
    players[assignedName] = {
      ...(prior || {}),
      name: assignedName,
      socketId: socket.id,
      deviceId: deviceId || prior?.deviceId || null,
      inGame: prior?.inGame || false,
      opponentName: prior?.opponentName || null,
      secret: prior?.secret || null,
      currentTurn: prior?.currentTurn || false,
      role: prior?.role || null,
      disconnectTs: null,
      disconnectTimer: prior?.disconnectTimer || null,
    };

    socket.data.playerName = assignedName;

    // Tell the client their final/assigned name
    socket.emit('nameRegistered', { assignedName });

    // Optional notice if we changed their requested name
    if (assignedName !== requestedName) {
      io.to(socket.id).emit('chatMessage', { name: 'SYSTEM', message: `Your name is now “${assignedName}” (duplicate avoided).` });
    }

    // First time connect message
    if (!prior) pushChat('SYSTEM', `${assignedName} connected`);

    // Chat history / lobby snapshot
    socket.emit('chatHistory', chatHistory);
    broadcastLobby();

    // If player was mid-game (same-device reclaim), put them back
    const me = players[assignedName];
    if (me && me.inGame) {
      socket.emit('redi
