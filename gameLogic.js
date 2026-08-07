'use strict';
/**
 * Face Off - core game engine. Pure functions, no I/O, no dependencies.
 */

const SUITS = ['H', 'D', 'C', 'S'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
// Ranks sit on a circle for sequence purposes: A is adjacent to both 2 (the
// classic low ace) and K (so Q-K-A-2 style runs "round the corner" work too).
const RANK_CIRCLE_SIZE = RANKS.length;
const SUIT_DISPLAY_ORDER = { H: 0, D: 1, C: 2, S: 3 };

let _idCounter = 0;
function nextId() {
  _idCounter += 1;
  return 'c' + _idCounter;
}

function resetIdCounter() {
  _idCounter = 0;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ id: nextId(), rank, suit });
    }
  }
  deck.push({ id: nextId(), rank: 'JOKER', suit: null });
  deck.push({ id: nextId(), rank: 'JOKER', suit: null });
  return deck;
}

// Deterministic-shuffle-friendly Fisher-Yates. Pass an rng() => [0,1) for testability.
function shuffle(cards, rng = Math.random) {
  const arr = cards.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function rankIndex(rank) {
  // A=1 ... K=13. Used for sequence adjacency only (not point value).
  const idx = RANKS.indexOf(rank);
  if (idx === -1) throw new Error('rankIndex: not a sequenceable rank: ' + rank);
  return idx + 1;
}

function rankPosition(rank) {
  // 0-indexed position on the rank circle: A=0, 2=1, ..., K=12.
  const idx = RANKS.indexOf(rank);
  if (idx === -1) throw new Error('rankPosition: not a sequenceable rank: ' + rank);
  return idx;
}

function pointValue(card) {
  if (card.rank === 'JOKER') return 15;
  if (card.rank === 'A') return 1;
  if (card.rank === 'J' || card.rank === 'Q' || card.rank === 'K') return 10;
  return parseInt(card.rank, 10);
}

function handTotal(hand) {
  return hand.reduce((sum, c) => sum + pointValue(c), 0);
}

function hasJoker(hand) {
  return hand.some((c) => c.rank === 'JOKER');
}

function canCallFaceOff(hand) {
  return !hasJoker(hand) && handTotal(hand) <= 10;
}

// A "group" = 2+ cards of the same rank (jokers wild).
function isValidGroup(cards) {
  if (cards.length < 2) return false;
  const nonJokers = cards.filter((c) => c.rank !== 'JOKER');
  if (nonJokers.length === 0) return true;
  const rank = nonJokers[0].rank;
  return nonJokers.every((c) => c.rank === rank);
}

// A "run" = 3+ cards, same suit, consecutive ranks (jokers wild, fill gaps/extend).
// Ranks wrap around the circle (see RANK_CIRCLE_SIZE), so K-A-2 style runs are
// allowed alongside the classic low-ace A-2-3.
function isValidRun(cards) {
  if (cards.length < 3) return false;
  const jokers = cards.filter((c) => c.rank === 'JOKER');
  const others = cards.filter((c) => c.rank !== 'JOKER');
  const L = cards.length;

  if (others.length === 0) {
    // All wild - any window of length L fits somewhere on the circle as long as L <= 13.
    return L <= RANK_CIRCLE_SIZE;
  }

  const suit = others[0].suit;
  if (!others.every((c) => c.suit === suit)) return false;

  const positions = others.map((c) => rankPosition(c.rank));
  if (new Set(positions).size !== positions.length) return false; // duplicate rank in a run = invalid

  return findRunWindow(positions, others.length, jokers.length, L) !== null;
}

// Tries every rotation ("cut") of the rank circle so a set of positions that
// forms a contiguous arc - possibly wrapping through the K-A-2 corner - is
// recognized regardless of where on the circle it sits. Returns the window
// { cut, lowStart } it found (there may be more than one when extra jokers
// give room to extend either direction), or null if no arc fits.
function findRunWindow(positions, othersCount, jokerCount, L) {
  for (let cut = 0; cut < RANK_CIRCLE_SIZE; cut++) {
    const vals = positions.map((p) => (p - cut + RANK_CIRCLE_SIZE) % RANK_CIRCLE_SIZE);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const span = maxV - minV + 1;
    if (span > L) continue; // this cut splits the true arc across the seam - try another

    const internalGaps = span - othersCount;
    if (jokerCount < internalGaps) continue;

    const lowMin = Math.max(0, maxV - L + 1);
    const lowMax = Math.min(minV, RANK_CIRCLE_SIZE - L);
    if (lowMin > lowMax) continue;

    return { cut, vals, lowStart: lowMax };
  }
  return null;
}

function isValidMeld(cards) {
  if (cards.length === 1) return true;
  return isValidGroup(cards) || isValidRun(cards);
}

// Given a set of cards already known to form a valid meld (single card, group,
// or run), return them in the order they should be displayed - so a discarded
// run always reads in rank order, with any Joker sitting in the exact slot of
// the rank it's standing in for (e.g. 5, JOKER, 7 when the joker is the "6").
function orderMeldForDisplay(cards) {
  if (cards.length <= 1) return cards.slice();

  if (isValidGroup(cards)) {
    // Same-rank group: sequence position is meaningless, but keep the order
    // deterministic (by suit) instead of whatever order they were clicked in.
    const nonJokers = cards
      .filter((c) => c.rank !== 'JOKER')
      .slice()
      .sort((a, b) => SUIT_DISPLAY_ORDER[a.suit] - SUIT_DISPLAY_ORDER[b.suit]);
    const jokers = cards.filter((c) => c.rank === 'JOKER');
    return [...nonJokers, ...jokers];
  }

  // Otherwise it's a run (already validated by the caller via isValidMeld).
  const jokers = cards.filter((c) => c.rank === 'JOKER');
  const others = cards.filter((c) => c.rank !== 'JOKER');
  const L = cards.length;

  if (others.length === 0) return cards.slice(); // all-joker run - no inherent order

  const positions = others.map((c) => rankPosition(c.rank));
  const window = findRunWindow(positions, others.length, jokers.length, L);
  if (!window) return cards.slice(); // shouldn't happen if isValidMeld was already checked

  const byVal = new Map(others.map((c, i) => [window.vals[i], c]));
  const jokerQueue = jokers.slice();
  const ordered = [];
  for (let p = window.lowStart; p < window.lowStart + L; p++) {
    const slot = ((p % RANK_CIRCLE_SIZE) + RANK_CIRCLE_SIZE) % RANK_CIRCLE_SIZE;
    ordered.push(byVal.has(slot) ? byVal.get(slot) : jokerQueue.shift());
  }
  return ordered;
}

function dealHands(deck, numPerPlayer) {
  const p1 = deck.slice(0, numPerPlayer);
  const p2 = deck.slice(numPerPlayer, numPerPlayer * 2);
  const rest = deck.slice(numPerPlayer * 2);
  const upCard = rest[0];
  const drawPile = rest.slice(1);
  return { p1Hand: p1, p2Hand: p2, drawPile, discardPile: upCard ? [upCard] : [] };
}

/**
 * Resolve a Face Off call.
 * callerHand / opponentHand: arrays of cards.
 * Returns { callerTotal, opponentTotal, callerWins, reason }
 */
function resolveFaceOff(callerHand, opponentHand) {
  const callerTotal = handTotal(callerHand);
  const opponentTotal = handTotal(opponentHand);
  const callerWins = callerTotal < opponentTotal;
  return {
    callerTotal,
    opponentTotal,
    callerWins,
    reason: callerWins
      ? 'caller_lower'
      : callerTotal === opponentTotal
      ? 'tie_caller_loses'
      : 'caller_higher',
  };
}

module.exports = {
  SUITS,
  RANKS,
  createDeck,
  shuffle,
  rankIndex,
  rankPosition,
  pointValue,
  handTotal,
  hasJoker,
  canCallFaceOff,
  isValidGroup,
  isValidRun,
  isValidMeld,
  orderMeldForDisplay,
  dealHands,
  resolveFaceOff,
  resetIdCounter,
  nextId,
};
