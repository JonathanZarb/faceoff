'use strict';
/**
 * Head-to-head (H2H) record keeping.
 *
 * Players are identified by NAME (trimmed, case-insensitive) - there are no
 * accounts - so a pair like "Jonathan" + "Alex" shares one running total no
 * matter which browser or device either of them plays from.
 *
 * A record only ever counts upward (matches won, hands won, per player), which
 * makes merging trivially safe: take the larger count for each player.
 *
 * Durability, best to least:
 *   1. A Redis-compatible REST key/value store (Upstash etc.), enabled by the
 *      env vars UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the
 *      KV_REST_API_URL / KV_REST_API_TOKEN names). Survives restarts and
 *      redeploys, readable from any browser, forever.
 *   2. A JSON file, if H2H_FILE is set (works on a host with a persistent disk).
 *   3. In-memory only (what you get with no configuration). Lost whenever the
 *      server restarts - though browsers also keep a backup copy and re-submit
 *      it when they join a room, which restores most of it.
 *
 * Uses only Node built-ins (global fetch needs Node 18+, which package.json
 * already requires).
 */
const fs = require('fs');
const path = require('path');

const MAX_NAME_LEN = 20;
// Names players get when they leave the box blank. A "Player 1 vs Player 2"
// record would silently pool together completely different people, so those
// games just aren't tracked.
const PLACEHOLDER_NAMES = new Set(['', 'player', 'player 1', 'player 2', 'you', 'opponent']);

function normName(name) {
  return String(name == null ? '' : name)
    .replace(/[|\u0000-\u001f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .slice(0, MAX_NAME_LEN);
}

// Returns { pairKey, keys: [kA, kB] } for two display names, or null when this
// pairing can't be tracked (placeholder names, or both players share a name).
function pairFor(nameA, nameB) {
  const a = normName(nameA);
  const b = normName(nameB);
  if (PLACEHOLDER_NAMES.has(a) || PLACEHOLDER_NAMES.has(b) || a === b) return null;
  const keys = [a, b].sort();
  return { pairKey: keys.join('|'), keys };
}

function emptyRecord() {
  return { names: {}, matches: {}, hands: {} };
}

function sanitizeCount(n) {
  const v = Math.floor(Number(n));
  return Number.isFinite(v) && v > 0 ? Math.min(v, 1e9) : 0;
}

// Only keeps fields belonging to the two players of this pair, with clean
// numbers - so a browser backup can never smuggle in anything unexpected.
function cleanRecord(rec, keys) {
  const out = emptyRecord();
  if (!rec || typeof rec !== 'object') return out;
  for (const k of keys) {
    out.matches[k] = sanitizeCount(rec.matches && rec.matches[k]);
    out.hands[k] = sanitizeCount(rec.hands && rec.hands[k]);
    const display = rec.names && rec.names[k];
    if (typeof display === 'string') out.names[k] = display.slice(0, MAX_NAME_LEN);
  }
  return out;
}

function mergeRecords(a, b, keys) {
  const x = cleanRecord(a, keys);
  const y = cleanRecord(b, keys);
  const out = emptyRecord();
  for (const k of keys) {
    out.matches[k] = Math.max(x.matches[k], y.matches[k]);
    out.hands[k] = Math.max(x.hands[k], y.hands[k]);
    out.names[k] = y.names[k] || x.names[k] || k;
  }
  return out;
}

function cloneRecord(rec) {
  return JSON.parse(JSON.stringify(rec));
}

// ---------- storage backends ----------
function memoryBackend() {
  const map = new Map();
  return {
    name: 'memory',
    durable: false,
    async get(key) {
      return map.has(key) ? map.get(key) : null;
    },
    async set(key, value) {
      map.set(key, value);
    },
  };
}

function fileBackend(file) {
  let data = null;
  function ensureLoaded() {
    if (data) return;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    } catch (e) {
      data = {};
    }
  }
  return {
    name: 'file',
    durable: true,
    async get(key) {
      ensureLoaded();
      return data[key] || null;
    },
    async set(key, value) {
      ensureLoaded();
      data[key] = value;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    },
  };
}

function restBackend(url, token) {
  const base = url.replace(/\/+$/, '');
  async function command(args) {
    const res = await fetch(base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args),
    });
    if (!res.ok) throw new Error(`KV store responded ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(body.error);
    return body.result;
  }
  return {
    name: 'rest-kv',
    durable: true,
    async get(key) {
      const raw = await command(['GET', key]);
      if (!raw) return null;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },
    async set(key, value) {
      await command(['SET', key, JSON.stringify(value)]);
    },
  };
}

function backendFromEnv(env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (url && token) return restBackend(url, token);
  if (env.H2H_FILE) return fileBackend(env.H2H_FILE);
  return memoryBackend();
}

let backend = backendFromEnv(process.env);
const cache = new Map(); // pairKey -> record (authoritative while the process lives)
const loading = new Map(); // pairKey -> in-flight load promise

function setBackend(b) {
  backend = b;
  cache.clear();
  loading.clear();
}

function storageKey(pairKey) {
  return `faceoff:h2h:${pairKey}`;
}

// Loads the stored record for a pair (once - afterwards served from the
// cache), folding in any browser-held backup copies that were handed in.
// Never rejects: a flaky store just degrades to "whatever we already have".
async function load(pair, backups) {
  const { pairKey, keys } = pair;
  let promise = loading.get(pairKey);
  if (!promise) {
    promise = (async () => {
      let stored = null;
      try {
        stored = await backend.get(storageKey(pairKey));
      } catch (e) {
        console.error('H2H load failed:', e.message);
      }
      return mergeRecords(cache.get(pairKey), stored, keys);
    })();
    loading.set(pairKey, promise);
  }
  const base = await promise;
  let merged = base;
  for (const b of backups || []) merged = mergeRecords(merged, b, keys);
  const prior = cache.get(pairKey);
  if (prior) merged = mergeRecords(prior, merged, keys);
  cache.set(pairKey, merged);
  return merged;
}

async function save(pair, record) {
  const { pairKey, keys } = pair;
  const merged = mergeRecords(cache.get(pairKey), record, keys);
  cache.set(pairKey, merged);
  try {
    await backend.set(storageKey(pairKey), merged);
  } catch (e) {
    console.error('H2H save failed:', e.message);
  }
  return merged;
}

module.exports = {
  normName,
  pairFor,
  emptyRecord,
  cleanRecord,
  mergeRecords,
  cloneRecord,
  load,
  save,
  setBackend,
  memoryBackend,
  fileBackend,
  restBackend,
  backendFromEnv,
  getBackendInfo: () => ({ name: backend.name, durable: backend.durable }),
};
