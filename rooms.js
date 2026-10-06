'use strict';
/**
 * In-memory room/session manager. Wraps gameLogic with turn state, scoring,
 * and the "only the previous turn's discard is takeable" rule.
 */
const crypto = require('crypto');
const gl = require('./gameLogic');
const h2h = require('./h2h');

const HAND_SIZE = 10;
const MATCH_TARGET = 100;
const ASSAF_PENALTY = 25;
// Game modes. 'classic': first player to reach the target loses.
// 'exact': land on the target EXACTLY to win; go over it and you lose.
const MODES = ['classic', 'exact'];
const DEFAULT_TARGETS = { classic: 100, exact: 50 };
const MIN_TARGET = 10;
const MAX_TARGET = 500;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
// A player is considered disconnected once this long has passed since their
// last authenticated request (state poll or action). Comfortably more than
// a couple of the client's poll intervals so brief network hiccups don't
// falsely flag someone as gone.
const DISCONNECT_MS = 5000;

const rooms = new Map();

function randomCode(len = 4) {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function makeRoomCode() {
  let code;
  do {
    code = randomCode(4);
  } while (rooms.has(code));
  return code;
}

function log(room, message) {
  room.log.push({ t: Date.now(), message });
  if (room.log.length > 100) room.log.shift();
}

function dealNewHand(room) {
  // Alternate who starts each new hand - including across a new match, so
  // the very first hand of a room is the only randomly-chosen one and every
  // hand after that strictly alternates.
  if (room.hand) {
    room.startingPlayerId = opponentOf(room, room.startingPlayerId).id;
  }

  // Fresh deck, fully reshuffled, every hand - no carryover state at all.
  const deck = gl.shuffle(gl.createDeck());
  const { p1Hand, p2Hand, drawPile, discardPile } = gl.dealHands(deck, HAND_SIZE);
  const [p1, p2] = room.players;
  room.hand = {
    hands: { [p1.id]: p1Hand, [p2.id]: p2Hand },
    drawPile,
    discardPile, // the currently-takeable group (starts as the flipped-up card)
    buried: [],
    pendingDiscard: [], // this turn's discard, staged until the draw completes
    turnPlayerId: room.startingPlayerId,
    turnPhase: 'await_discard',
    result: null,
    lastDraw: null, // most recent draw action this hand, for opponent visibility
  };
  room.phase = 'playing';
  log(room, `New hand dealt. ${playerById(room, room.startingPlayerId).name} goes first.`);
}

function playerById(room, id) {
  return room.players.find((p) => p.id === id);
}

function opponentOf(room, id) {
  return room.players.find((p) => p.id !== id);
}

// Names are shown to the other player, so keep them short and plain.
function cleanName(name, fallback) {
  const n = String(name == null ? '' : name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
  return n || fallback;
}

function normalizeSettings(input, current) {
  const base = current || { mode: 'classic', matchTarget: MATCH_TARGET };
  const mode = MODES.includes(input && input.mode) ? input.mode : base.mode;
  let target = Math.floor(Number(input && input.target));
  if (!Number.isFinite(target)) {
    // No (valid) target given: keep the current one, unless the mode just
    // changed - then fall back to that mode's sensible default.
    target = mode === base.mode ? base.matchTarget : DEFAULT_TARGETS[mode];
  }
  target = Math.min(MAX_TARGET, Math.max(MIN_TARGET, target));
  return { mode, matchTarget: target };
}

function createRoom(name, options) {
  const code = makeRoomCode();
  const settings = normalizeSettings(options || {}, null);
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    players: [],
    scores: {},
    startingPlayerId: null,
    // waiting (1 player) -> setup (2 players, host picks the game mode) ->
    // playing -> hand_over -> playing -> ... -> match_over -> setup -> ...
    phase: 'waiting',
    hand: null,
    log: [],
    mode: settings.mode,
    matchTarget: settings.matchTarget,
    assafPenalty: ASSAF_PENALTY,
    matchWinnerId: null,
    matchEndReason: null,
    h2h: null, // { pair, record, before } once two trackable players are in
  };
  const id = crypto.randomUUID();
  const token = randomToken();
  room.players.push({
    id,
    token,
    name: cleanName(name, 'Player 1'),
    seat: 1,
    lastSeen: Date.now(),
    h2hBackup: options && options.h2hBackup,
  });
  room.scores[id] = 0;
  rooms.set(code, room);
  log(room, `${room.players[0].name} created the room.`);
  return { room, playerId: id, token };
}

function joinRoom(code, name, options) {
  const room = rooms.get((code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  if (room.players.length >= 2) return { error: 'Room is full.' };
  const id = crypto.randomUUID();
  const token = randomToken();
  room.players.push({
    id,
    token,
    name: cleanName(name, 'Player 2'),
    seat: 2,
    lastSeen: Date.now(),
    h2hBackup: options && options.h2hBackup,
  });
  room.scores[id] = 0;
  log(room, `${room.players[1].name} joined the room.`);
  room.lastActivity = Date.now();

  if (room.players.length === 2) {
    // Both players are in: move to the setup screen, where the host picks the
    // game mode and starts the game. (The first hand isn't dealt until then.)
    room.phase = 'setup';
    startH2h(room);
  }
  return { room, playerId: id, token };
}

function authenticate(code, playerId, token) {
  const room = rooms.get((code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = room.players.find((p) => p.id === playerId && p.token === token);
  if (!player) return { error: 'Not authorized for this room.' };
  // Every authenticated call (state poll or action) is proof of life -
  // this is how we detect disconnects without a persistent connection.
  player.lastSeen = Date.now();
  return { room, player };
}

// ---------- head-to-head record ----------
function startH2h(room) {
  const [p1, p2] = room.players;
  const pair = h2h.pairFor(p1.name, p2.name);
  if (!pair) {
    room.h2h = null; // placeholder/identical names: nothing to track against
    return;
  }
  const record = h2h.cleanRecord(
    { names: { [h2h.normName(p1.name)]: p1.name, [h2h.normName(p2.name)]: p2.name } },
    pair.keys
  );
  const state = { pair, record, before: null, loaded: false };
  room.h2h = state;
  const backups = room.players.map((p) => p.h2hBackup && p.h2hBackup[pair.pairKey]).filter(Boolean);
  h2h
    .load(pair, backups)
    .then((stored) => {
      state.record = h2h.mergeRecords(state.record, stored, pair.keys);
      state.loaded = true;
    })
    .catch(() => {
      state.loaded = true;
    });
}

function h2hKeyOf(room, playerId) {
  return h2h.normName(playerById(room, playerId).name);
}

// Records a finished hand (and, if it ended the match, the match too).
function recordH2h(room, handWinnerId, matchWinnerId) {
  const state = room.h2h;
  if (!state) return;
  state.before = h2h.cloneRecord(state.record); // what the clients show until the reveal is done
  const rec = state.record;
  const hk = h2hKeyOf(room, handWinnerId);
  rec.hands[hk] = (rec.hands[hk] || 0) + 1;
  if (matchWinnerId) {
    const mk = h2hKeyOf(room, matchWinnerId);
    rec.matches[mk] = (rec.matches[mk] || 0) + 1;
  }
  h2h.save(state.pair, rec).then((merged) => {
    state.record = h2h.mergeRecords(state.record, merged, state.pair.keys);
  });
}

function h2hViewFor(room, playerId) {
  const state = room.h2h;
  if (!state) return { tracked: false };
  const pending = room.hand && room.hand.result && state.before; // hide this hand's change until revealed
  return {
    tracked: true,
    pairKey: state.pair.pairKey,
    current: h2hView(room, playerId, state.record),
    before: pending ? h2hView(room, playerId, state.before) : null,
    // Raw record, handed to the browser to keep as a backup copy.
    sync: state.record,
  };
}

function h2hView(room, playerId, record) {
  const state = room.h2h;
  if (!state || !record) return null;
  const me = playerById(room, playerId);
  const opp = opponentOf(room, playerId);
  const side = (p) => {
    const k = h2hKeyOf(room, p.id);
    return { name: p.name, matches: record.matches[k] || 0, hands: record.hands[k] || 0 };
  };
  return { you: side(me), opp: side(opp) };
}

// ---------- settings + starting ----------
function isHost(room, player) {
  return room.players[0] && room.players[0].id === player.id;
}

function doUpdateSettings(room, player, input) {
  if (room.phase !== 'waiting' && room.phase !== 'setup') return { error: 'Game settings can only be changed before a game starts.' };
  if (!isHost(room, player)) return { error: 'Only the host can change the game settings.' };
  const next = normalizeSettings(input || {}, { mode: room.mode, matchTarget: room.matchTarget });
  room.mode = next.mode;
  room.matchTarget = next.matchTarget;
  room.lastActivity = Date.now();
  return { room };
}

function doStartGame(room, player) {
  if (room.phase !== 'setup') return { error: 'The game is not ready to start.' };
  if (!isHost(room, player)) return { error: 'Only the host can start the game.' };
  if (room.players.length < 2) return { error: 'Waiting for the other player to join.' };
  for (const p of room.players) room.scores[p.id] = 0;
  room.matchWinnerId = null;
  room.matchEndReason = null;
  if (!room.startingPlayerId) {
    room.startingPlayerId = room.players[crypto.randomInt(2)].id;
  }
  // dealNewHand alternates the starting player itself whenever a previous
  // hand exists, so alternation carries across matches too.
  dealNewHand(room);
  room.lastActivity = Date.now();
  log(room, `Game started: ${modeLabel(room)}.`);
  return { room };
}

function modeLabel(room) {
  return room.mode === 'exact'
    ? `Exact Target - land on exactly ${room.matchTarget} to win, go over and you lose`
    : `Classic - first to reach ${room.matchTarget} loses`;
}

function reshuffleIfNeeded(room) {
  if (room.hand.drawPile.length === 0) {
    if (room.hand.buried.length === 0) {
      // Extremely unlikely (would require nearly the whole deck in one hand's
      // discard group), but guard anyway: nothing to reshuffle.
      return;
    }
    room.hand.drawPile = gl.shuffle(room.hand.buried);
    room.hand.buried = [];
    log(room, 'Draw pile was empty - reshuffled discards into a new draw pile.');
  }
}

// Turn order: discard (or call Face Off) first, then draw. The discard is
// staged in pendingDiscard so the player's own draw this turn still only
// ever sees the pile their OPPONENT left behind - not the cards they just
// discarded. The staged discard becomes the new accessible pile, and the
// turn passes to the opponent, only once the draw completes.
function doDiscard(room, player, { cardIds }) {
  const hand = room.hand;
  if (room.phase !== 'playing') return { error: 'No hand in progress.' };
  if (hand.turnPlayerId !== player.id) return { error: 'Not your turn.' };
  if (hand.turnPhase !== 'await_discard') return { error: 'You already discarded this turn - draw a card to finish it.' };
  if (!Array.isArray(cardIds) || cardIds.length === 0) return { error: 'No cards selected.' };

  const myHand = hand.hands[player.id];
  const cards = [];
  for (const id of cardIds) {
    const c = myHand.find((card) => card.id === id);
    if (!c) return { error: 'Selected card is not in your hand.' };
    cards.push(c);
  }
  const uniqueIds = new Set(cardIds);
  if (uniqueIds.size !== cardIds.length) return { error: 'Duplicate card in selection.' };

  if (!gl.isValidMeld(cards)) {
    return { error: 'Not a valid discard: must be a single card, a same-rank group, or a same-suit run.' };
  }

  hand.hands[player.id] = myHand.filter((c) => !uniqueIds.has(c.id));
  // Store in display order - a run reads in rank order with any Joker sitting
  // in the exact slot of the rank it's standing in for (e.g. 5, JOKER, 7).
  hand.pendingDiscard = gl.orderMeldForDisplay(cards);
  hand.turnPhase = 'await_draw';
  room.lastActivity = Date.now();
  log(room, `${player.name} discarded ${cards.length} card(s).`);
  return { room };
}

// Undo a discard made by mistake. Only possible during the discarder's own
// turn, before they've drawn: the moment they pick up from either pile the
// discard is committed. The discarded cards stay visible to the opponent the
// whole time (see viewFor's pendingDiscard), so nothing is hidden or sneaky.
function doTakeBack(room, player) {
  const hand = room.hand;
  if (room.phase !== 'playing') return { error: 'No hand in progress.' };
  if (hand.turnPlayerId !== player.id) return { error: 'Not your turn.' };
  if (hand.turnPhase !== 'await_draw' || hand.pendingDiscard.length === 0) {
    return { error: 'Nothing to take back.' };
  }
  const n = hand.pendingDiscard.length;
  hand.hands[player.id].push(...hand.pendingDiscard);
  hand.pendingDiscard = [];
  hand.turnPhase = 'await_discard';
  room.lastActivity = Date.now();
  log(room, `${player.name} took back ${n} card(s).`);
  return { room };
}

function doDraw(room, player, { source, cardId }) {
  const hand = room.hand;
  if (room.phase !== 'playing') return { error: 'No hand in progress.' };
  if (hand.turnPlayerId !== player.id) return { error: 'Not your turn.' };
  if (hand.turnPhase !== 'await_draw') return { error: 'Discard a card (or call Face Off) before drawing.' };

  const myHand = hand.hands[player.id];
  let drawnCard;

  if (source === 'deck') {
    reshuffleIfNeeded(room);
    if (hand.drawPile.length === 0) return { error: 'Draw pile is empty.' };
    drawnCard = hand.drawPile.shift();
  } else if (source === 'discard') {
    if (!cardId) return { error: 'cardId is required when drawing from the discard pile.' };
    const idx = hand.discardPile.findIndex((c) => c.id === cardId);
    if (idx === -1) return { error: 'That card is not available to take from the discard pile.' };
    drawnCard = hand.discardPile[idx];
    hand.discardPile.splice(idx, 1);
  } else {
    return { error: 'Invalid draw source.' };
  }

  myHand.push(drawnCard);

  // Record the draw so the opponent can be shown it happened - and, when it
  // came from the discard pile, exactly which card, since that pile was
  // already face-up and public. A deck draw stays hidden from them (only the
  // drawer, or viewFor's own-player check, ever sees that card here).
  hand.lastDraw = {
    playerId: player.id,
    source,
    card: drawnCard,
    at: Date.now(),
  };

  // Turn is complete: whatever's left of the pile you drew from is no longer
  // accessible, and the cards you discarded this turn become the new pile -
  // available to your opponent, not to you.
  if (hand.discardPile.length > 0) {
    hand.buried.push(...hand.discardPile);
  }
  hand.discardPile = hand.pendingDiscard;
  hand.pendingDiscard = [];

  hand.turnPlayerId = opponentOf(room, player.id).id;
  hand.turnPhase = 'await_discard';
  room.lastActivity = Date.now();
  log(room, `${player.name} drew from the ${source}.`);
  return { room };
}

function doCallFaceOff(room, player) {
  const hand = room.hand;
  if (room.phase !== 'playing') return { error: 'No hand in progress.' };
  if (hand.turnPlayerId !== player.id) return { error: 'Not your turn.' };
  if (hand.turnPhase !== 'await_discard') return { error: 'You can only call Face Off at the start of your turn.' };

  const myHand = hand.hands[player.id];
  if (!gl.canCallFaceOff(myHand)) {
    return { error: 'You cannot call Face Off (hand must total 10 or less and have no Joker).' };
  }

  const opp = opponentOf(room, player.id);
  const oppHand = hand.hands[opp.id];
  const result = gl.resolveFaceOff(myHand, oppHand);

  let callerDelta = 0;
  let opponentDelta = 0;
  if (result.callerWins) {
    opponentDelta = result.opponentTotal;
  } else {
    callerDelta = result.callerTotal + room.assafPenalty;
  }
  room.scores[player.id] += callerDelta;
  room.scores[opp.id] += opponentDelta;

  hand.result = {
    callerId: player.id,
    callerName: player.name,
    opponentId: opp.id,
    opponentName: opp.name,
    callerTotal: result.callerTotal,
    opponentTotal: result.opponentTotal,
    callerWins: result.callerWins,
    reason: result.reason,
    callerDelta,
    opponentDelta,
  };
  room.phase = 'hand_over';
  room.lastActivity = Date.now();

  log(
    room,
    `${player.name} called Face Off! ${player.name}: ${result.callerTotal} pts, ${opp.name}: ${result.opponentTotal} pts. ` +
      (result.callerWins ? `${player.name} wins the hand.` : `${player.name} loses the hand (+${callerDelta} pts).`)
  );

  const handWinner = result.callerWins ? player : opp;
  const end = evaluateMatchEnd(room);
  if (end) {
    room.phase = 'match_over';
    room.matchWinnerId = end.winnerId;
    room.matchEndReason = end.reason;
    const winner = playerById(room, end.winnerId);
    if (end.reason === 'exact') log(room, `${winner.name} hit ${room.matchTarget} EXACTLY and wins the match!`);
    else if (end.reason === 'bust') log(room, `${opponentOf(room, end.winnerId).name} went over ${room.matchTarget} - ${winner.name} wins the match!`);
    else log(room, `${winner.name} wins the match!`);
  }
  recordH2h(room, handWinner.id, end ? end.winnerId : null);

  return { room };
}

// Decides whether the match is over after a hand. Only the player whose score
// just changed can end it.
//   classic: reaching the target loses.
//   exact:   landing on the target exactly wins; going past it loses.
function evaluateMatchEnd(room) {
  for (const p of room.players) {
    const score = room.scores[p.id];
    const other = opponentOf(room, p.id);
    if (room.mode === 'exact') {
      if (score === room.matchTarget) return { winnerId: p.id, reason: 'exact' };
      if (score > room.matchTarget) return { winnerId: other.id, reason: 'bust' };
    } else if (score >= room.matchTarget) {
      return { winnerId: other.id, reason: 'target' };
    }
  }
  return null;
}

function doNextHand(room, player) {
  if (room.phase !== 'hand_over') return { error: 'Current hand is not finished.' };
  dealNewHand(room);
  room.lastActivity = Date.now();
  return { room };
}

// A finished match goes back to the setup screen, so the host can keep the
// same game mode or pick a different one before the next match is dealt.
function doNewMatch(room, player) {
  if (room.phase !== 'match_over') return { error: 'Match is not finished.' };
  for (const p of room.players) room.scores[p.id] = 0;
  room.matchWinnerId = null;
  room.matchEndReason = null;
  room.phase = 'setup';
  room.lastActivity = Date.now();
  log(room, 'Back to game setup.');
  return { room };
}

// Build the JSON state visible to a specific player (hides opponent's hand contents).
function viewFor(room, playerId) {
  const me = playerById(room, playerId);
  const opp = opponentOf(room, playerId);
  const base = {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      seat: p.seat,
      connected: Date.now() - (p.lastSeen || 0) < DISCONNECT_MS,
    })),
    you: playerId,
    scores: room.scores,
    mode: room.mode,
    matchTarget: room.matchTarget,
    assafPenalty: room.assafPenalty,
    isHost: isHost(room, me),
    matchWinnerId: room.matchWinnerId || null,
    matchEndReason: room.matchEndReason || null,
    h2h: h2hViewFor(room, playerId),
    log: room.log.slice(-25),
  };

  // No hand is shown on the waiting/setup screens (a finished match's old
  // hand would otherwise linger there).
  if (!room.hand || room.phase === 'waiting' || room.phase === 'setup') {
    return { ...base, hand: null };
  }

  const h = room.hand;
  const myHand = h.hands[playerId] || [];
  const oppHand = opp ? h.hands[opp.id] || [] : [];

  return {
    ...base,
    hand: {
      myHand,
      myTotal: gl.handTotal(myHand),
      canCallFaceOff: h.turnPlayerId === playerId && h.turnPhase === 'await_discard' && gl.canCallFaceOff(myHand),
      opponentCardCount: oppHand.length,
      discardPile: h.discardPile,
      // This turn's discard, staged until the discarder draws. Visible to BOTH
      // players straight away; only the discarder can take it back, and only
      // until they pick up from a pile.
      pendingDiscard: h.pendingDiscard,
      canTakeBack: h.turnPlayerId === playerId && h.turnPhase === 'await_draw' && h.pendingDiscard.length > 0,
      drawPileCount: h.drawPile.length,
      turnPlayerId: h.turnPlayerId,
      turnPhase: h.turnPhase,
      isMyTurn: h.turnPlayerId === playerId,
      result: h.result,
      // Only revealed once a Face Off has actually been called this hand -
      // secrecy holds until then, and the key itself is omitted (not just
      // null) so it can't leak hand size or existence before the reveal.
      ...(h.result ? { opponentHand: oppHand } : {}),
      // Both players get to see that a draw happened and where from. The
      // actual card is included for the drawer themselves (it's their own
      // hand) and for anyone when it came from the discard pile (that pile
      // was already face-up, so this isn't new hidden information) - but
      // stays masked when it's the opponent's deck draw, same as a real
      // game where you can't see what someone else drew blind.
      lastDraw: h.lastDraw
        ? {
            playerId: h.lastDraw.playerId,
            playerName: playerById(room, h.lastDraw.playerId).name,
            source: h.lastDraw.source,
            card: h.lastDraw.playerId === playerId || h.lastDraw.source === 'discard' ? h.lastDraw.card : null,
            at: h.lastDraw.at,
          }
        : null,
    },
  };
}

// Periodic cleanup of stale rooms (6h idle).
setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [code, room] of rooms) {
    if (room.lastActivity < cutoff) rooms.delete(code);
  }
}, 30 * 60 * 1000).unref();

module.exports = {
  createRoom,
  joinRoom,
  authenticate,
  doDraw,
  doDiscard,
  doCallFaceOff,
  doTakeBack,
  doUpdateSettings,
  doStartGame,
  doNextHand,
  doNewMatch,
  viewFor,
  rooms,
  MODES,
  DEFAULT_TARGETS,
  MIN_TARGET,
  MAX_TARGET,
};
