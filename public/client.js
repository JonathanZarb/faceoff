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
    lastSeenDrawAt: undefined, // dedupe key for the draw-pickup/opponent-draw-toast triggers
    pickupHideTimer: null,
    drawToastHideTimer: null,
    order: [], // the player's own left-to-right card arrangement (card ids)
    dragging: false, // a card is being dragged - hold off re-rendering the hand
    pendingView: null, // latest server view that arrived mid-drag
    suppressClick: false,
    shownScores: null, // what the scoreboard currently displays (see displayedScores)
    celebrationKey: null, // which match's exact-hit celebration has already played
    celebrateTimer: null,
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

  // Browser-held backup copy of head-to-head records (pairKey -> record). Sent
  // to the server when joining a room, so a server that forgot them (free
  // hosting restarts) gets them back.
  function loadH2hBackup() {
    try {
      const raw = JSON.parse(localStorage.getItem('faceoff_h2h') || '{}');
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    } catch (e) {
      return {};
    }
  }
  function saveH2hBackup(all) {
    try {
      localStorage.setItem('faceoff_h2h', JSON.stringify(all));
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
      body: JSON.stringify({ name, h2hBackup: loadH2hBackup() }),
    });
  }

  async function joinRoom(code, name) {
    return api(`/api/rooms/${encodeURIComponent(code)}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, h2hBackup: loadH2hBackup() }),
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

  // ---------- draw pickup display + opponent draw notice ----------
  function cardMiniHtml(card) {
    if (card.rank === 'JOKER') return '<span class="card-mini joker">★</span>';
    const red = RED_SUITS.has(card.suit);
    return `<span class="card-mini${red ? ' red' : ''}">${card.rank}${SUIT_SYMBOL[card.suit] || ''}</span>`;
  }

  // Fires exactly once per new draw (dedup'd on the server-stamped timestamp,
  // and seeded rather than replayed on a fresh page load/resume): shows a
  // large "you drew this" display for your own draws, or a small notice for
  // the opponent's, so both players always know a draw happened and - for
  // discard-pile draws, which were already public - exactly which card.
  function handleDrawReveal(view, hand) {
    const ld = hand.lastDraw;

    if (!ld) {
      state.lastSeenDrawAt = null;
      return;
    }

    if (state.lastSeenDrawAt === undefined) {
      // First render this session - don't replay a stale draw from before we loaded.
      state.lastSeenDrawAt = ld.at;
      return;
    }

    if (ld.at === state.lastSeenDrawAt) return; // already reacted to this one
    state.lastSeenDrawAt = ld.at;

    if (ld.playerId === view.you) {
      if (ld.card) showMyPickup(ld.card);
    } else {
      showOpponentDrawToast(ld);
    }
  }

  function showMyPickup(card) {
    const overlay = $('overlay-pickup');
    const slot = $('pickup-card-slot');
    const label = $('pickup-label');
    label.textContent = 'You drew';
    slot.innerHTML = '';
    slot.appendChild(cardFaceEl(card, { clickable: false }));

    // Restart the entrance/settle animation even if this fires again quickly.
    overlay.classList.remove('hidden');
    slot.style.animation = 'none';
    label.style.animation = 'none';
    void overlay.offsetWidth;
    slot.style.animation = '';
    label.style.animation = '';

    clearTimeout(state.pickupHideTimer);
    state.pickupHideTimer = setTimeout(() => {
      overlay.classList.add('hidden');
    }, 2000);
  }

  function showOpponentDrawToast(ld) {
    const el = $('draw-toast');
    const name = ld.playerName || 'Opponent';
    if (ld.source === 'discard' && ld.card) {
      el.innerHTML = `${escapeHtml(name)} picked up from the discard pile: ${cardMiniHtml(ld.card)}`;
    } else {
      el.textContent = `${name} drew from the draw pile`;
    }
    el.classList.remove('hidden');
    clearTimeout(state.drawToastHideTimer);
    state.drawToastHideTimer = setTimeout(() => {
      el.classList.add('hidden');
    }, 2500);
  }

  // ---------- render ----------
  let currentState = null;

  // Scores as they should be SHOWN right now. While a Face Off result is
  // waiting to be revealed (countdown still running, or the reveal not yet on
  // screen) this hand's points are held back, so the scoreboard behind the
  // overlays can't give away who won before the reveal does.
  function displayedScores(view) {
    const scores = Object.assign({}, view.scores);
    const result = view.hand && view.hand.result;
    if (result && !state.revealSequenceDone) {
      scores[result.callerId] = (scores[result.callerId] || 0) - (result.callerDelta || 0);
      scores[result.opponentId] = (scores[result.opponentId] || 0) - (result.opponentDelta || 0);
    }
    return scores;
  }

  function renderScores(view) {
    const opp = view.players.find((p) => p.id !== view.you);
    const shown = displayedScores(view);
    const mine = shown[view.you] || 0;
    const theirs = opp ? shown[opp.id] || 0 : 0;
    $('my-score').textContent = mine;
    $('opp-score').textContent = theirs;

    const prev = state.shownScores;
    if (prev) {
      if (mine !== prev.mine) bump($('my-score-box'));
      if (theirs !== prev.theirs) bump($('opp-score-box'));
    }
    state.shownScores = { mine, theirs };
  }

  function bump(box) {
    if (!box) return;
    box.classList.remove('score-bump');
    void box.offsetWidth;
    box.classList.add('score-bump');
  }

  function renderModeHeader(view) {
    const exact = view.mode === 'exact';
    $('mt-label-1').textContent = exact ? 'Hit exactly' : 'First to';
    $('match-target-val').textContent = view.matchTarget;
    $('mt-label-2').textContent = exact ? 'to win · over loses' : 'loses';
  }

  // ---------- head-to-head ----------
  // The record shown is the "before" snapshot until this hand's result has
  // been revealed, so the H2H can't spoil the winner either.
  function h2hShown(view) {
    const h = view.h2h;
    if (!h || !h.tracked) return null;
    if (view.hand && view.hand.result && !state.revealSequenceDone && h.before) return h.before;
    return h.current;
  }

  // Subtle head-to-head tally tucked under each player's name: matches won
  // against each other (hands won is in the tooltip).
  function renderH2hBadge(view) {
    const rec = h2hShown(view);
    const mine = $('my-h2h');
    const theirs = $('opp-h2h');
    if (!rec) {
      mine.classList.add('hidden');
      theirs.classList.add('hidden');
      return;
    }
    const fill = (el, side) => {
      el.classList.remove('hidden');
      el.textContent = `H2H ${side.matches}`;
      el.title = `Head-to-head vs ${side === rec.you ? rec.opp.name : rec.you.name}: ${side.matches} match${side.matches === 1 ? '' : 'es'} won, ${side.hands} hand${side.hands === 1 ? '' : 's'} won`;
    };
    fill(mine, rec.you);
    fill(theirs, rec.opp);
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Keep a browser-side backup copy of each pair's record, so it can be
  // restored on the server if the server ever forgets it.
  function syncH2hBackup(view) {
    const h = view.h2h;
    if (!h || !h.tracked || !h.sync) return;
    const all = loadH2hBackup();
    const prev = all[h.pairKey];
    const merged = { names: Object.assign({}, prev && prev.names, h.sync.names), matches: {}, hands: {} };
    ['matches', 'hands'].forEach((field) => {
      const keys = new Set([...Object.keys((prev && prev[field]) || {}), ...Object.keys(h.sync[field] || {})]);
      keys.forEach((k) => {
        merged[field][k] = Math.max((prev && prev[field] && prev[field][k]) || 0, h.sync[field][k] || 0);
      });
    });
    if (JSON.stringify(prev) !== JSON.stringify(merged)) {
      all[h.pairKey] = merged;
      saveH2hBackup(all);
    }
  }

  // ---------- lobby / game setup ----------
  const TARGET_PRESETS = { classic: [50, 100, 150, 200], exact: [30, 50, 75, 100] };

  function modeSummary(mode, target) {
    return mode === 'exact'
      ? `Land on exactly <b>${target}</b> points to win the match. Go past ${target} and you lose.`
      : `The first player to reach <b>${target}</b> points loses the match.`;
  }

  function renderLobby(view) {
    const opp = view.players.find((p) => p.id !== view.you);
    const host = view.players.find((p) => p.seat === 1);
    const ready = view.phase === 'setup';
    const editable = view.isHost;

    $('lobby-title').textContent = !ready ? 'Waiting for your friend…' : editable ? 'Choose a game mode' : `${host ? host.name : 'The host'} is choosing the game mode…`;
    $('room-code-display').textContent = view.code;
    // Once both players are in, the code is just a small reminder.
    $('lobby-code-block').classList.toggle('hidden', ready);

    const panel = $('settings-panel');
    panel.classList.toggle('readonly', !editable);
    $('mode-cards').classList.toggle('readonly', !editable);
    document.querySelectorAll('.mode-card').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.mode === view.mode);
      btn.onclick = editable ? () => doAction(() => sendAction('updateSettings', { mode: btn.dataset.mode })) : null;
    });

    const input = $('target-input');
    if (document.activeElement !== input) input.value = view.matchTarget;
    input.disabled = !editable;
    input.onchange = () => {
      const v = parseInt(input.value, 10);
      if (Number.isFinite(v)) doAction(() => sendAction('updateSettings', { mode: view.mode, target: v }));
    };

    const presets = $('target-presets');
    presets.innerHTML = '';
    (TARGET_PRESETS[view.mode] || []).forEach((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = String(t);
      b.classList.toggle('active', t === view.matchTarget);
      if (editable) b.onclick = () => doAction(() => sendAction('updateSettings', { mode: view.mode, target: t }));
      presets.appendChild(b);
    });

    $('mode-summary').innerHTML = modeSummary(view.mode, view.matchTarget);
    $('settings-note').textContent = editable ? '' : 'Only the host can change the game mode.';

    const h = h2hShown(view);
    const lobbyH2h = $('lobby-h2h');
    if (ready && h) {
      lobbyH2h.classList.remove('hidden');
      lobbyH2h.innerHTML =
        `<div class="h2h-sub">Head-to-head record</div>` +
        `<div class="h2h-score">${escapeHtml(h.you.name)} ${h.you.matches} &ndash; ${h.opp.matches} ${escapeHtml(h.opp.name)}</div>` +
        `<div class="h2h-sub">matches won &middot; hands won ${h.you.hands}&ndash;${h.opp.hands}</div>`;
    } else if (ready) {
      lobbyH2h.classList.remove('hidden');
      lobbyH2h.innerHTML = `<div class="h2h-sub">Head-to-head isn't tracked for this pairing &mdash; both players need their own distinct name (set on the home screen).</div>`;
    } else {
      lobbyH2h.classList.add('hidden');
    }

    const start = $('btn-start-game');
    start.classList.toggle('hidden', !editable);
    start.disabled = !(editable && ready);
    start.onclick = () => doAction(() => sendAction('startGame'));
    $('start-hint').textContent = !ready
      ? editable
        ? 'You can pick the game mode now — Start unlocks when your friend joins.'
        : ''
      : editable
        ? `${opp ? opp.name : 'Your friend'} is in. Start when you're ready.`
        : `Waiting for ${host ? host.name : 'the host'} to start the game…`;
  }

  function resetRoundUi() {
    state.revealSequenceActive = false;
    state.revealSequenceDone = false;
    state.shownScores = null;
    state.celebrationKey = null;
    $('overlay-countdown').classList.add('hidden');
    $('overlay-reveal').classList.add('hidden');
    stopCelebration();
    $('overlay-celebrate').classList.add('hidden');
  }

  function render(view) {
    // Don't rebuild the hand out from under a card the player is mid-drag on.
    if (state.dragging) {
      state.pendingView = view;
      return;
    }
    currentState = view;
    syncH2hBackup(view);
    const me = view.players.find((p) => p.id === view.you);
    const opp = view.players.find((p) => p.id !== view.you);

    $('my-name').textContent = me ? me.name : 'You';
    $('opp-name').textContent = opp ? opp.name : 'Opponent';
    renderModeHeader(view);
    updateOpponentConnection(opp);

    if (view.phase === 'waiting' || view.phase === 'setup') {
      resetRoundUi();
      renderLobby(view);
      showScreen('screen-waiting');
      startLobbyMusic();
      return;
    }
    stopLobbyMusic();

    showScreen('screen-game');
    const hand = view.hand;
    if (!hand) return;

    renderScores(view);
    renderH2hBadge(view);
    handleDrawReveal(view, hand);

    // opponent card backs
    const backs = $('opp-card-backs');
    backs.innerHTML = '';
    for (let i = 0; i < hand.opponentCardCount; i++) {
      const b = document.createElement('div');
      b.className = 'card card-back';
      backs.appendChild(b);
    }

    // turn indicator - both a prominent banner and a pulsing highlight around
    // whoever's score box it currently is, so whose turn it is never has to
    // be inferred from button states alone.
    const ti = $('turn-indicator');
    const myBox = $('my-score-box');
    const oppBox = $('opp-score-box');
    if (view.phase === 'playing') {
      if (hand.isMyTurn) {
        ti.textContent = '▶ YOUR TURN';
        ti.classList.remove('waiting');
        ti.classList.add('mine');
        if (myBox) myBox.classList.add('active-turn');
        if (oppBox) oppBox.classList.remove('active-turn');
      } else {
        ti.textContent = `Waiting for ${opp ? opp.name : 'opponent'}…`;
        ti.classList.add('waiting');
        ti.classList.remove('mine');
        if (myBox) myBox.classList.remove('active-turn');
        if (oppBox) oppBox.classList.add('active-turn');
      }
    } else {
      ti.textContent = '';
      ti.classList.remove('mine', 'waiting');
      if (myBox) myBox.classList.remove('active-turn');
      if (oppBox) oppBox.classList.remove('active-turn');
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

    // Take back: only the discarder ever sees anything about a pending
    // discard, and even they just get this button - no cards are shown to
    // anyone until the discarder draws and the discard becomes public.
    const tb = $('btn-takeback');
    const canTakeBack = view.phase === 'playing' && !!hand.canTakeBack;
    tb.classList.toggle('invisible', !canTakeBack);
    tb.tabIndex = canTakeBack ? 0 : -1;
    tb.onclick = canTakeBack ? () => doAction(() => sendAction('takeBack')) : null;

    // my hand
    const canDiscard = view.phase === 'playing' && hand.isMyTurn && hand.turnPhase === 'await_discard';
    const handEl = $('my-hand');
    handEl.innerHTML = '';
    // prune selection to cards still present
    const presentIds = new Set(hand.myHand.map((c) => c.id));
    for (const id of Array.from(state.selected)) if (!presentIds.has(id)) state.selected.delete(id);

    // Cards just discarded keep their slot in my custom order, so a take-back
    // drops them back exactly where they were.
    const heldIds = new Set((hand.pendingDiscard || []).map((c) => c.id));
    const arranged = arrangedHand(hand.myHand, heldIds);
    const displayHand = state.autoSort ? sortedHand(hand.myHand) : arranged;
    displayHand.forEach((card) => {
      const selected = state.selected.has(card.id);
      const el = cardFaceEl(card, { clickable: true, selected });
      el.classList.remove('unclickable');
      el.tabIndex = 0;
      el.onclick = () => {
        if (state.suppressClick) return;
        if (!canDiscard) return;
        if (state.selected.has(card.id)) state.selected.delete(card.id);
        else state.selected.add(card.id);
        render(currentState);
      };
      attachCardDrag(el, card);
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

    $('btn-sort').classList.toggle('active', state.autoSort);
    $('btn-sort').setAttribute('aria-pressed', state.autoSort ? 'true' : 'false');
    $('btn-sort').onclick = () => {
      // Auto-arrange only changes what's displayed - state.order (the dealt /
      // hand-arranged order) is untouched, so turning it off goes straight
      // back to the cards as they were before.
      state.autoSort = !state.autoSort;
      saveArrangement();
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
      resetRoundUi();
    }
  }

  function turnPlayerName(view) {
    const p = view.players.find((x) => x.id === view.hand.turnPlayerId);
    return p ? p.name : 'Opponent';
  }

  // ---------- custom hand arrangement (drag to reorder) ----------
  // state.order is the player's own left-to-right ordering of card ids.
  function arrangedHand(myHand, holdIds) {
    const byId = new Map(myHand.map((c) => [c.id, c]));
    const out = [];
    const seen = new Set();
    const nextOrder = [];
    for (const id of state.order) {
      if (byId.has(id)) {
        out.push(byId.get(id));
        seen.add(id);
        nextOrder.push(id);
      } else if (holdIds && holdIds.has(id)) {
        nextOrder.push(id); // away for the moment (just discarded) - hold its slot
      }
    }
    for (const c of myHand) {
      if (!seen.has(c.id)) {
        out.push(c); // newly drawn / dealt cards go on the end
        nextOrder.push(c.id);
      }
    }
    state.order = nextOrder;
    return out;
  }

  function saveArrangement() {
    try {
      localStorage.setItem(
        'faceoff_arrange',
        JSON.stringify({ code: state.code, order: state.order, autoSort: state.autoSort })
      );
    } catch (e) {
      /* best effort */
    }
  }

  function loadArrangement(code) {
    try {
      const raw = JSON.parse(localStorage.getItem('faceoff_arrange') || 'null');
      if (raw && raw.code === code) {
        if (Array.isArray(raw.order)) state.order = raw.order.filter((x) => typeof x === 'string' || typeof x === 'number');
        state.autoSort = !!raw.autoSort;
      }
    } catch (e) {
      /* ignore */
    }
  }

  function moveCard(cardId, targetIndexAmongOthers) {
    const ids = Array.from($('my-hand').querySelectorAll('.card')).map((el) => el.dataset.id);
    const without = ids.filter((id) => id !== String(cardId));
    without.splice(Math.max(0, Math.min(targetIndexAmongOthers, without.length)), 0, String(cardId));
    // ids in the DOM are strings; map back to the real (possibly numeric) ids
    const real = new Map(currentState.hand.myHand.map((c) => [String(c.id), c.id]));
    const reordered = without.map((id) => (real.has(id) ? real.get(id) : id));
    // keep any held-away ids (just discarded) where they were
    const held = state.order.filter((id) => !real.has(String(id)));
    state.order = reordered.concat(held);
    state.autoSort = false;
    saveArrangement();
  }

  function attachCardDrag(el, card) {
    el.addEventListener('keydown', (e) => {
      if (!(e.shiftKey || e.altKey)) return;
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const ids = Array.from($('my-hand').querySelectorAll('.card')).map((x) => x.dataset.id);
      const idx = ids.indexOf(String(card.id));
      const target = e.key === 'ArrowLeft' ? idx - 1 : idx + 1;
      if (target < 0 || target >= ids.length) return;
      if (state.autoSort) state.order = sortedHand(currentState.hand.myHand).map((c) => c.id);
      moveCard(card.id, target);
      render(currentState);
      const again = $('my-hand').querySelector(`.card[data-id="${CSS.escape(String(card.id))}"]`);
      if (again) again.focus();
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const handEl = $('my-hand');
      let dragging = false;
      let ghost = null;
      let indicator = null;
      let insertAt = null;
      let grabDX = 0;
      let grabDY = 0;

      const others = () => Array.from(handEl.querySelectorAll('.card')).filter((x) => x !== el);

      function updateTarget(px, py) {
        const list = others();
        if (!list.length) return;
        let best = null;
        let bestDist = Infinity;
        list.forEach((c, i) => {
          const r = c.getBoundingClientRect();
          const cx = r.left + r.width / 2;
          const cy = r.top + r.height / 2;
          const d = Math.hypot(px - cx, (py - cy) * 1.4); // rows matter a bit more than columns
          if (d < bestDist) {
            bestDist = d;
            best = { i, r, before: px < cx };
          }
        });
        insertAt = best.before ? best.i : best.i + 1;
        const hostRect = handEl.getBoundingClientRect();
        const x = (best.before ? best.r.left : best.r.right) - hostRect.left + (best.before ? -4 : 4);
        indicator.style.left = `${x - 2}px`;
        indicator.style.top = `${best.r.top - hostRect.top}px`;
        indicator.style.height = `${best.r.height}px`;
      }

      function begin(ev) {
        dragging = true;
        state.dragging = true;
        document.body.classList.add('dragging-cards');
        const r = el.getBoundingClientRect();
        grabDX = startX - r.left;
        grabDY = startY - r.top;
        ghost = el.cloneNode(true);
        ghost.classList.add('drag-ghost');
        ghost.classList.remove('selected', 'drag-origin');
        ghost.style.width = `${r.width}px`;
        ghost.style.height = `${r.height}px`;
        document.body.appendChild(ghost);
        el.classList.add('drag-origin');
        indicator = document.createElement('div');
        indicator.className = 'drop-indicator';
        handEl.appendChild(indicator);
        move(ev);
      }

      function move(ev) {
        ghost.style.left = `${ev.clientX - grabDX}px`;
        ghost.style.top = `${ev.clientY - grabDY}px`;
        updateTarget(ev.clientX, ev.clientY);
      }

      function onMove(ev) {
        if (!dragging) {
          if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
          begin(ev);
          return;
        }
        ev.preventDefault();
        move(ev);
      }

      function end() {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
        if (!dragging) return; // a plain click - the onclick handler deals with it
        document.body.classList.remove('dragging-cards');
        if (ghost) ghost.remove();
        if (indicator) indicator.remove();
        el.classList.remove('drag-origin');
        // The click that browsers fire after a drag must not toggle selection.
        state.suppressClick = true;
        setTimeout(() => {
          state.suppressClick = false;
        }, 0);
        const view = state.pendingView || currentState;
        state.pendingView = null;
        state.dragging = false;
        if (insertAt !== null) {
          if (state.autoSort) state.order = sortedHand(view.hand.myHand).map((c) => c.id);
          moveCard(card.id, insertAt);
        }
        render(view);
      }

      window.addEventListener('pointermove', onMove, { passive: false });
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
    });
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

  // ---------- exact-target celebration (confetti, fireworks, fanfare) ----------
  let celebrateRaf = null;
  let celebrateParticles = [];
  let celebrateStopAt = 0;
  let celebrateBurstTimer = null;
  const CONFETTI_COLORS = ['#ffd24a', '#f7f3ea', '#c0392b', '#ffe9a3', '#e8b923', '#ffffff', '#ff7a59'];

  function playFanfare(big) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    const t0 = ctx.currentTime + 0.05;
    const tone = (freq, start, dur, type, peak) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + dur + 0.05);
    };
    if (big) {
      // Rising trumpet-ish run, then a held, bright major chord.
      [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => {
        tone(f, t0 + i * 0.11, 0.34, 'sawtooth', 0.09);
        tone(f * 2, t0 + i * 0.11, 0.2, 'triangle', 0.04);
      });
      const chordAt = t0 + 0.62;
      [523.25, 659.25, 783.99, 1046.5, 1568.0].forEach((f) => tone(f, chordAt, 1.6, 'sawtooth', 0.07));
      [130.81, 196.0].forEach((f) => tone(f, chordAt, 1.6, 'triangle', 0.16));
      // sparkly shimmer on top
      for (let i = 0; i < 10; i++) tone(2093 + (i % 4) * 330, chordAt + 0.2 + i * 0.09, 0.25, 'sine', 0.03);
      // Firework thumps
      [0.7, 1.35, 2.0, 2.7, 3.4].forEach((d) => playThump(ctx, t0 + d, 90, 0.35, 0.5));
    } else {
      // Softer, wistful two-note sting for the player who was just beaten to it.
      tone(392.0, t0, 0.5, 'triangle', 0.08);
      tone(329.63, t0 + 0.28, 0.9, 'triangle', 0.08);
      playThump(ctx, t0 + 0.9, 70, 0.4, 0.4);
    }
  }

  function spawnBurst(w, h, count) {
    const x = w * (0.15 + Math.random() * 0.7);
    const y = h * (0.12 + Math.random() * 0.4);
    const hue = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.2;
      const speed = 2 + Math.random() * 5;
      celebrateParticles.push({
        kind: 'spark', x, y,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        life: 1, decay: 0.012 + Math.random() * 0.012, color: hue, size: 2 + Math.random() * 2,
      });
    }
  }

  function spawnConfetti(w, count) {
    for (let i = 0; i < count; i++) {
      celebrateParticles.push({
        kind: 'confetti',
        x: Math.random() * w, y: -20 - Math.random() * 200,
        vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 0.3,
        w: 6 + Math.random() * 8, h: 10 + Math.random() * 10,
        color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
        life: 1, decay: 0.0025,
      });
    }
  }

  function startCelebration(big) {
    stopCelebration();
    const canvas = $('confetti-canvas');
    const ctx2d = canvas.getContext('2d');
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      canvas.width = window.innerWidth * dpr;
      canvas.height = window.innerHeight * dpr;
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    celebrateParticles = [];
    celebrateStopAt = performance.now() + (big ? 9000 : 3500);
    const w = () => window.innerWidth;
    const h = () => window.innerHeight;

    const volley = () => {
      spawnConfetti(w(), reduce ? 20 : big ? 90 : 25);
    };
    volley();
    spawnBurst(w(), h(), reduce ? 12 : 36);
    celebrateBurstTimer = setInterval(() => {
      if (performance.now() > celebrateStopAt) return;
      spawnBurst(w(), h(), reduce ? 10 : big ? 40 : 18);
      if (big) volley();
    }, big ? 600 : 1200);

    const frame = () => {
      ctx2d.clearRect(0, 0, w(), h());
      const live = [];
      for (const p of celebrateParticles) {
        if (p.kind === 'confetti') {
          p.vy += 0.03;
          p.x += p.vx + Math.sin(p.y / 40) * 0.6;
          p.y += p.vy;
          p.rot += p.vr;
          p.life -= p.decay;
          ctx2d.save();
          ctx2d.translate(p.x, p.y);
          ctx2d.rotate(p.rot);
          ctx2d.fillStyle = p.color;
          ctx2d.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
          ctx2d.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
          ctx2d.restore();
          if (p.y < h() + 40 && p.life > 0) live.push(p);
        } else {
          p.vy += 0.05;
          p.vx *= 0.985;
          p.x += p.vx;
          p.y += p.vy;
          p.life -= p.decay;
          ctx2d.globalAlpha = Math.max(0, p.life);
          ctx2d.fillStyle = p.color;
          ctx2d.beginPath();
          ctx2d.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx2d.fill();
          if (p.life > 0) live.push(p);
        }
      }
      ctx2d.globalAlpha = 1;
      celebrateParticles = live;
      if (live.length || performance.now() < celebrateStopAt) celebrateRaf = requestAnimationFrame(frame);
      else celebrateRaf = null;
    };
    celebrateRaf = requestAnimationFrame(frame);
  }

  function stopCelebration() {
    if (celebrateRaf) cancelAnimationFrame(celebrateRaf);
    celebrateRaf = null;
    clearInterval(celebrateBurstTimer);
    celebrateBurstTimer = null;
    celebrateParticles = [];
    clearTimeout(state.celebrateTimer);
  }

  // Shown after the hand's winner has been revealed, when someone landed on
  // the target score exactly. Both players see it; the player who hit it gets
  // the full fireworks treatment.
  function showExactCelebration(view) {
    const iWon = view.matchWinnerId === view.you;
    const winner = view.players.find((p) => p.id === view.matchWinnerId);
    const overlay = $('overlay-celebrate');
    overlay.classList.toggle('opp-won', !iWon);
    $('celebrate-kicker').textContent = iWon ? 'Perfect score' : 'Dead on target';
    $('celebrate-number').textContent = String(view.matchTarget);
    $('celebrate-title').textContent = iWon ? 'EXACTLY! YOU WIN!' : `${winner ? winner.name : 'Opponent'} hit it EXACTLY!`;
    $('celebrate-sub').textContent = iWon
      ? `You landed on ${view.matchTarget} on the nose. Absolute precision — the match is yours!`
      : `${winner ? winner.name : 'Your opponent'} landed on ${view.matchTarget} exactly and takes the match.`;
    overlay.classList.remove('hidden');
    const content = $('celebrate-content');
    content.style.animation = 'none';
    void content.offsetWidth;
    content.style.animation = '';
    playFanfare(iWon);
    startCelebration(iWon);
    $('btn-celebrate-continue').onclick = () => {
      stopCelebration();
      overlay.classList.add('hidden');
    };
  }

  function maybeCelebrate(view) {
    if (view.phase !== 'match_over' || view.matchEndReason !== 'exact') return;
    const key = `${view.code}:${view.matchWinnerId}:${JSON.stringify(view.scores)}`;
    if (state.celebrationKey === key) return;
    state.celebrationKey = key;
    // Let the hand's winner land first, then the big moment.
    clearTimeout(state.celebrateTimer);
    state.celebrateTimer = setTimeout(() => showExactCelebration(view), 1800);
  }

  function renderReveal(view) {
    const hand = view.hand;
    const result = hand && hand.result;
    if (!result) return;

    const me = view.players.find((p) => p.id === view.you);
    const opp = view.players.find((p) => p.id !== view.you);

    $('overlay-countdown').classList.add('hidden');
    $('overlay-reveal').classList.remove('hidden');

    // The winner is now on screen, so the scoreboard and H2H may finally update.
    renderScores(view);
    renderH2hBadge(view);

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
    else if (result.callerWins) reasonText = `${escapeHtml(result.callerName)} called Face Off with the lower hand.`;
    else reasonText = `${escapeHtml(result.callerName)} called Face Off but did not have the lower hand.`;

    $('reveal-detail').innerHTML = `
      ${reasonText}<br/>
      ${me ? escapeHtml(me.name) : 'You'} ${myDelta > 0 ? `+${myDelta} pts` : 'no penalty'} &middot;
      ${opp ? escapeHtml(opp.name) : 'Opponent'} ${oppDelta > 0 ? `+${oppDelta} pts` : 'no penalty'}
    `;

    const btnNext = $('btn-next-hand');
    const btnNewMatch = $('btn-new-match');
    const matchDetail = $('reveal-matchover-detail');

    if (view.phase === 'match_over') {
      const matchWon = view.matchWinnerId === view.you;
      const winnerP = view.players.find((p) => p.id === view.matchWinnerId);
      const loserP = view.players.find((p) => p.id !== view.matchWinnerId);
      $('reveal-title').textContent = matchWon ? 'You won the match!' : 'You lost the match';
      let why;
      if (view.matchEndReason === 'exact') {
        why = `<span class="big">${winnerP ? escapeHtml(winnerP.name) : 'Winner'} hit ${view.matchTarget} exactly!</span>`;
      } else if (view.matchEndReason === 'bust') {
        why = `<span class="big">${loserP ? escapeHtml(loserP.name) : 'A player'} went over ${view.matchTarget}!</span>`;
      } else {
        why = `<span class="big">${loserP ? escapeHtml(loserP.name) : 'A player'} reached ${view.matchTarget}.</span>`;
      }
      matchDetail.classList.remove('hidden');
      matchDetail.innerHTML = `${why}Final score &mdash; ${me ? escapeHtml(me.name) : 'You'}: ${view.scores[view.you] || 0} pts,
        ${opp ? escapeHtml(opp.name) : 'Opponent'}: ${opp ? view.scores[opp.id] || 0 : 0} pts.`;
      btnNext.classList.add('hidden');
      btnNewMatch.classList.remove('hidden');
      btnNewMatch.onclick = () => doAction(() => sendAction('newMatch'));
      maybeCelebrate(view);
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
    loadArrangement(code);
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
    loadArrangement(saved.code);
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
