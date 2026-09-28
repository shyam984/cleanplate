/**
 * CLEAN PLATE - server (authoritative for dealing, turns, plays, rooms, coins, cooldowns)
 *
 * THE GAME (Bhabhi / Thulla, N = 4 or 5 players)
 *  - Standard 52-card deck (no jokers), dealt out completely and evenly: 4 players get 13 each;
 *    5 players get 10 or 11 each (52 does not split evenly by 5, so the first two dealt get 11).
 *    Hands are private - the server never sends a player's cards to anyone else.
 *  - Cards rank 2 (low) through Ace (high) within a suit. There is no trump suit.
 *  - Whoever holds the 2 of clubs leads the very first trick of the game, and must lead it with
 *    that exact card. After that, the winner of a trick (or whoever gets "thulla'd", see below)
 *    leads the next one and may lead any card they hold.
 *  - Each other player, in seat order, must follow the suit that was led if they hold any card of
 *    that suit. If they don't hold that suit, they may throw any card - but doing so immediately
 *    ends the trick: that player must pick up every card played in the trick so far (including
 *    their own), adding them all to their hand. This is a "thulla". That player leads next.
 *  - If every player in the trick follows suit, the trick ends cleanly once it comes back around
 *    to the leader: the highest card of the led suit wins, and every card in that trick is
 *    discarded from the game for good (nobody keeps them). The winner leads next. If the winner
 *    just emptied their hand with that winning card, leadership instead passes to the next player
 *    (in seat order) who still holds cards.
 *  - A player who empties their hand by legally following suit (or by leading) is done for the
 *    game and drops out of the turn order. A player who is forced to pick up a pile is never
 *    "done" that turn, since picking up always leaves them holding cards.
 *  - The order in which players empty their hand is the finishing order. Once only one player
 *    still holds cards, that player is automatically last place ("stuck with the Leftovers") and
 *    the game ends - they never have to play the game out alone.
 *  - Turn timer 25s: on timeout the server plays a reasonable card for that player automatically.
 *  - Disconnect: 60s grace to reconnect (turns are auto-played meanwhile). After that, or if a
 *    player leaves mid-game, the seat is "abandoned": the server auto-plays it from then on. The
 *    entry fee is NOT refunded after the game starts. A returning (timed-out) player can retake
 *    their seat and see their hand again exactly as it was.
 *
 * COINS: integers only. Entry fee deducted from everyone at START. Winner gets 2x entry, last gets
 * 0, the middle places split the rest equally; any indivisible remainder is kept by the game and
 * shown. Every change is a ledger transaction. (This half of the server is unchanged from the
 * studio's other table games, so the coin rules are identical across all of them.)
 */
const express = require('express'), http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

const START_COINS = 2500, CLAIM_COINS = 100, CLAIM_MS = 5 * 60 * 1000;
const ENTRIES = [120, 300, 500, 1000, 2000], TURN_MS = 25000, GRACE_MS = 60000, AVATARS = 7;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.json');

const RANKS = '23456789TJQKA', SUITS = ['C', 'D', 'H', 'S'];
const rankOf = c => RANKS.indexOf(c[0]), suitOf = c => c[1];
const FULL_DECK = SUITS.flatMap(s => RANKS.split('').map(r => r + s));

// ---------- storage (JSON file; swap for PostgreSQL/Supabase for permanent storage) ----------
let db = { players: {}, ledger: [] };
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch {}
let dirty = false;
const save = () => { dirty = true; };
setInterval(() => { if (dirty) { dirty = false; fs.writeFile(DB_FILE, JSON.stringify(db), () => {}); } }, 2000);
const id = (n = 8) => crypto.randomBytes(n).toString('hex');
const bySecret = new Map(Object.values(db.players).map(p => [p.secret, p]));

class U extends Error {}                       // user-facing error
const fail = m => { throw new U(m); };

// ---------- coin ledger: the ONLY place balances change ----------
// types: PLAYER_ENTRY, GAME_PRIZE, FREE_CLAIM, REFUND, ADMIN_ADJUSTMENT
function tx(p, type, amount, gameId) {
  if (!Number.isSafeInteger(amount)) throw new Error('Non-integer amount');
  const before = p.coins;
  if (before + amount < 0) fail('Not enough coins.');
  p.coins = before + amount;
  db.ledger.push({ id: id(6), playerId: p.id, amount, type, gameId: gameId || null, ts: Date.now(), before, after: p.coins });
  save();
}
function payoutPlan(n, E) {
  if (![4, 5].includes(n) || !Number.isSafeInteger(E) || E <= 0) fail('Invalid room setup.');
  const pool = n * E, win = 2 * E, mid = n - 2, rest = pool - win;
  if (rest < 0) fail('Payout error: the prize pool cannot cover the winner prize.');
  const each = Math.floor(rest / mid), remainder = rest - each * mid;
  const prizes = [win, ...Array(mid).fill(each), 0];
  if (prizes.reduce((a, b) => a + b, 0) + remainder !== pool) fail('Payout error: the pool does not balance.');
  return { pool, prizes, remainder };
}

// ---------- state ----------
const rooms = new Map(), socketsByPid = new Map();
const meOf = p => ({ id: p.id, name: p.name, avatar: p.avatar, coins: p.coins, claimIn: Math.max(0, (p.lastClaim || 0) + CLAIM_MS - Date.now()) });
const pushMe = p => { const s = socketsByPid.get(p.id); if (s) s.emit('me', meOf(p)); };
const activeRoom = p => { const r = p.roomCode && rooms.get(p.roomCode); return r && (r.status === 'WAITING' || r.status === 'PLAYING') ? r : null; };
const newCode = () => { for (;;) { const c = String(crypto.randomInt(100000, 1000000)); if (!rooms.has(c)) return c; } };
const nm = (r, s) => db.players[r.seats[s].pid].name;
const ord = n => ['', '1st', '2nd', '3rd', '4th', '5th'][n];

// ---------- per-viewer state: hands are private, everything else is public ----------
function pubFor(r, viewerPid) {
  let plan = null, planError = null;
  try { plan = payoutPlan(r.max, r.entry); } catch (e) { planError = e.message; }
  const g = r.g, mySeat = g ? r.seats.findIndex(s => s.pid === viewerPid) : -1;
  return {
    code: r.code, hostId: r.hostId, max: r.max, entry: r.entry, status: r.status, gameId: r.gameId, created: r.created,
    plan, planError, remainder: r.remainder || 0,
    seats: r.seats.map((s, i) => { const p = db.players[s.pid]; return { seat: i, pid: s.pid, name: p.name, avatar: p.avatar, coins: p.coins, connected: s.connected, abandoned: !!s.abandoned, cards: g ? g.hands[i].length : 0 }; }),
    g: g && {
      turn: g.order[g.turnIdx], leadSuit: g.leadSuit, pile: g.pile, hand: mySeat >= 0 ? g.hands[mySeat] : [],
      legal: mySeat >= 0 && g.order[g.turnIdx] === mySeat ? legalCards(r, mySeat) : [],
      finished: g.finished, log: g.log, left: Math.max(0, g.deadline - Date.now()), results: g.results, event: g.event
    }
  };
}
function bcast(r) { r.seats.forEach(s => { const sock = socketsByPid.get(s.pid); if (sock) sock.emit('room', pubFor(r, s.pid)); }); }

function seatPlayer(r, p) {
  r.seats.push({ pid: p.id, connected: true });
  p.roomCode = r.code;
  const s = socketsByPid.get(p.id); if (s) s.join(r.code);
  bcast(r);
}
function leave(r, p) {
  const i = r.seats.findIndex(s => s.pid === p.id), sock = socketsByPid.get(p.id);
  if (sock) { sock.leave(r.code); sock.emit('room', null); }
  if (r.status === 'WAITING' && i >= 0) {
    r.seats.splice(i, 1);                      // entry is only charged at START, so nothing to refund here
    if (!r.seats.length) { r.status = 'CANCELLED'; r.closeAt = Date.now() + 60000; }
    else if (r.hostId === p.id) r.hostId = r.seats[0].pid;
  } else if (r.status === 'PLAYING' && i >= 0) {
    r.seats[i].abandoned = true; r.seats[i].left = true;
    r.g.log = `${p.name} left. The table plays for them.`;
    if (r.g.order[r.g.turnIdx] === i) r.g.deadline = Math.min(r.g.deadline, Date.now() + 900);
  }
  p.roomCode = null;
  bcast(r);
}

// ---------- card game logic ----------
function shuffledDeck() {
  const d = FULL_DECK.slice();
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1);[d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function dealHands(n) {
  const deck = shuffledDeck(), hands = Array.from({ length: n }, () => []);
  deck.forEach((c, i) => hands[i % n].push(c));
  hands.forEach(h => h.sort((a, b) => (suitOf(a) > suitOf(b) ? 1 : suitOf(a) < suitOf(b) ? -1 : rankOf(a) - rankOf(b))));
  return hands;
}
function activeSeats(r) { return r.seats.map((_, i) => i).filter(i => r.g.hands[i].length > 0); }
function startTrick(r, leader) {
  const g = r.g, act = activeSeats(r), li = act.indexOf(leader);
  g.order = act.slice(li).concat(act.slice(0, li));   // active seats, rotated so leader plays first
  g.turnIdx = 0; g.pile = []; g.leadSuit = null;
  g.deadline = Date.now() + (r.seats[leader].abandoned ? 900 : TURN_MS);
}
function legalCards(r, seat) {
  const g = r.g, hand = g.hands[seat];
  if (g.turnIdx === 0) return g.firstTrick ? ['2C'] : hand.slice();      // leading: anything (or the forced opener)
  const suited = hand.filter(c => suitOf(c) === g.leadSuit);
  return suited.length ? suited : hand.slice();                          // must follow suit if able
}
function initGame(r) {
  const hands = dealHands(r.max), leader = hands.findIndex(h => h.includes('2C'));
  r.g = { hands, finished: [], results: null, firstTrick: true, log: '', event: null, sinceDiscard: 0 };
  startTrick(r, leader);
  r.g.log = `${nm(r, leader)} holds the 2 of clubs and must open with it.`;
}
function finishSeatIfEmpty(r, seat) {
  if (r.g.hands[seat].length === 0) r.g.finished.push(seat);
}
function nextLeaderAfterCleanTrick(r, winner) {
  if (r.g.hands[winner].length > 0) return winner;    // usual case: the winner leads next
  const act = activeSeats(r);                          // winner just emptied their hand: pass the lead on
  return act.find(i => i > winner) ?? act[0];
}
// Force-resolve whatever is currently in the pile as if the trick had completed cleanly: the
// highest card played wins, every card in the trick is discarded, and play carries on from there.
function forceDiscardPile(r) {
  const g = r.g;
  finishSeatIfEmpty(r, g.pile[g.pile.length - 1].seat);
  const winningPlay = g.pile.reduce((a, b) => (rankOf(b.card) > rankOf(a.card) ? b : a));
  g.event = { type: 'trick', seat: winningPlay.seat, count: g.pile.length };
  g.log = `The table clears - too many cards had been going back and forth.`;
  g.sinceDiscard = 0;
  if (activeSeats(r).length <= 1) return endGame(r);
  startTrick(r, nextLeaderAfterCleanTrick(r, winningPlay.seat));
}
function doPlay(r, seat, card) {
  const g = r.g, hand = g.hands[seat], name = nm(r, seat);
  g.event = null;                          // clear the previous play's event; this play may set its own below
  const idx = hand.indexOf(card);
  if (idx < 0) fail('You do not hold that card.');
  if (!legalCards(r, seat).includes(card)) fail(g.turnIdx === 0 && g.firstTrick ? 'You must open with the 2 of clubs.' : 'You must follow suit if you can.');
  const leading = g.turnIdx === 0;
  const hadSuit = !leading && hand.some(c => suitOf(c) === g.leadSuit);
  hand.splice(idx, 1);
  g.pile.push({ seat, card });
  if (leading) g.leadSuit = suitOf(card);
  g.firstTrick = false;
  g.sinceDiscard++;
  // Safety valve: real games always converge quickly, but purely random or deliberately stalling
  // play could in theory keep trading a small pile back and forth without ever completing a clean
  // trick. This server must never let a room hang forever, so after many plays with no cards
  // actually leaving the game, the current pile is forced to discard right here.
  if (g.sinceDiscard >= 400) return forceDiscardPile(r);

  if (!leading && !hadSuit) {                              // THULLA: this player takes the whole pile
    g.pile.forEach(pc => hand.push(pc.card));
    g.event = { type: 'thulla', seat, count: g.pile.length };
    g.log = `${name} couldn't follow suit and picks up ${g.pile.length} cards!`;
    if (activeSeats(r).length <= 1) return endGame(r);
    return startTrick(r, seat);
  }

  finishSeatIfEmpty(r, seat);                                // legally played (led or followed): may now be done
  if (g.turnIdx < g.order.length - 1) {
    g.log = `${name} played ${pretty(card)}.`;
    g.turnIdx++; g.deadline = Date.now() + (r.seats[g.order[g.turnIdx]].abandoned ? 900 : TURN_MS);
    return;
  }
  // trick completes cleanly: highest card of the led suit wins; every card in the trick is burned
  const winningPlay = g.pile.reduce((a, b) => (rankOf(b.card) > rankOf(a.card) ? b : a));
  const winner = winningPlay.seat;
  g.event = { type: 'trick', seat: winner, count: g.pile.length };
  g.log = `${nm(r, winner)} wins the trick with ${pretty(winningPlay.card)}.`;
  g.sinceDiscard = 0;
  if (activeSeats(r).length <= 1) return endGame(r);
  startTrick(r, nextLeaderAfterCleanTrick(r, winner));
}
function pretty(c) { return { T: '10' }[c[0]] || c[0]; }
function endGame(r) {
  const g = r.g, plan = payoutPlan(r.max, r.entry), straggler = activeSeats(r)[0];
  // Usually one player is left holding cards when everyone else has finished, and they take last
  // place automatically. Rarely, the last two players can both empty their hands in the very same
  // final trick (one leading, one following) - in that case nobody is "left holding cards", and
  // g.finished already has everyone in the right order from the moment each of them went out.
  if (straggler !== undefined) g.finished.push(straggler);
  const results = g.finished.map((seat, i) => ({ seat, pos: i + 1, name: nm(r, seat), prize: plan.prizes[i], net: plan.prizes[i] - r.entry }));
  results.forEach(x => { const p = db.players[r.seats[x.seat].pid]; if (x.prize > 0) tx(p, 'GAME_PRIZE', x.prize, r.gameId); pushMe(p); });
  g.results = results; g.event = null; g.order = []; g.pile = [];
  r.remainder = plan.remainder; r.status = 'FINISHED'; r.closeAt = Date.now() + 10 * 60000;
  const lastPlace = g.finished[g.finished.length - 1];
  g.log = `Game finished. ${nm(r, lastPlace)} is stuck with the Leftovers.`;
}
function auto(r) {
  const g = r.g, seat = g.order[g.turnIdx], legal = legalCards(r, seat);
  const pick = legal.slice().sort((a, b) => rankOf(a) - rankOf(b))[0];   // conservative: play the lowest legal card
  doPlay(r, seat, pick);
}

setInterval(() => {
  const now = Date.now();
  for (const r of [...rooms.values()]) {
    if (r.status === 'WAITING') {
      r.seats.filter(s => !s.connected && now - s.dcAt > 20000).forEach(s => leave(r, db.players[s.pid]));
    } else if (r.status === 'PLAYING') {
      let ch = false;
      r.seats.forEach((s, i) => {
        if (!s.connected && !s.abandoned && now - s.dcAt > GRACE_MS) {
          s.abandoned = true; r.g.log = `${nm(r, i)} timed out. The table plays for them.`; ch = true;
          if (r.g.order[r.g.turnIdx] === i) r.g.deadline = Math.min(r.g.deadline, now + 900);
        }
      });
      if (r.status === 'PLAYING' && now >= r.g.deadline) { auto(r); ch = true; }
      if (ch) bcast(r);
    }
    if ((r.status === 'FINISHED' || r.status === 'CANCELLED') && now > r.closeAt) {
      r.seats.forEach(s => { const p = db.players[s.pid]; if (p && p.roomCode === r.code) p.roomCode = null; });
      rooms.delete(r.code);
    }
  }
}, 500);

// ---------- sockets ----------
io.on('connection', socket => {
  const on = (ev, fn) => socket.on(ev, (d, cb) => {
    try { const r = fn(d || {}) || {}; if (typeof cb === 'function') cb({ ok: true, ...r }); }
    catch (e) { if (!(e instanceof U)) console.error(e); if (typeof cb === 'function') cb({ error: e instanceof U ? e.message : 'Something went wrong.' }); }
  });
  const P = () => db.players[socket.data.pid] || fail('Not signed in.');
  const inGame = () => {
    const p = P(), r = activeRoom(p);
    if (!r || r.status !== 'PLAYING') fail('No game in progress.');
    return { p, r, i: r.seats.findIndex(s => s.pid === p.id) };
  };

  on('hello', d => {
    let p = d.secret && bySecret.get(String(d.secret));
    if (!p) {
      const name = String(d.name || '').trim().slice(0, 14);
      if (!name) fail('Enter a name to start.');
      p = { id: id(4), secret: id(16), name, avatar: crypto.randomInt(AVATARS), coins: 0, lastClaim: 0, roomCode: null };
      db.players[p.id] = p; bySecret.set(p.secret, p);
      tx(p, 'ADMIN_ADJUSTMENT', START_COINS, null);            // starting balance
    }
    socket.data.pid = p.id; socketsByPid.set(p.id, socket);
    const r = p.roomCode && rooms.get(p.roomCode);
    const seat = r && r.seats.find(s => s.pid === p.id);
    if (seat && (r.status === 'WAITING' || r.status === 'PLAYING')) {   // reconnect: same identity, same seat, same hand
      seat.connected = true; seat.abandoned = false; socket.join(r.code); bcast(r);
    }
    return { secret: p.secret, me: meOf(p), room: r && seat ? pubFor(r, p.id) : null };
  });

  on('claim', () => {
    const p = P();
    if (p.lastClaim + CLAIM_MS - Date.now() > 0) fail('Free coins are not ready yet.');
    p.lastClaim = Date.now();                                     // server clock only
    tx(p, 'FREE_CLAIM', CLAIM_COINS, null);
    pushMe(p);
  });

  on('createRoom', d => {
    const p = P(); if (activeRoom(p)) fail('You are already in a game.');
    const max = +d.max, entry = +d.entry;
    if (![4, 5].includes(max) || !ENTRIES.includes(entry)) fail('Invalid room setup.');
    if (p.coins < entry) fail('Not enough coins.');
    const r = { code: newCode(), hostId: p.id, max, entry, status: 'WAITING', created: Date.now(), gameId: null, seats: [], g: null };
    rooms.set(r.code, r); seatPlayer(r, p);
  });

  on('joinRoom', d => {
    const p = P(), r = rooms.get(String(d.code || '').trim());
    if (!r || r.status === 'CANCELLED') fail('Room not found.');
    if (r.seats.some(s => s.pid === p.id)) return;
    if (activeRoom(p)) fail('You are already in a game.');
    if (r.status !== 'WAITING') fail('Game already started.');
    if (r.seats.length >= r.max) fail('Room is full.');
    if (p.coins < r.entry) fail(`You need ${r.entry - p.coins} more coins.`);
    seatPlayer(r, p);
  });

  on('leaveRoom', () => { const p = P(), r = p.roomCode && rooms.get(p.roomCode); if (r) leave(r, p); else { p.roomCode = null; socket.emit('room', null); } });

  on('start', () => {
    const p = P(), r = activeRoom(p);
    if (!r || r.status !== 'WAITING') fail('No room to start.');
    if (r.hostId !== p.id) fail('Only the host can start the game.');
    if (r.seats.length !== r.max) fail(`Waiting for ${r.max - r.seats.length} more player(s).`);
    if (r.seats.some(s => !s.connected)) fail('A player is disconnected.');
    payoutPlan(r.max, r.entry);                                   // throws a readable error if the payout is invalid
    const ps = r.seats.map(s => db.players[s.pid]), poor = ps.find(q => q.coins < r.entry);
    if (poor) fail(`${poor.name} does not have enough coins.`);
    r.status = 'STARTING'; r.gameId = id(6);
    ps.forEach(q => tx(q, 'PLAYER_ENTRY', -r.entry, r.gameId));
    initGame(r); r.status = 'PLAYING';
    ps.forEach(pushMe); bcast(r);
  });

  on('play', d => {
    const { r, i } = inGame(), card = String(d.card || '');
    if (r.g.order[r.g.turnIdx] !== i) fail('It is not your turn.');
    try { doPlay(r, i, card); } finally { bcast(r); }   // always tell everyone the resulting state, even if something above throws
  });

  socket.on('disconnect', () => {
    const pid = socket.data.pid; if (!pid) return;
    if (socketsByPid.get(pid) === socket) socketsByPid.delete(pid);
    const p = db.players[pid], r = p.roomCode && rooms.get(p.roomCode), s = r && r.seats.find(x => x.pid === pid);
    if (s) { s.connected = false; s.dcAt = Date.now(); bcast(r); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Clean Plate running on port ' + PORT));
