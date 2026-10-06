# Face Off

A 2-player online card game. No install step, no external dependencies — just Node.js.

## Running it locally

```
node server.js
```

Then open `http://localhost:3000` in a browser. One player clicks **Create Room** and shares the 4-letter code; the other clicks **Join Room** and enters it. Once both are in, the host picks a **game mode** on the setup screen and presses **Start Game** (see below).

To let a friend on another network join, you'll need to deploy this somewhere publicly reachable (see below) — `localhost` only works on your own machine.

No `npm install` is required — the whole app (server and browser client) is built on Node's built-in `http` module with zero third-party packages, so it will run anywhere Node.js runs.

## Rules

Standard 52-card deck + 2 Jokers. Point values: A=1, 2–10 = face value, J/Q/K=10, Joker=15.

Each hand, both players are dealt 10 cards. A draw pile and a discard pile sit on the table. On your turn you either:

- **Discard**, then **draw** — discard a single card, a same-rank group (e.g. three 7s), or a same-suit run of 3+ (e.g. 4-5-6 of hearts; Aces run both low, A-2-3, and high through the corner, Q-K-A-2 style — K and A are adjacent). Jokers are wild in melds and, when used to fill a gap in a run, are displayed in that exact slot (e.g. 5, JOKER, 7). Then draw one card to finish your turn (from the draw pile, or the single card group your opponent just discarded — once it's someone else's turn, that group is no longer available).
- **Call "Face Off"** instead of discarding — only allowed if your hand totals 10 points or less and you hold no Joker. Both hands are revealed: if your total is strictly lower, you win the hand. A tie, or a higher total, means you lose (the caller loses ties).

### Game modes

Picked by the host on the setup screen before the match starts (and again before each new match). The target score is adjustable (10–500).

- **Classic** — the first player to reach the target score **loses** (default target 100).
- **Exact Target** — land on the target score **exactly** to win the match; go over it and you lose (default target 50). Hitting it exactly triggers a full-screen celebration (confetti, fireworks, fanfare) for both players.

### Other features

- **Take back a discard** — if you discard by mistake, a *Take back* button sits next to your discard until you pick up from either pile. Your opponent can see the discarded cards the whole time.
- **Arrange your hand** — drag cards left/right to put them in any order (works with mouse and touch; Shift+←/→ moves a focused card). *Auto-arrange* sorts them for you.
- **Head-to-head record** — each pair of player names keeps a running total of matches and hands won against each other (see *Head-to-head storage* below). Scores and H2H only update once the hand's winner has been revealed.

Scoring carries across hands in a match: the loser of each hand adds their hand's point total to their running score (a Joker still in hand counts as 15). If you call Face Off and lose, you also eat a 25-point penalty on top. First player to reach 100 points loses the match. Who starts alternates every hand (including into a new match), and every hand is dealt from a freshly shuffled deck.

These two numbers — 100-point match target and the 25-point miscall penalty — are the easiest things to tune if you want a faster or slower match. They live at the top of `rooms.js` (`MATCH_TARGET`, `ASSAF_PENALTY`).

## Project layout

- `gameLogic.js` — pure game rules: deck, dealing, meld validation, scoring. No I/O.
- `h2h.js` — head-to-head record keeping (name-keyed, with memory / file / Redis-REST storage backends).
- `rooms.js` — in-memory room/session manager: turn state machine, the "only last turn's discard is takeable" rule, scoring, match progression.
- `server.js` — plain HTTP server: serves the browser client and a small JSON API.
- `public/` — the browser client (HTML/CSS/vanilla JS), polls the server every 1.5s for updates.
- `test/` — automated tests (`node --test` for unit tests, plus `node test/e2e.js` and `node test/simulate-match.js` for scripted end-to-end / full-match simulations).

Run all unit tests with:

```
npm test
```

## Head-to-head storage

Players are matched by **name** (case-insensitive; blank/"Player 1"/"Player 2" names and identical names aren't tracked). Records only ever count upward, so merging is always safe.

Where it's stored depends on configuration:

1. **Redis-compatible REST store (recommended for a free host, survives restarts and redeploys, works from any browser):** set the environment variables `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the `KV_REST_API_URL` / `KV_REST_API_TOKEN` names also work). A free Upstash Redis database is enough.
2. **JSON file:** set `H2H_FILE=/path/to/h2h.json` (needs a host with a persistent disk).
3. **Nothing configured:** kept in server memory only. Free hosts like Render wipe that on every restart/redeploy — but every browser also keeps a backup copy of its records and re-submits it when it joins a room, which restores the record in most cases.

## Deploying so you and your friend can actually play

This needs a host that can keep a small Node process running (not a static-file host) — Render, Railway, Fly.io, and similar all have free tiers that work well for this. The general steps on any of them:

1. Push this folder to a GitHub repo (or use the host's CLI to deploy a local folder directly).
2. Create a new "Web Service" pointing at it.
3. Start command: `node server.js`. No build step needed.
4. The host sets a `PORT` environment variable automatically — the server already reads `process.env.PORT`, so nothing to configure there.

Once deployed you'll get a public URL — send that to your friend instead of `localhost`.
