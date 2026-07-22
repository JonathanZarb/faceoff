'use strict';
/**
 * In-memory room/session manager. Wraps gameLogic with turn state, scoring,
 * and the "only the previous turn's discard is takeable" rule.
 */
const crypto = require('crypto');
const gl = require('./gameLogic');

const HAND_SIZE = 10;
const MATCH_TARGET = 100;
const ASSAF_PENALTY = 20;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

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

function createRoom(name) {
  const code = makeRoomCode();
  const room = {
    code,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    players: [],
    scores: {},
    startingPlayerId: null,
    phase: 'waiting', // waiting -> playing -> hand_over -> playing -> ... -> match_over
    hand: null,
    log: [],
    matchTarget: MATCH_TARGET,
    assafPenalty: ASSAF_PENALTY,
  };
  const id = crypto.randomUUID();
  const token = randomToken();
  room.players.push({ id, token, name: name || 'Player 1', seat: 1 });
  room.scores[id] = 0;
  rooms.set(code, room);
  log(room, `${room.players[0].name} created the room.`);
  return { room, playerId: id, token };
}

function joinRoom(code, name) {
  const room = rooms.get(code.toUpperCase());
  if (!room) return { error: 'Room not found.' };
  if (room.players.length >= 2) return { error: 'Room is full.' };
  const id = crypto.randomUUID();
  const token = randomToken();
  room.players.push({ id, token, name: name || 'Player 2', seat: 2 });
  room.scores[id] = 0;
  log(room, `${room.players[1].name} joined the room.`);
  room.lastActivity = Date.now();

  if (room.players.length === 2) {
    room.startingPlayerId = room.players[crypto.randomInt(2)].id;
    dealNewHand(room);
  }
  return { room, playerId: id, token };
}

function authenticate(code, playerId, token) {
  const room = rooms.get((code || '').toUpperCase());
  if (!room) return { error: 'Room not found.' };
  const player = room.players.find((p) => p.id === playerId && p.token === token);
  if (!player) return { error: 'Not authorized for this room.' };
  return { room, player };
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
  hand.pendingDiscard = cards;
  hand.turnPhase = 'await_draw';
  room.lastActivity = Date.now();
  log(room, `${player.name} discarded ${cards.length} card(s).`);
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

  if (room.scores[player.id] >= room.matchTarget || room.scores[opp.id] >= room.matchTarget) {
    room.phase = 'match_over';
    const matchWinner = room.scores[player.id] >= room.matchTarget ? opp : player;
    room.matchWinnerId = matchWinner.id;
    log(room, `${matchWinner.name} wins the match!`);
  }

  return { room };
}

function doNextHand(room, player) {
  if (room.phase !== 'hand_over') return { error: 'Current hand is not finished.' };
  dealNewHand(room);
  room.lastActivity = Date.now();
  return { room };
}

function doNewMatch(room, player) {
  if (room.phase !== 'match_over') return { error: 'Match is not finished.' };
  for (const p of room.players) room.scores[p.id] = 0;
  room.matchWinnerId = null;
  room.startingPlayerId = room.players[crypto.randomInt(2)].id;
  dealNewHand(room);
  room.lastActivity = Date.now();
  log(room, 'New match started.');
  return { room };
}

// Build the JSON state visible to a specific player (hides opponent's hand contents).
function viewFor(room, playerId) {
  const me = playerById(room, playerId);
  const opp = opponentOf(room, playerId);
  const base = {
    code: room.code,
    phase: room.phase,
    players: room.players.map((p) => ({ id: p.id, name: p.name, seat: p.seat })),
    you: playerId,
    scores: room.scores,
    matchTarget: room.matchTarget,
    assafPenalty: room.assafPenalty,
    matchWinnerId: room.matchWinnerId || null,
    log: room.log.slice(-25),
  };

  if (!room.hand) {
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
      drawPileCount: h.drawPile.length,
      turnPlayerId: h.turnPlayerId,
      turnPhase: h.turnPhase,
      isMyTurn: h.turnPlayerId === playerId,
      result: h.result,
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
  doNextHand,
  doNewMatch,
  viewFor,
  rooms,
};
