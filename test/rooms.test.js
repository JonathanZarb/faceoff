'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rooms = require('../rooms');
const gl = require('../gameLogic');

function card(rank, suit) {
  return { id: gl.nextId(), rank, suit };
}

function makeRoomWithHand() {
  const { room, playerId: p1 } = rooms.createRoom('Alice');
  const { playerId: p2 } = rooms.joinRoom(room.code, 'Bob');
  return { room, p1, p2 };
}

test('doCallFaceOff: caller with lower total wins, opponent penalized their own hand total', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.startingPlayerId = p1;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('A', 'H'), card('2', 'S')]; // total 3, no joker -> callable
  room.hand.hands[p2] = [card('K', 'H'), card('K', 'S')]; // total 20

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.equal(result.error, undefined);
  assert.equal(room.phase, 'hand_over');
  assert.equal(room.scores[p1], 0);
  assert.equal(room.scores[p2], 20);
  assert.equal(room.hand.result.callerWins, true);
});

test('doCallFaceOff: tie means caller loses and pays own total + Assaf penalty', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('5', 'H'), card('5', 'S')]; // 10
  room.hand.hands[p2] = [card('4', 'H'), card('6', 'S')]; // 10

  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.scores[p1], 10 + room.assafPenalty);
  assert.equal(room.scores[p2], 0);
});

test('doCallFaceOff: rejected if caller holds a joker', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('A', 'H'), card('JOKER', null)];

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.match(result.error, /cannot call Face Off/);
  assert.equal(room.phase, 'playing');
});

test('doCallFaceOff: rejected if hand total > 10', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('K', 'H'), card('2', 'S')]; // 12

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.match(result.error, /cannot call Face Off/);
});

test('doCallFaceOff: not your turn is rejected', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p2obj = room.players.find((p) => p.id === p2);
  room.hand.turnPlayerId = p1; // it's p1's turn
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p2] = [card('A', 'H')];

  const result = rooms.doCallFaceOff(room, p2obj);
  assert.match(result.error, /Not your turn/);
});

test('doCallFaceOff: rejected mid-turn after already discarding (must be declared before discarding)', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_draw'; // already discarded, now must draw
  room.hand.hands[p1] = [card('A', 'H')]; // would otherwise be callable

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.match(result.error, /start of your turn/);
});

test('turn order: discard is rejected before... wait, discard IS the first action; draw before discarding is rejected', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard'; // start of turn

  const result = rooms.doDraw(room, p1obj, { source: 'deck' });
  assert.match(result.error, /Discard a card/);
});

test('turn order: discard first is accepted at start of turn, then draw completes the turn and passes it', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  const originalHand = room.hand.hands[p1].slice();

  const discardResult = rooms.doDiscard(room, p1obj, { cardIds: [originalHand[0].id] });
  assert.equal(discardResult.error, undefined);
  assert.equal(room.hand.turnPhase, 'await_draw');
  assert.equal(room.hand.turnPlayerId, p1); // still p1's turn - they still owe a draw
  assert.equal(room.hand.hands[p1].length, 9);

  // discarding again before drawing should be rejected
  const secondDiscard = rooms.doDiscard(room, p1obj, { cardIds: [originalHand[1].id] });
  assert.match(secondDiscard.error, /already discarded/);

  const drawResult = rooms.doDraw(room, p1obj, { source: 'deck' });
  assert.equal(drawResult.error, undefined);
  assert.equal(room.hand.turnPhase, 'await_discard');
  assert.equal(room.hand.turnPlayerId, p2); // turn passes only after the draw
  assert.equal(room.hand.hands[p1].length, 10);
});

test('match ends when a score crosses matchTarget; other player wins', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.matchTarget = 15; // lower target so one hand ends it
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('5', 'H'), card('5', 'S')]; // 10, tie -> caller loses
  room.hand.hands[p2] = [card('4', 'H'), card('6', 'S')]; // 10

  rooms.doCallFaceOff(room, p1obj);
  // p1 gets 10 + 20 penalty = 30 >= 15 -> match over, p2 (opponent) wins
  assert.equal(room.phase, 'match_over');
  assert.equal(room.matchWinnerId, p2);
});

test('doNextHand deals a fresh hand after hand_over, same starting player persists', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const startingBefore = room.startingPlayerId;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('A', 'H')];
  room.hand.hands[p2] = [card('K', 'H'), card('K', 'S')];

  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.phase, 'hand_over');

  const res = rooms.doNextHand(room, p1obj);
  assert.equal(res.error, undefined);
  assert.equal(room.phase, 'playing');
  assert.equal(room.startingPlayerId, startingBefore);
  assert.equal(room.hand.turnPlayerId, startingBefore);
  assert.equal(room.hand.turnPhase, 'await_discard');
  assert.equal(room.hand.hands[p1].length, 10);
  assert.equal(room.hand.hands[p2].length, 10);
});

test('doNewMatch resets scores and randomizes/deals after match_over', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.matchTarget = 5;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('5', 'H')]; // total 5, will lose on tie against equal
  room.hand.hands[p2] = [card('5', 'S')];
  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.phase, 'match_over');

  const res = rooms.doNewMatch(room, p1obj);
  assert.equal(res.error, undefined);
  assert.equal(room.scores[p1], 0);
  assert.equal(room.scores[p2], 0);
  assert.equal(room.phase, 'playing');
  assert.equal(room.matchWinnerId, null);
});

test('draw-from-discard only exposes previous turn group; own just-discarded cards are not drawable by you', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const p2obj = room.players.find((p) => p.id === p2);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('7', 'H'), card('7', 'S'), card('7', 'D'), card('2', 'C')];
  room.hand.drawPile = [card('9', 'H')];
  room.hand.discardPile = [card('3', 'C')]; // whatever the opponent left before this turn

  // p1 discards a group of three 7s first...
  rooms.doDiscard(room, p1obj, { cardIds: room.hand.hands[p1].filter((c) => c.rank === '7').map((c) => c.id) });
  // ...but those 7s are staged, not yet the accessible pile - p1 still only sees the old 3C group.
  assert.equal(room.hand.discardPile.length, 1);
  assert.equal(room.hand.discardPile[0].rank, '3');
  assert.equal(room.hand.pendingDiscard.length, 3);

  // p1 draws from the deck to finish their turn
  rooms.doDraw(room, p1obj, { source: 'deck' });
  assert.equal(room.hand.turnPlayerId, p2);
  // now the three 7s are the accessible pile for p2 (the 3C got buried since it went unclaimed)
  assert.equal(room.hand.discardPile.length, 3);
  assert.equal(room.hand.buried.some((c) => c.rank === '3'), true);

  // p2 takes exactly one of those three 7s
  const takenId = room.hand.discardPile[0].id;
  rooms.doDiscard(room, p2obj, { cardIds: [room.hand.hands[p2][0].id] }); // p2 discards first...
  const drawRes = rooms.doDraw(room, p2obj, { source: 'discard', cardId: takenId });
  assert.equal(drawRes.error, undefined);
  assert.equal(room.hand.hands[p2].some((c) => c.id === takenId), true);
  // the other two 7s are now buried, not sitting in an accessible discard pile
  assert.equal(room.hand.buried.filter((c) => c.rank === '7').length, 2);
});

test('viewFor hides opponent hand contents but exposes count', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const view = rooms.viewFor(room, p1);
  assert.equal(view.hand.myHand.length, 10);
  assert.equal(typeof view.hand.opponentCardCount, 'number');
  assert.equal(view.hand.opponentCardCount, 10);
  assert.equal(JSON.stringify(view).includes('"opponentHand"'), false);
});
