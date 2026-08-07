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
  // p1 gets 10 + 25 penalty = 35 >= 15 -> match over, p2 (opponent) wins
  assert.equal(room.phase, 'match_over');
  assert.equal(room.matchWinnerId, p2);
});

test('doNextHand deals a fresh hand after hand_over, and the starting player alternates', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const startingBefore = room.startingPlayerId;
  const expectedNextStarter = startingBefore === p1 ? p2 : p1;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('A', 'H')];
  room.hand.hands[p2] = [card('K', 'H'), card('K', 'S')];

  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.phase, 'hand_over');

  const res = rooms.doNextHand(room, p1obj);
  assert.equal(res.error, undefined);
  assert.equal(room.phase, 'playing');
  assert.equal(room.startingPlayerId, expectedNextStarter);
  assert.equal(room.hand.turnPlayerId, expectedNextStarter);
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

test('viewFor reveals the opponent\'s actual hand once a Face Off has been called', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('A', 'H'), card('2', 'S')]; // total 3
  room.hand.hands[p2] = [card('K', 'H'), card('K', 'S')]; // total 20

  rooms.doCallFaceOff(room, p1obj);

  const view = rooms.viewFor(room, p1);
  assert.ok(Array.isArray(view.hand.opponentHand));
  assert.equal(view.hand.opponentHand.length, 2);
  assert.deepEqual(
    view.hand.opponentHand.map((c) => c.rank).sort(),
    ['K', 'K']
  );

  // The opponent, in turn, sees the caller's real cards too.
  const oppView = rooms.viewFor(room, p2);
  assert.deepEqual(
    oppView.hand.opponentHand.map((c) => c.rank).sort(),
    ['2', 'A']
  );
});

test('viewFor reports a freshly-joined player as connected', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const view = rooms.viewFor(room, p1);
  const p1entry = view.players.find((p) => p.id === p1);
  const p2entry = view.players.find((p) => p.id === p2);
  assert.equal(p1entry.connected, true);
  assert.equal(p2entry.connected, true);
});

test('viewFor marks a player disconnected once their lastSeen goes stale, and connected again once it is fresh', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p2obj = room.players.find((p) => p.id === p2);

  // Simulate p2 going quiet for longer than the disconnect threshold.
  p2obj.lastSeen = Date.now() - 10000;
  let view = rooms.viewFor(room, p1);
  assert.equal(view.players.find((p) => p.id === p2).connected, false);
  // p1 (still polling) should read as connected throughout.
  assert.equal(view.players.find((p) => p.id === p1).connected, true);

  // p2 "reconnects" - the next authenticated call (a state poll or action)
  // refreshes lastSeen, same as authenticate() does for real requests.
  p2obj.lastSeen = Date.now();
  view = rooms.viewFor(room, p1);
  assert.equal(view.players.find((p) => p.id === p2).connected, true);
});

test('authenticate() refreshes lastSeen, keeping an actively-polling player connected', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  p1obj.lastSeen = Date.now() - 10000; // pretend they've been quiet

  const result = rooms.authenticate(room.code, p1obj.id, p1obj.token);
  assert.equal(result.error, undefined);
  assert.ok(Date.now() - result.player.lastSeen < 100);
});

test('assafPenalty is 25: a miscall costs the caller their hand total plus 25', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('5', 'H'), card('5', 'S')]; // 10, tie -> caller loses
  room.hand.hands[p2] = [card('4', 'H'), card('6', 'S')]; // 10

  rooms.doCallFaceOff(room, p1obj);
  assert.equal(room.assafPenalty, 25);
  assert.equal(room.scores[p1], 10 + 25);
  assert.equal(room.scores[p2], 0);
});

test('starting player alternates every new hand, including across doNextHand', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const first = room.startingPlayerId;
  const second = first === p1 ? p2 : p1;

  room.hand.turnPlayerId = first;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[first] = [card('A', 'H')];
  room.hand.hands[second] = [card('K', 'H'), card('K', 'S')];
  rooms.doCallFaceOff(room, room.players.find((p) => p.id === first));
  assert.equal(room.phase, 'hand_over');

  rooms.doNextHand(room, room.players.find((p) => p.id === first));
  assert.equal(room.startingPlayerId, second);
  assert.equal(room.hand.turnPlayerId, second);

  // And back again on the following hand.
  room.hand.turnPlayerId = second;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[second] = [card('A', 'D')];
  room.hand.hands[first] = [card('K', 'D'), card('K', 'C')];
  rooms.doCallFaceOff(room, room.players.find((p) => p.id === second));
  rooms.doNextHand(room, room.players.find((p) => p.id === second));
  assert.equal(room.startingPlayerId, first);
});

test('starting player keeps alternating across a new match (not re-randomized)', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.matchTarget = 5;
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  room.hand.hands[p1] = [card('5', 'H')];
  room.hand.hands[p2] = [card('5', 'S')];
  rooms.doCallFaceOff(room, p1obj); // tie -> p1 loses, 5+25=30 >= matchTarget 5 -> match_over
  assert.equal(room.phase, 'match_over');
  const startingBeforeNewMatch = room.startingPlayerId;
  const expectedNext = startingBeforeNewMatch === p1 ? p2 : p1;

  rooms.doNewMatch(room, p1obj);
  assert.equal(room.phase, 'playing');
  assert.equal(room.startingPlayerId, expectedNext);
});

test('doDiscard stores a run in rank order with the joker filling its exact gap', () => {
  const { room, p1 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';
  // Selected out of order on purpose - server should still store them in
  // sequence order with the joker standing in for the missing '6'.
  const seven = card('7', 'H');
  const five = card('5', 'H');
  const joker = card('JOKER', null);
  room.hand.hands[p1] = [seven, five, joker, card('2', 'S')];

  const result = rooms.doDiscard(room, p1obj, { cardIds: [seven.id, five.id, joker.id] });
  assert.equal(result.error, undefined);
  assert.deepEqual(
    room.hand.pendingDiscard.map((c) => c.rank),
    ['5', 'JOKER', '7']
  );
});

test('doDraw records lastDraw; deck draws stay hidden from the opponent, discard draws are visible to both', () => {
  const { room, p1, p2 } = makeRoomWithHand();
  const p1obj = room.players.find((p) => p.id === p1);
  const p2obj = room.players.find((p) => p.id === p2);
  room.hand.turnPlayerId = p1;
  room.hand.turnPhase = 'await_discard';

  const deckCard = card('9', 'C');
  room.hand.drawPile = [deckCard, ...room.hand.drawPile];

  // p1 discards one card, then draws from the deck.
  const p1Card = room.hand.hands[p1][0];
  rooms.doDiscard(room, p1obj, { cardIds: [p1Card.id] });
  rooms.doDraw(room, p1obj, { source: 'deck' });

  const p1View = rooms.viewFor(room, p1);
  const p2View = rooms.viewFor(room, p2);
  assert.equal(p1View.hand.lastDraw.source, 'deck');
  assert.equal(p1View.hand.lastDraw.playerId, p1);
  assert.equal(p1View.hand.lastDraw.card.id, deckCard.id); // drawer sees their own card
  assert.equal(p2View.hand.lastDraw.card, null); // opponent does NOT see a hidden deck draw

  // p1's discard is now the accessible pile. p2 draws it - that card was
  // already face-up (public info), so both players should see it.
  assert.equal(room.hand.discardPile[0].id, p1Card.id);
  const p2Card = room.hand.hands[p2][0];
  rooms.doDiscard(room, p2obj, { cardIds: [p2Card.id] });
  const drawResult = rooms.doDraw(room, p2obj, { source: 'discard', cardId: p1Card.id });
  assert.equal(drawResult.error, undefined);

  const p1ViewAfter = rooms.viewFor(room, p1);
  const p2ViewAfter = rooms.viewFor(room, p2);
  assert.equal(p1ViewAfter.hand.lastDraw.source, 'discard');
  assert.equal(p2ViewAfter.hand.lastDraw.source, 'discard');
  assert.ok(p1ViewAfter.hand.lastDraw.card); // opponent (p1) can see a discard-pile draw
  assert.equal(p1ViewAfter.hand.lastDraw.card.id, p1Card.id);
  assert.equal(p2ViewAfter.hand.lastDraw.card.id, p1Card.id);
});
