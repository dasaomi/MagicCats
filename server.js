// server.js — одновременный ход + урон/мана/реген + раунды/победа
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map();
const ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const rnd = n => Array.from({length:n}, () => ABC[Math.floor(Math.random()*ABC.length)]).join('');

// ==== минимальный баланс ====
const COST = { fire: 3, ice: 5, shield: 2 }; // мана
const DMG  = { fire: 7, ice: 5, shield: 0 }; // урон
const MANA_REGEN = 2;                        // реген за ход
const START_HP = 30;
const START_MANA = 10;
// треугольник: слева побеждает справа → побеждённый наносит 0
const BEATS = new Set(['fire>ice','ice>shield','shield>fire']);
// таймер общего хода
const TURN_MS = 15000; // 15 сек
// матч: фиксированно 2 раунда
const MAX_ROUNDS = 3; // best-of-3

function publicState(room){
  return {
    code: room.code,
    players: [
      room.host && { role:'host', name: room.host.name, connected: !room.host.disconnected },
      room.guest && { role:'guest', name: room.guest.name, connected: !room.guest.disconnected },
    ].filter(Boolean)
  };
}

function resolveDamage(a1, a2){
  let d1 = DMG[a1] || 0;
  let d2 = DMG[a2] || 0;
  if (a1 && a1 === a2) return [0,0];
  if (BEATS.has(`${a1}>${a2}`)) d2 = 0;
  if (BEATS.has(`${a2}>${a1}`)) d1 = 0;
  return [d1, d2];
}

function countUsed(list){
  return list.reduce((acc, a) => { if(a) acc[a] = (acc[a]||0)+1; return acc; }, {fire:0, ice:0, shield:0});
}

function startTurn(room){
  const b = room.battle;
  if (!b) return;
  b.actions = { host:null, guest:null };
  b.turnNo = (b.turnNo || 0) + 1;
  b.deadlineTs = Date.now() + TURN_MS;
  if (b.turnTimer) clearTimeout(b.turnTimer);
  b.turnTimer = setTimeout(()=> endTurn(room, 'timeout'), TURN_MS);

  io.to(room.code).emit('turn_start', {
    round: b.round,
    maxRounds: b.maxRounds,
    turnNo: b.turnNo,
    deadlineTs: b.deadlineTs
  });
}

function endTurn(room, reason){
  const b = room.battle;
  if (!b) return;
  if (b.turnTimer){ clearTimeout(b.turnTimer); b.turnTimer = null; }

  const rawHost  = b.actions.host;
  const rawGuest = b.actions.guest;

  let actHost = null, actGuest = null;
  if (rawHost && COST[rawHost] <= b.mana.host)   { actHost  = rawHost;  b.mana.host  -= COST[rawHost]; }
  if (rawGuest && COST[rawGuest] <= b.mana.guest){ actGuest = rawGuest; b.mana.guest -= COST[rawGuest]; }

  // копим статистику использованных (за весь матч)
  if (actHost)  b.used.host.push(actHost);
  if (actGuest) b.used.guest.push(actGuest);

  const [dHost, dGuest] = resolveDamage(actHost, actGuest);

  b.hp.guest = Math.max(0, b.hp.guest - dHost);
  b.hp.host  = Math.max(0, b.hp.host  - dGuest);

  // реген маны обоим
  b.mana.host  = Math.min(b.manaMax,  b.mana.host  + MANA_REGEN);
  b.mana.guest = Math.min(b.manaMax,  b.mana.guest + MANA_REGEN);

  // рассылаем результат хода
  io.to(room.code).emit('turn_end', {
    reason,
    round: b.round,
    turnNo: b.turnNo,
    actionsRaw:  { host: rawHost  || null, guest: rawGuest || null },
    actionsUsed: { host: actHost  || null, guest: actGuest || null },
    damage:      { host: dHost, guest: dGuest },
    hp:          { ...b.hp },
    mana:        { ...b.mana }
  });

  // проверка смерти
  if (b.hp.host <= 0 || b.hp.guest <= 0){
    finishRound(room);
    return;
  }

  // следующий ход
  startTurn(room);
}

function finishRound(room){
  const b = room.battle;
  if (!b) return;

  let winner = 'draw';
  if (b.hp.host <= 0 && b.hp.guest > 0) winner = 'guest';
  else if (b.hp.guest <= 0 && b.hp.host > 0) winner = 'host';
  else if (b.hp.host <= 0 && b.hp.guest <= 0) winner = 'draw';

  if (winner !== 'draw') b.score[winner] += 1;
// раннее завершение: кто-то набрал 2 победы — матч окончен
if (b.score.host === 2 || b.score.guest === 2) {
  const matchWinner = b.score.host === 2 ? 'host' : 'guest';
  const usedHost = countUsed(b.used.host);
  const usedGuest = countUsed(b.used.guest);

  io.to(room.code).emit('round_over', {
    round: b.round,
    winner,
    hp: { ...b.hp },
    score: { ...b.score }
  });

  if (b.turnTimer) { clearTimeout(b.turnTimer); b.turnTimer = null; }
  io.to(room.code).emit('battle_over', {
    matchWinner,
    score: { ...b.score },
    used: { host: usedHost, guest: usedGuest }
  });
  room.battle = null;
  return;
}

  io.to(room.code).emit('round_over', {
    round: b.round,
    winner,                         // 'host' | 'guest' | 'draw'
    hp: { ...b.hp },
    score: { ...b.score }
  });

  // матч завершён?
  const isLast = (b.round >= b.maxRounds);
  if (isLast){
    const matchWinner =
      b.score.host > b.score.guest ? 'host' :
      b.score.guest > b.score.host ? 'guest' : 'draw';

    // считаем использованные умения
    const usedHost = countUsed(b.used.host);
    const usedGuest = countUsed(b.used.guest);

    io.to(room.code).emit('battle_over', {
      matchWinner,
      score: { ...b.score },
      used: {
        host: usedHost,
        guest: usedGuest
      }
    });

    // остановим и завершим матч
    if (b.turnTimer) { clearTimeout(b.turnTimer); b.turnTimer = null; }
    room.battle = null;
    return;
  }

  // готовим следующий раунд (ресет HP/мана)
  b.round += 1;
  b.hp = { host: START_HP, guest: START_HP };
  b.mana = { host: START_MANA, guest: START_MANA };
  // продолжаем копить статистику b.used.* до конца матча
  // новый ход
  startTurn(room);
}

function startCountdown(code){
  const room = rooms.get(code);
  if (!room || room.countdownRunning) return;
  if (!(room.host && !room.host.disconnected && room.guest && !room.guest.disconnected)) return;

  room.countdownRunning = true;
  let n = 3;
  io.to(code).emit('countdown', { n });
  room.countdownTimer = setInterval(() => {
    n -= 1;
    if (n > 0) {
      io.to(code).emit('countdown', { n });
    } else {
      clearInterval(room.countdownTimer);
      room.countdownTimer = null;
      room.countdownRunning = false;

      room.battle = {
        round: 1,
        maxRounds: MAX_ROUNDS,
        hpMax: START_HP,
        manaMax: START_MANA,
        hp:   { host: START_HP, guest: START_HP },
        mana: { host: START_MANA, guest: START_MANA },
        score:{ host: 0,  guest: 0  },
        actions: { host: null, guest: null },
        deadlineTs: null,
        turnTimer: null,
        turnNo: 0,
        used: { host: [], guest: [] } // статистика применённых за ВЕСЬ матч
      };
      io.to(code).emit('duel_start', { ...room.battle, turnMs: TURN_MS });
      startTurn(room);
    }
  }, 1000);
}

function cancelCountdown(code){
  const room = rooms.get(code);
  if (!room) return;
  if (room.countdownTimer) { clearInterval(room.countdownTimer); room.countdownTimer = null; }
  if (room.countdownRunning) { room.countdownRunning = false; io.to(code).emit('countdown_cancel'); }
}

io.on('connection', (socket) => {
  socket.on('create', ({name})=>{
    let code; do { code = rnd(5); } while (rooms.has(code));
    const inviteToken = rnd(6);
    const room = {
      code,
      host: { sid: socket.id, name: name || 'Host', disconnected:false },
      guest: null,
      inviteToken,
      createdAt: Date.now(),
      countdownTimer: null,
      countdownRunning: false,
      battle: null
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('created', { code, inviteToken });
    io.to(code).emit('state', publicState(room));
  });

  socket.on('joinWithToken', ({code, token, name})=>{
    const room = rooms.get(code);
    if (!room) return socket.emit('error_msg', 'Комната не найдена');
    if (room.guest) return socket.emit('error_msg', 'Комната уже занята');
    if (token !== room.inviteToken) return socket.emit('error_msg', 'Неверный или использованный токен');

    room.guest = { sid: socket.id, name: name || 'Guest', disconnected:false };
    room.inviteToken = null;
    socket.join(code);
    socket.emit('joined', { code, you: 'guest' });
    io.to(code).emit('state', publicState(room));
    startCountdown(code);
  });

  // приватность выбора: себе — действие, оппоненту — факт выбора
  socket.on('choose_action', ({ code, role, action })=>{
    const room = rooms.get(code);
    if (!room || !room.battle) return;
    const b = room.battle;

    if (role !== 'host' && role !== 'guest') return;
    if (socket.id !== (role === 'host' ? room.host?.sid : room.guest?.sid)) return;
    if (!['fire','ice','shield'].includes(action)) return;

    if (!b.actions[role]) {
      b.actions[role] = action;
      socket.emit('action_made', { by: role, action });
      socket.to(code).emit('action_made', { by: role }); // без действия
      if (b.actions.host && b.actions.guest) endTurn(room, 'both_chosen');
    }
  });

  socket.on('ping_room', ({code, text})=>{
    if (!rooms.has(code)) return;
    io.to(code).emit('event', { type:'ping', text: text || 'ping', from: socket.id.slice(0,6) });
  });

  socket.on('disconnect', ()=>{
    for (const [code, room] of rooms) {
      let changed = false;
      if (room.host && room.host.sid === socket.id) { room.host.disconnected = true; changed = true; }
      if (room.guest && room.guest.sid === socket.id) { room.guest.disconnected = true; changed = true; }
      if (changed) {
        cancelCountdown(code);
        if (room.battle && room.battle.turnTimer){ clearTimeout(room.battle.turnTimer); }
        io.to(code).emit('state', publicState(room));
        const hostGone = !room.host || room.host.disconnected;
        const guestGone = !room.guest || room.guest.disconnected;
        if (hostGone && guestGone) rooms.delete(code);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log('Server running: http://localhost:' + PORT));
