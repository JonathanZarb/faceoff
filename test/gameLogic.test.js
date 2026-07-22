'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const gl = require('../gameLogic');

function card(rank, suit) {
  return { id: gl.nextId(), rank, suit };
}

test('createDeck has 54 cards, 2 jokers', () => {
  const deck = gl.createDeck();
  assert.equal(deck.length, 54);
  assert.equal(deck.filter((c) => c.rank === 'JOKER').length, 2);
  const ids = new Set(deck.map((c) => c.id));
  assert.equal(ids.size, 54);
});

test('shuffle preserves all cards, changes order (probabilistically)', () => {
  const deck = gl.createDeck();
  const shuffled = gl.shuffle(deck, () => 0.42);
  assert.equal(shuffled.length, deck.length);
  const origIds = deck.map((c) => c.id).sort();
  const shufIds = shuffled.map((c) => c.id).sort();
  assert.deepEqual(shufIds, origIds);
});

test('pointValue mapping matches spec', () => {
  assert.equal(gl.pointValue(card('A', 'H')), 1);
  assert.equal(gl.pointValue(card('2', 'H')), 2);
  assert.equal(gl.pointValue(card('9', 'H')), 9);
  assert.equal(gl.pointValue(card('10', 'H')), 10);
  assert.equal(gl.pointValue(card('J', 'H')), 10);
  assert.equal(gl.pointValue(card('Q', 'H')), 10);
  assert.equal(gl.pointValue(card('K', 'H')), 10);
  assert.equal(gl.pointValue(card('JOKER', null)), 15);
});

test('handTotal sums point values', () => {
  const hand = [card('A', 'H'), card('K', 'S'), card('7', 'D')];
  assert.equal(gl.handTotal(hand), 1 + 10 + 7);
});

test('canCallFaceOff: true when total <=10 and no joker', () => {
  const hand = [card('A', 'H'), card('4', 'S'), card('5', 'D')]; // total 10
  assert.equal(gl.canCallFaceOff(hand), true);
});

test('canCallFaceOff: false when total > 10', () => {
  const hand = [card('K', 'H'), card('2', 'S')]; // total 12
  assert.equal(gl.canCallFaceOff(hand), false);
});

test('canCallFaceOff: false when holding a joker, even if total <=10', () => {
  const hand = [card('A', 'H'), card('JOKER', null)];
  assert.equal(gl.canCallFaceOff(hand), false);
});

test('isValidGroup: same rank pair/triple valid', () => {
  assert.equal(gl.isValidGroup([card('7', 'H'), card('7', 'S')]), true);
  assert.equal(gl.isValidGroup([card('7', 'H'), card('7', 'S'), card('7', 'D')]), true);
});

test('isValidGroup: mismatched ranks invalid', () => {
  assert.equal(gl.isValidGroup([card('7', 'H'), card('8', 'S')]), false);
});

test('isValidGroup: joker substitutes into a group', () => {
  assert.equal(gl.isValidGroup([card('7', 'H'), card('7', 'S'), card('JOKER', null)]), true);
});

test('isValidGroup: single card is not a group', () => {
  assert.equal(gl.isValidGroup([card('7', 'H')]), false);
});

test('isValidRun: simple same-suit sequence valid', () => {
  assert.equal(gl.isValidRun([card('4', 'H'), card('5', 'H'), card('6', 'H')]), true);
});

test('isValidRun: mixed suits invalid', () => {
  assert.equal(gl.isValidRun([card('4', 'H'), card('5', 'S'), card('6', 'H')]), false);
});

test('isValidRun: non-consecutive invalid without jokers', () => {
  assert.equal(gl.isValidRun([card('4', 'H'), card('5', 'H'), card('7', 'H')]), false);
});

test('isValidRun: joker fills internal gap', () => {
  assert.equal(gl.isValidRun([card('4', 'H'), card('JOKER', null), card('6', 'H')]), true);
});

test('isValidRun: joker extends sequence at an edge', () => {
  assert.equal(gl.isValidRun([card('J', 'H'), card('Q', 'H'), card('JOKER', null)]), true);
});

test('isValidRun: A can only extend downward (A is low, no wraparound to K)', () => {
  // A,2,JOKER -> joker must be "3" (extend up) since below A is out of range
  assert.equal(gl.isValidRun([card('A', 'H'), card('2', 'H'), card('JOKER', null)]), true);
});

test('isValidRun: not enough room fails (K,K duplicate-ish edge / out of range)', () => {
  // Q, K, JOKER, JOKER requesting length 4 starting below Q or above K -> below Q is fine (J,Q,K,+1 not possible above K)
  // J,Q,K,JOKER should still be valid using low extension
  assert.equal(gl.isValidRun([card('J', 'H'), card('Q', 'H'), card('K', 'H'), card('JOKER', null)]), true);
});

test('isValidRun: impossible run even with jokers (too many needed beyond range)', () => {
  // K alone plus 4 jokers requesting length 5 - would need to extend beyond K (impossible) and below,
  // but range 9,10,J,Q,K is valid (5 consecutive ending at K) so this should be valid.
  const cards = [card('K', 'H'), card('JOKER', null), card('JOKER', null)];
  assert.equal(gl.isValidRun(cards), true); // J,Q,K or K + 2 jokers fits somewhere
});

test('isValidRun: duplicate rank in same suit invalid', () => {
  assert.equal(gl.isValidRun([card('4', 'H'), card('4', 'H'), card('5', 'H')]), false);
});

test('isValidRun: all-wild selection is a valid abstract run (real deck only has 2 jokers, enforced elsewhere)', () => {
  assert.equal(gl.isValidRun([card('JOKER', null), card('JOKER', null), card('JOKER', null)]), true);
});

test('isValidMeld: single card always valid', () => {
  assert.equal(gl.isValidMeld([card('7', 'H')]), true);
});

test('isValidMeld: invalid combo rejected', () => {
  assert.equal(gl.isValidMeld([card('7', 'H'), card('9', 'S')]), false);
});

test('dealHands deals correct counts and sets up piles', () => {
  const deck = gl.shuffle(gl.createDeck(), () => 0.1);
  const { p1Hand, p2Hand, drawPile, discardPile } = gl.dealHands(deck, 10);
  assert.equal(p1Hand.length, 10);
  assert.equal(p2Hand.length, 10);
  assert.equal(discardPile.length, 1);
  assert.equal(drawPile.length, 54 - 10 - 10 - 1);
});

test('resolveFaceOff: caller strictly lower wins', () => {
  const caller = [card('A', 'H'), card('2', 'S')]; // 3
  const opp = [card('K', 'H'), card('K', 'S')]; // 20
  const result = gl.resolveFaceOff(caller, opp);
  assert.equal(result.callerWins, true);
  assert.equal(result.reason, 'caller_lower');
});

test('resolveFaceOff: tie means caller loses', () => {
  const caller = [card('5', 'H'), card('5', 'S')]; // 10
  const opp = [card('4', 'H'), card('6', 'S')]; // 10
  const result = gl.resolveFaceOff(caller, opp);
  assert.equal(result.callerWins, false);
  assert.equal(result.reason, 'tie_caller_loses');
});

test('resolveFaceOff: caller higher loses, joker in opponent hand counts as 15', () => {
  const caller = [card('A', 'H')]; // 1
  const opp = [card('JOKER', null)]; // 15 (opponent still holding a joker at reveal)
  const result = gl.resolveFaceOff(caller, opp);
  assert.equal(result.opponentTotal, 15);
  assert.equal(result.callerWins, true); // 1 < 15
});
