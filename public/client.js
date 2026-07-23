'use strict';
(function () {
  const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
  const RED_SUITS = new Set(['H', 'D']);
  const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const POLL_MS = 1500;
  const RECONNECT_FLASH_MS = 2000;
  const COUNTDOWN_BEATS = 3; // 3 heartbeat thumps over 3 seconds, synced to 3-2-1

  const state = {
    code: null,
    playerId: null,
    token: null,
    selected: new Set(),
    pollTimer: null,
    lastPhase: null,
    lastResultShown: null,
    autoSort: false,
    oppWasConnected: undefined, // undefined until we've seen a real reading
    reconnectFlashTimer: null,
    revealSequenceActive: false, // countdown+heartbeat currently playing
    revealSequenceDone: false, // sequence already played for the current result
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function sortKey(card) {
    if (card.rank === 'JOKER') return 100; // Jokers always sort to the right
    return RANK_ORDER.indexOf(card.rank);
  }

  function sortedHand(hand) {
    return hand
      .slice()
      .sort((a, b) => sortKey(a) - sortKey(b) || (a.suit || '').localeCompare(b.suit || ''));
  }

  const $ = (id) => document.getElementById(id);

  // ---------- persistence (best-effort; app works fine without it) ----------
  function saveSession() {
    try {
      localStorage.setItem(
        'faceoff_session',
        JSON.stringify({ code: state.code, playerId: state.playerId, token: state.token })
      );
    } catch (e) {
      /* ignore */
    }
  }
  function loadSession() {
    try {
      const raw = localStorage.getItem('faceoff_session');
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function clearSession() {
    try {
      localStorage.removeItem('faceoff_session');
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- API ----------
  async function api(path, opts) {
    const res = await fetch(path, opts);
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  async function createRoom(name) {
    return api('/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async function joinRoom(code, name) {
    return api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async function fetchState() {
    const q = new URLSearchParams({ playerId: state.playerId, token: state.token });
    return api(`/api/rooms/${state.code}/state?${q.toString()}`);
  }

  async function sendAction(type, extra) {
    return api(`/api/rooms/${state.code}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ playerId: state.playerId, token: state.token, type, ...(extra || {}) }),
    });
  }

  // ---------- screens ----------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
    $(id).classList.remove('hidden');
  }

  function showError(msg) {
    const el = $('game-error');
    if (el && !el.classList.contains('hidden') === false) {
      el.textContent = msg;
      el.classList.remove('hidden');
      clearTimeout(showError._t);
      showError._t = setTimeout(() => el.classList.add('hidden'), 3500);
    }
  }

  function landingError(msg) {
    $('landing-error').textContent = msg || '';
  }

  // ---------- card rendering ----------
  function cardFaceEl(card, { clickable, selected } = {}) {
    const el = document.createElement('div');
    el.className = 'card card-face';
    el.dataset.id = card.id;
    if (card.rank === 'JOKER') {
      el.classList.add('joker');
      el.innerHTML = '<div>★</div><div>JOKER</div>';
    } else {
      if (RED_SUITS.has(card.suit)) el.classList.add('red');
      el.innerHTML = `<div class="rank">${card.rank}</div><div class="suit">${SUIT_SYMBOL[card.suit]}</div>`;
    }
    if (clickable) el.classList.add('clickable');
    else el.classList.add('unclickable');
    if (selected) el.classList.add('selected');
    return el;
  }

  function pointValueOf(card) {
    if (card.rank === 'JOKER') return 15;
    if (card.rank === 'A') return 1;
    if (['J', 'Q', 'K'].includes(card.rank)) return 10;
    return parseInt(card.rank, 10);
  }

  // ---------- heartbeat sound (synthesized, no external asset) ----------
  let audioCtx = null;
  function getAudioCtx() {
    if (audioCtx) return audioCtx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = Ctx ? new Ctx() : null;
    } catch (e) {
      audioCtx = null;
    }
    return audioCtx;
  }

  function playThump(ctx, startTime, freq, duration, peakGain) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.03);
  }

  // A low "lub-dub" thump repeated once per second, in sync with the 3-2-1
  // visual countdown. Purely synthesized so no audio file is needed.
  function playHeartbeatSequence(beats) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const now = ctx.currentTime;
    for (let i = 0; i < beats; i++) {
      const t = now + i * 1.0;
      playThump(ctx, t, 58, 0.16, 0.9); // "lub" - strong, low
      playThump(ctx, t + 0.18, 44, 0.22, 0.55); // "dub" - lower, softer
    }
  }

  // On some browsers the audio context can only truly wake up on a direct
  // user gesture. This is a cheap safety net: if it's still suspended by the
  // time the player next clicks anywhere, try again.
  document.addEventListener(
    'click',
    () => {
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    },
    { passive: true }
  );

  // ---------- lobby "elevator music" (synthesized, no external asset) ----------
  // A soft, looping smooth-jazz-ish I-vi-ii-V pad progression with a gentle
  // plucked bass note under each chord. Plays only on the "waiting for your
  // friend" screen.
  const LOBBY_PROGRESSION = [
    { pad: [130.81, 164.81, 196.0, 246.94], bass: 65.41 }, // Cmaj7 / C2
    { pad: [110.0, 130.81, 164.81, 196.0], bass: 55.0 }, // Am7 / A1
    { pad: [146.83, 174.61, 220.0, 261.63], bass: 73.42 }, // Dm7 / D2
    { pad: [98.0, 123.47, 146.83, 174.61], bass: 49.0 }, // G7 / G1
  ];
  const LOBBY_CHORD_SECONDS = 3.2;

  let musicMasterGain = null;
  let musicPlaying = false;
  let musicSchedulerTimer = null;
  let musicNextChordTime = 0;
  let musicChordStep = 0;

  function playLobbyPadChord(ctx, freqs, startTime, duration) {
    freqs.forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.05, startTime + 0.9); // slow, gentle attack
      gain.gain.setValueAtTime(0.05, startTime + duration - 1.0);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(gain);
      gain.connect(musicMasterGain);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.05);
    });
  }

  function playLobbyBassPluck(ctx, freq, startTime) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(0.1, startTime + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.1);
    osc.connect(gain);
    gain.connect(musicMasterGain);
    osc.start(startTime);
    osc.stop(startTime + 1.2);
  }

  function scheduleLobbyMusic() {
    if (!musicPlaying) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    // Keep scheduling a little over one chord ahead of real time.
    while (musicNextChordTime < ctx.currentTime + LOBBY_CHORD_SECONDS * 1.5) {
      const entry = LOBBY_PROGRESSION[musicChordStep % LOBBY_PROGRESSION.length];
      playLobbyPadChord(ctx, entry.pad, musicNextChordTime, LOBBY_CHORD_SECONDS);
      playLobbyBassPluck(ctx, entry.bass, musicNextChordTime);
      musicChordStep += 1;
      musicNextChordTime += LOBBY_CHORD_SECONDS;
    }
    musicSchedulerTimer = setTimeout(scheduleLobbyMusic, 1000);
  }

  function startLobbyMusic() {
    if (musicPlaying) return;
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (!musicMasterGain) {
      musicMasterGain = ctx.createGain();
      musicMasterGain.gain.value = 0.55;
      musicMasterGain.connect(ctx.destination);
    }
    musicPlaying = true;
    musicChordStep = 0;
    musicNextChordTime = ctx.currentTime + 0.15;
    scheduleLobbyMusic();
  }

  function stopLobbyMusic() {
    if (!musicPlaying) return;
    musicPlaying = false;
    clearTimeout(musicSchedulerTimer);
    const ctx = getAudioCtx();
    if (ctx && musicMasterGain) {
      const now = ctx.currentTime;
      musicMasterGain.gain.cancelScheduledValues(now);
      musicMasterGain.gain.setValueAtTime(musicMasterGain.gain.value, now);
      musicMasterGain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
    }
    // Drop the ramped-down node; a fresh one (at full volume) is created
    // next time the lobby music starts.
    musicMasterGain = null;
  }

  // ---------- connection status (opponent going offline / coming back) ----------
  function updateOpponentConnection(opp) {
    const box = $('opp-score-box');
    if (!box) return;

    if (!opp) {
      // No opponent yet (still waiting for them to join) - nothing to show.
      box.classList.remove('disconnected', 'reconnecting');
      state.oppWasConnected = undefined;
      return;
    }

    const connected = opp.connected !== false;
    const wasConnected = state.oppWasConnected;

    if (wasConnected === false && connected === true) {
      // Reconnected: gently flash green for a couple seconds, then settle.
      box.classList.remove('disconnected');
      box.classList.remove('reconnecting');
      void box.offsetWidth; // restart the animation if it's already mid-flash
      box.classList.add('reconnecting');
      clearTimeout(state.reconnectFlashTimer);
      state.reconnectFlashTimer = setTimeout(() => {
        box.classList.remove('reconnecting');
      }, RECONNECT_FLASH_MS);
    } else if (!connected) {
      box.classList.remove('reconnecting');
      box.classList.add('disconnected');
    } else if (!box.classList.contains('reconnecting')) {
      box.classList.remove('disconnected');
    }

    state.oppWasConnected = connected;
  }

  // ---------- render ----------
  let currentState = null;

  function render(view) {
    currentState = view;
    const me = view.players.find((p) => p.id === view.you);
    const opp = view.players.find((p) => p.id !== view.you);

    $('my-name').textContent = me ? me.name : 'You';
    $('opp-name').textContent = opp ? opp.name : 'Opponent';
    $('my-score').textContent = view.scores[view.you] || 0;
    $('opp-score').textContent = opp ? view.scores[opp.id] || 0 : 0;
    $('match-target-val').textContent = view.matchTarget;
    updateOpponentConnection(opp);

    if (view.phase === 'waiting') {
      $('room-code-display').textContent = view.code;
      showScreen('screen-waiting');
      startLobbyMusic();
      return;
    }
    stopLobbyMusic();

    showScreen('screen-game');
    const hand = view.hand;
    if (!hand) return;

    // opponent card backs
    const backs = $('opp-card-backs');
    backs.innerHTML = '';
    for (let i = 0; i < hand.opponentCardCount; i++) {
      const b = document.createElement('div');
      b.className = 'card card-back';
      backs.appendChild(b);
    }

    // turn indicator
    const ti = $('turn-indicator');
    if (view.phase === 'playing') {
      if (hand.isMyTurn) {
        ti.textContent = hand.turnPhase === 'await_discard' ? 'Your turn — discard or call Face Off' : 'Your turn — draw a card';
        ti.classList.remove('waiting');
      } else {
        ti.textContent = `Waiting for ${opp ? opp.name : 'opponent'}…`;
        ti.classList.add('waiting');
      }
    } else {
      ti.textContent = '';
    }

    // draw pile
    const drawPileEl = $('draw-pile');
    const canDraw = view.phase === 'playing' && hand.isMyTurn && hand.turnPhase === 'await_draw';
    drawPileEl.classList.toggle('disabled', !canDraw);
    drawPileEl.onclick = canDraw
      ? () => doAction(() => sendAction('draw', { source: 'deck' }))
      : null;

    // discard pile group
    const discardEl = $('discard-pile');
    discardEl.innerHTML = '';
    hand.discardPile.forEach((card) => {
      const el = cardFaceEl(card, { clickable: canDraw });
      if (canDraw) {
        el.onclick = () => doAction(() => sendAction('draw', { source: 'discard', cardId: card.id }));
      }
      discardEl.appendChild(el);
    });

    // my hand
    const canDiscard = view.phase === 'playing' && hand.isMyTurn && hand.turnPhase === 'await_discard';
    const handEl = $('my-hand');
    handEl.innerHTML = '';
    // prune selection to cards still present
    const presentIds = new Set(hand.myHand.map((c) => c.id));
    for (const id of Array.from(state.selected)) if (!presentIds.has(id)) state.selected.delete(id);

    const displayHand = state.autoSort ? sortedHand(hand.myHand) : hand.myHand;
    displayHand.forEach((card) => {
      const selected = state.selected.has(card.id);
      const el = cardFaceEl(card, { clickable: canDiscard, selected });
      if (canDiscard) {
        el.onclick = () => {
          if (state.selected.has(card.id)) state.selected.delete(card.id);
          else state.selected.add(card.id);
          render(currentState);
        };
      }
      handEl.appendChild(el);
    });

    $('my-total').innerHTML = `Hand total: <b>${hand.myTotal}</b> pts`;

    $('btn-discard').disabled = !(canDiscard && state.selected.size > 0);
    $('btn-discard').onclick = () => {
      const ids = Array.from(state.selected);
      doAction(() => sendAction('discard', { cardIds: ids })).then(() => state.selected.clear());
    };

    $('btn-faceoff').disabled = !(view.phase === 'playing' && hand.canCallFaceOff);
    $('btn-faceoff').onclick = () => doAction(() => sendAction('callFaceOff'));

    $('btn-sort').textContent = `Auto-arrange: ${state.autoSort ? 'On' : 'Off'}`;
    $('btn-sort').classList.toggle('active', state.autoSort);
    $('btn-sort').onclick = () => {
      state.autoSort = !state.autoSort;
      render(currentState);
    };

    // overlays: the dramatic Face Off reveal (countdown + heartbeat, then
    // cards + totals) covers both the hand_over and match_over cases, since
    // the server can jump straight from playing -> match_over when a call
    // also ends the match.
    if ((view.phase === 'hand_over' || view.phase === 'match_over') && hand.result) {
      triggerFaceOffReveal(view);
    } else {
      // Fresh hand dealt (or no room yet) - reset the sequence so the next
      // Face Off call plays the full countdown again.
      state.revealSequenceActive = false;
      state.revealSequenceDone = false;
      $('overlay-countdown').classList.add('hidden');
      $('overlay-reveal').classList.add('hidden');
    }
  }

  function triggerFaceOffReveal(view) {
    if (state.revealSequenceDone) {
      // Sequence already played for this result - just keep the reveal
      // overlay's content fresh (e.g. opponent connection status changed).
      renderReveal(view);
      return;
    }
    if (state.revealSequenceActive) return; // already mid-countdown; don't restart
    state.revealSequenceActive = true;
    runFaceOffSequence();
  }

  async function runFaceOffSequence() {
    $('overlay-reveal').classList.add('hidden');
    const overlay = $('overlay-countdown');
    const num = $('countdown-num');
    overlay.classList.remove('hidden');
    playHeartbeatSequence(COUNTDOWN_BEATS);

    for (let n = COUNTDOWN_BEATS; n >= 1; n--) {
      num.textContent = String(n);
      num.style.animation = 'none';
      void num.offsetWidth; // restart the pulse animation for each tick
      num.style.animation = '';
      await sleep(1000);
    }

    overlay.classList.add('hidden');
    state.revealSequenceActive = false;
    state.revealSequenceDone = true;
    if (currentState) renderReveal(currentState);
  }

  function renderReveal(view) {
    const hand = view.hand;
    const result = hand && hand.result;
    if (!result) return;

    const me = view.players.find((p) => p.id === view.you);
    const opp = view.players.find((p) => p.id !== view.you);

    $('overlay-countdown').classList.add('hidden');
    $('overlay-reveal').classList.remove('hidden');

    const isCallerMe = result.callerId === view.you;
    const myTotal = isCallerMe ? result.callerTotal : result.opponentTotal;
    const oppTotal = isCallerMe ? result.opponentTotal : result.callerTotal;
    const myDelta = isCallerMe ? result.callerDelta : result.opponentDelta;
    const oppDelta = isCallerMe ? result.opponentDelta : result.callerDelta;
    const iWon = isCallerMe ? result.callerWins : !result.callerWins;

    $('reveal-my-name').textContent = `${me ? me.name : 'You'}${isCallerMe ? ' (called Face Off)' : ''}`;
    $('reveal-opp-name').textContent = `${opp ? opp.name : 'Opponent'}${!isCallerMe ? ' (called Face Off)' : ''}`;

    const myCardsEl = $('reveal-my-cards');
    const oppCardsEl = $('reveal-opp-cards');
    myCardsEl.innerHTML = '';
    oppCardsEl.innerHTML = '';

    let delay = 0;
    sortedHand(hand.myHand || []).forEach((card) => {
      const el = cardFaceEl(card, { clickable: false });
      el.style.animationDelay = `${delay}ms`;
      delay += 70;
      myCardsEl.appendChild(el);
    });
    delay = 0;
    sortedHand(hand.opponentHand || []).forEach((card) => {
      const el = cardFaceEl(card, { clickable: false });
      el.style.animationDelay = `${delay}ms`;
      delay += 70;
      oppCardsEl.appendChild(el);
    });

    $('reveal-my-total').textContent = `${myTotal} pts`;
    $('reveal-opp-total').textContent = `${oppTotal} pts`;
    $('reveal-my-total').classList.toggle('winner', iWon);
    $('reveal-opp-total').classList.toggle('winner', !iWon);

    $('reveal-title').textContent = iWon ? 'You win the hand!' : 'You lose the hand';

    let reasonText;
    if (result.reason === 'tie_caller_loses') reasonText = 'Tied hands — the caller loses ties.';
    else if (result.callerWins) reasonText = `${result.callerName} called Face Off with the lower hand.`;
    else reasonText = `${result.callerName} called Face Off but did not have the lower hand.`;

    $('reveal-detail').innerHTML = `
      ${reasonText}<br/>
      ${me ? me.name : 'You'} ${myDelta > 0 ? `+${myDelta} pts` : 'no penalty'} &middot;
      ${opp ? opp.name : 'Opponent'} ${oppDelta > 0 ? `+${oppDelta} pts` : 'no penalty'}
    `;

    const btnNext = $('btn-next-hand');
    const btnNewMatch = $('btn-new-match');
    const matchDetail = $('reveal-matchover-detail');

    if (view.phase === 'match_over') {
      const matchWon = view.matchWinnerId === view.you;
      $('reveal-title').textContent = matchWon ? 'You won the match!' : 'You lost the match';
      matchDetail.classList.remove('hidden');
      matchDetail.innerHTML = `Final score &mdash; ${me ? me.name : 'You'}: ${view.scores[view.you] || 0} pts,
        ${opp ? opp.name : 'Opponent'}: ${opp ? view.scores[opp.id] || 0 : 0} pts.`;
      btnNext.classList.add('hidden');
      btnNewMatch.classList.remove('hidden');
      btnNewMatch.onclick = () => doAction(() => sendAction('newMatch'));
    } else {
      matchDetail.classList.add('hidden');
      btnNewMatch.classList.add('hidden');
      btnNext.classList.remove('hidden');
      btnNext.onclick = () => doAction(() => sendAction('nextHand'));
    }
  }

  // ---------- action wrapper + polling ----------
  async function doAction(fn) {
    try {
      const { state: view } = await fn();
      render(view);
      return view;
    } catch (e) {
      showError(e.message);
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async () => {
      try {
        const { state: view } = await fetchState();
        render(view);
      } catch (e) {
        // transient network hiccup; ignore
      }
    }, POLL_MS);
  }
  function stopPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
  }

  // ---------- boot ----------
  async function enterRoom({ code, playerId, token, view }) {
    state.code = code;
    state.playerId = playerId;
    state.token = token;
    saveSession();
    render(view);
    startPolling();
  }

  $('btn-create').addEventListener('click', async () => {
    landingError('');
    const name = $('name-input').value.trim() || 'Player 1';
    try {
      const res = await createRoom(name);
      await enterRoom({ code: res.code, playerId: res.playerId, token: res.token, view: res.state });
    } catch (e) {
      landingError(e.message);
    }
  });

  $('btn-join').addEventListener('click', async () => {
    landingError('');
    const name = $('name-input').value.trim() || 'Player 2';
    const code = $('join-code-input').value.trim().toUpperCase();
    if (!code) {
      landingError('Enter a room code.');
      return;
    }
    try {
      const res = await joinRoom(code, name);
      await enterRoom({ code: res.code, playerId: res.playerId, token: res.token, view: res.state });
    } catch (e) {
      landingError(e.message);
    }
  });

  // try to resume a session on load
  (async function init() {
    const saved = loadSession();
    if (!saved || !saved.code) {
      showScreen('screen-landing');
      return;
    }
    state.code = saved.code;
    state.playerId = saved.playerId;
    state.token = saved.token;
    try {
      const { state: view } = await fetchState();
      render(view);
      startPolling();
    } catch (e) {
      clearSession();
      showScreen('screen-landing');
    }
  })();
})();
