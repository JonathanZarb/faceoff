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
  room.hand.turnPhase = 'await_draw';
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
  room.hand.turnPhase = 'await_draw';
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
  room.hand.turnPhase = 'await_draw';
  room.hand.hands[p1] = [card('A', 'H'), card('JOKER', null)];

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.match(result.error, /cannot call Face Off/);
  assert.equal(room.phase, 'playing');
});

test('doCallFaceOff: rejected if hand total > 10', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_draw';
  room.hand.hands[p1] = [card('K', 'H'), card('2', 'S')]; // 12

  const result = rooms.doCallFaceOff(room, p1obj);
  assert.match(result.error, /cannot call Face Off/);
});

test('doCallFaceOff: not your turn is rejected', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p2obj = room.players.find((p) => p.id === p2);
  room.hand.turnPlayerId = p1; // it's p1's turn
  room.hand.turnPhase = 'await_draw';
  room.hand.hands[p2] = [card('A', 'H')];

  const result = rooms.doCallFaceOff(room, p2obj);
  assert.match(result.error, /Not your turn/);
});

test('match ends when a score crosses matchTarget; other player wins', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.matchTarget = 15; // lower target so one hand ends it
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_draw';
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
  room.hand.turnPhase = 'await_draw';
  room.hand.hands[p1] = [card('A', 'H')];
  room.hand.hands[p2] = [card('K', 'H'), card('K', 'S')];

  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.phase, 'hand_over');

  const res = rooms.doNextHand(room, p1obj);
  assert.equal(res.error, undefined);
  assert.equal(room.phase, 'playing');
  assert.equal(room.startingPlayerId, startingBefore);
  assert.equal(room.hand.turnPlayerId, startingBefore);
  assert.equal(room.hand.hands[p1].length, 10);
  assert.equal(room.hand.hands[p2].length, 10);
});

test('doNewMatch resets scores and randomizes/deals after match_over', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.matchTarget = 5;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_draw';
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

test('draw-from-discard only exposes previous turn group; leftover becomes buried', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const p2obj = room.players.find((p) => p.id === p2);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_draw';
  room.hand.hands[p1] = [card('7', 'H'), card('7', 'S'), card('7', 'D'), card('2', 'C')];
  room.hand.drawPile = [card('9', 'H')];
  room.hand.discardPile = [card('3', 'C')]; // initial up-card

  // p1 draws from deck, then discards a group of three 7s
  rooms.doDraw(room, p1obj, { source: 'deck' });
  rooms.doDiscard(room, p1obj, { cardIds: room.hand.hands[p1].filter((c) => c.rank === '7').map((c) => c.id) });
  assert.equal(room.hand.discardPile.length, 3);
  assert.equal(room.hand.turnPlayerId, p2);

  // p2 takes exactly one of those three 7s
  const takenId = room.hand.discardPile[0].id;
  rooms.doDraw(room, p2obj, { source: 'discard', cardId: takenId });
  assert.equal(room.hand.hands[p2].some((c) => c.id === takenId), true);
  // the other two 7s are now buried, not sitting in an accessible discard pile
  assert.equal(room.hand.discardPile.length, 0);
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
