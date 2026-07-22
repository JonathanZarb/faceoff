# Face Off

A 2-player online card game. No install step, no external dependencies — just Node.js.

## Running it locally

```
node server.js
```

Then open `http://localhost:3000` in a browser. One player clicks **Create Room** and shares the 4-letter code; the other clicks **Join Room** and enters it. As soon as both are in, the first hand deals automatically.

To let a friend on another network join, you'll need to deploy this somewhere publicly reachable (see below) — `localhost` only works on your own machine.

No `npm install` is required — the whole app (server and browser client) is built on Node's built-in `http` module with zero third-party packages, so it will run anywhere Node.js runs.

## Rules

Standard 52-card deck + 2 Jokers. Point values: A=1, 2–10 = face value, J/Q/K=10, Joker=15.

Each hand, both players are dealt 10 cards. A draw pile and a discard pile sit on the table. On your turn you either:

- **Draw**, then **discard** — draw one card (from the draw pile, or the single card group your opponent discarded last turn — once it's someone else's turn, that group is no longer available), then discard a single card, a same-rank group (e.g. three 7s), or a same-suit run of 3+ (e.g. 4-5-6 of hearts). Jokers are wild in melds.
- **Call "Face Off"** instead of drawing — only allowed if your hand totals 10 points or less and you hold no Joker. Both hands are revealed: if your total is strictly lower, you win the hand. A tie, or a higher total, means you lose (the caller loses ties).

Scoring carries across hands in a match: the loser of each hand adds their hand's point total to their running score (a Joker still in hand counts as 15). If you call Face Off and lose, you also eat a 20-point penalty on top. First player to reach 100 points loses the match.

These two numbers — 100-point match target and the 20-point miscall penalty — are the easiest things to tune if you want a faster or slower match. They live at the top of `rooms.js` (`MATCH_TARGET`, `ASSAF_PENALTY`).

## Project layout

- `gameLogic.js` — pure game rules: deck, dealing, meld validation, scoring. No I/O.
- `rooms.js` — in-memory room/session manager: turn state machine, the "only last turn's discard is takeable" rule, scoring, match progression.
- `server.js` — plain HTTP server: serves the browser client and a small JSON API.
- `public/` — the browser client (HTML/CSS/vanilla JS), polls the server every 1.5s for updates.
- `test/` — automated tests (`node --test` for unit tests, plus `node test/e2e.js` and `node test/simulate-match.js` for scripted end-to-end / full-match simulations).

Run all unit tests with:

```
npm test
```

## Deploying so you and your friend can actually play

This needs a host that can keep a small Node process running (not a static-file host) — Render, Railway, Fly.io, and similar all have free tiers that work well for this. The general steps on any of them:

1. Push this folder to a GitHub repo (or use the host's CLI to deploy a local folder directly).
2. Create a new "Web Service" pointing at it.
3. Start command: `node server.js`. No build step needed.
4. The host sets a `PORT` environment variable automatically — the server already reads `process.env.PORT`, so nothing to configure there.

Once deployed you'll get a public URL — send that to your friend instead of `localhost`.
