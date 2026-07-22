'use strict';
/**
 * Face Off - core game engine. Pure functions, no I/O, no dependencies.
 */

const SUITS = ['H', 'D', 'C', 'S'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

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
function isValidRun(cards) {
  if (cards.length < 3) return false;
  const jokers = cards.filter((c) => c.rank === 'JOKER');
  const others = cards.filter((c) => c.rank !== 'JOKER');
  const L = cards.length;

  if (others.length === 0) {
    // All wild - any window of length L fits somewhere in 1..13 as long as L <= 13.
    return L <= 13;
  }

  const suit = others[0].suit;
  if (!others.every((c) => c.suit === suit)) return false;

  const vals = others.map((c) => rankIndex(c.rank));
  const uniqueVals = new Set(vals);
  if (uniqueVals.size !== vals.length) return false; // duplicate rank in a run = invalid

  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const span = maxV - minV + 1;
  if (span > L) return false;

  const internalGaps = span - others.length;
  const jokerCount = jokers.length;
  if (jokerCount < internalGaps) return false;

  const lowMin = Math.max(1, maxV - L + 1);
  const lowMax = Math.min(minV, 13 - L + 1);
  return lowMin <= lowMax;
}

function isValidMeld(cards) {
  if (cards.length === 1) return true;
  return isValidGroup(cards) || isValidRun(cards);
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
  pointValue,
  handTotal,
  hasJoker,
  canCallFaceOff,
  isValidGroup,
  isValidRun,
  isValidMeld,
  dealHands,
  resolveFaceOff,
  resetIdCounter,
  nextId,
};
