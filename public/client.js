'use strict';
(function () {
  const SUIT_SYMBOL = { H: '♥', D: '♦', C: '♣', S: '♠' };
  const RED_SUITS = new Set(['H', 'D']);
  const RANK_ORDER = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const POLL_MS = 1500;
  const RECONNECT_FLASH_MS = 2000;

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
  };

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
      return;
    }

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

    // overlays
    if (view.phase === 'hand_over' && hand.result) {
      renderHandOver(view, hand.result, me, opp);
    } else {
      $('overlay-handover').classList.add('hidden');
    }

    if (view.phase === 'match_over') {
      renderMatchOver(view, me, opp);
    } else {
      $('overlay-matchover').classList.add('hidden');
    }
  }

  function renderHandOver(view, result, me, opp) {
    $('overlay-matchover').classList.add('hidden');
    $('overlay-handover').classList.remove('hidden');
    const iAmCaller = result.callerId === view.you;
    const iWon = iAmCaller ? result.callerWins : !result.callerWins;

    $('handover-title').textContent = iWon ? 'You win the hand!' : 'You lose the hand';

    let reasonText;
    if (result.reason === 'tie_caller_loses') reasonText = 'Tied hands — the caller loses ties.';
    else if (result.callerWins) reasonText = `${result.callerName} called Face Off with the lower hand.`;
    else reasonText = `${result.callerName} called Face Off but did not have the lower hand.`;

    $('handover-detail').innerHTML = `
      <span class="big">${result.callerName}: ${result.callerTotal} pts &nbsp;|&nbsp; ${result.opponentName}: ${result.opponentTotal} pts</span>
      ${reasonText}<br/>
      ${result.callerName} ${result.callerDelta > 0 ? `+${result.callerDelta} pts` : 'no penalty'} &middot;
      ${result.opponentName} ${result.opponentDelta > 0 ? `+${result.opponentDelta} pts` : 'no penalty'}
    `;

    $('btn-next-hand').onclick = () => doAction(() => sendAction('nextHand'));
  }

  function renderMatchOver(view, me, opp) {
    $('overlay-handover').classList.add('hidden');
    $('overlay-matchover').classList.remove('hidden');
    const iWon = view.matchWinnerId === view.you;
    $('matchover-title').textContent = iWon ? 'You won the match!' : 'You lost the match';
    $('matchover-detail').innerHTML = `Final score &mdash; ${me ? me.name : 'You'}: ${view.scores[view.you] || 0} pts,
      ${opp ? opp.name : 'Opponent'}: ${opp ? view.scores[opp.id] || 0 : 0} pts.`;
    $('btn-new-match').onclick = () => doAction(() => sendAction('newMatch'));
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
