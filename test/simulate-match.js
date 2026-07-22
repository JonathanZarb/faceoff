'use strict';
/**
 * Plays a full randomized match to completion through the real HTTP API,
 * using simple bot logic: draw from deck, discard a random single card
 * (occasionally try a meld if hand has duplicates), call Face Off whenever
 * eligible. Verifies the match reaches match_over without errors or hangs,
 * exercising draw-pile reshuffles and many hand transitions along the way.
 *
 * Run with: node test/simulate-match.js [numMatches]
 */
const assert = require('node:assert/strict');

async function main() {
  process.env.PORT = '0';
  const server = require('../server.js');
  await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
  const port = server.address().port;
  const base = `http://localhost:${port}`;

  async function post(path, body) {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${json.error}`);
    return json;
  }
  async function get(path) {
    const res = await fetch(base + path);
    const json = await res.json();
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${json.error}`);
    return json;
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  async function playOneMatch(matchIdx) {
    const created = await post('/api/rooms', { name: 'BotA' });
    const code = created.code;
    const joined = await post(`/api/rooms/${code}/join`, { name: 'BotB' });
    const players = {
      a: { id: created.playerId, token: created.token },
      b: { id: joined.playerId, token: joined.token },
    };

    async function stateFor(who) {
      const q = new URLSearchParams({ playerId: players[who].id, token: players[who].token });
      return (await get(`/api/rooms/${code}/state?${q}`)).state;
    }
    async function action(who, type, extra) {
      return post(`/api/rooms/${code}/action`, {
        playerId: players[who].id,
        token: players[who].token,
        type,
        ...(extra || {}),
      });
    }

    let turns = 0;
    const MAX_TURNS = 5000;

    while (turns < MAX_TURNS) {
      turns += 1;
      const sA = await stateFor('a');
      if (sA.phase === 'match_over') {
        return { turns, winner: sA.matchWinnerId === players.a.id ? 'a' : 'b', scores: sA.scores };
      }
      if (sA.phase === 'hand_over') {
        // either player can advance
        await action('a', 'nextHand');
        continue;
      }
      // phase === 'playing'
      const activeWho = sA.hand.turnPlayerId === players.a.id ? 'a' : 'b';
      const s = activeWho === 'a' ? sA : await stateFor('b');

      if (s.hand.canCallFaceOff && Math.random() < 0.9) {
        await action(activeWho, 'callFaceOff');
        continue;
      }

      if (s.hand.turnPhase === 'await_draw') {
        // occasionally take from discard if available, else deck
        const useDiscard = s.hand.discardPile.length > 0 && Math.random() < 0.5;
        if (useDiscard) {
          const c = pick(s.hand.discardPile);
          await action(activeWho, 'draw', { source: 'discard', cardId: c.id });
        } else {
          await action(activeWho, 'draw', { source: 'deck' });
        }
      } else {
        // await_discard: find any valid meld among random samples, else discard 1 random card
        const s2 = await stateFor(activeWho);
        const hand = s2.hand.myHand;
        // try to find a same-rank group first (cheap heuristic)
        const byRank = {};
        for (const c of hand) {
          if (c.rank === 'JOKER') continue;
          (byRank[c.rank] = byRank[c.rank] || []).push(c);
        }
        let group = Object.values(byRank).find((g) => g.length >= 2);
        let cardIds;
        if (group && Math.random() < 0.3) {
          cardIds = group.slice(0, 2).map((c) => c.id);
        } else {
          cardIds = [pick(hand).id];
        }
        await action(activeWho, 'discard', { cardIds });
      }
    }
    throw new Error(`Match ${matchIdx} did not finish within ${MAX_TURNS} turns (possible stall)`);
  }

  const numMatches = parseInt(process.argv[2] || '5', 10);
  for (let i = 0; i < numMatches; i++) {
    const result = await playOneMatch(i);
    console.log(`  match ${i + 1}: winner=${result.winner} turns=${result.turns} scores=${JSON.stringify(result.scores)}`);
    assert.ok(result.winner === 'a' || result.winner === 'b');
  }

  console.log(`\nAll ${numMatches} simulated matches completed without errors.`);
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('SIMULATION FAILED:', err);
  process.exit(1);
});
