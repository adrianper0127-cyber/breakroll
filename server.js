import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { newSecretSeed, commitmentOf } from './lib/fair.js';
import { replay, rowSummary } from './lib/engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'sessions.json');
const MAX_BODY = 512 * 1024;
const MAX_ROW = 2000;
const MAX_QUEUE = 200;

const ADMIN_KEY = process.env.ADMIN_KEY || crypto.randomBytes(9).toString('base64url');
if (!process.env.ADMIN_KEY) {
  console.log(`\n  No ADMIN_KEY set. Temporary key for this boot:\n\n      ${ADMIN_KEY}\n`);
  console.log('  Set ADMIN_KEY in your Railway variables to keep it stable.\n');
}

// ---------------------------------------------------------------- storage

/** @type {Map<string, any>} */
const sessions = new Map();

async function load() {
  try {
    for (const s of JSON.parse(await fsp.readFile(DATA_FILE, 'utf8'))) sessions.set(s.id, s);
    console.log(`Loaded ${sessions.size} break(s).`);
  } catch { /* first run */ }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(DATA_FILE, JSON.stringify([...sessions.values()].slice(-100), null, 2));
    } catch (err) {
      console.error('Could not save:', err.message);
    }
  }, 250);
}

// ---------------------------------------------------------------- helpers

const json = (res, code, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
};
const fail = (res, code, message) => json(res, code, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Request too large.')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('Body was not valid JSON.')); }
    });
    req.on('error', reject);
  });
}

const keyMatches = (k) =>
  typeof k === 'string' && k.length === ADMIN_KEY.length &&
  crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));

const authed = (req) => keyMatches(req.headers['x-admin-key']);
const shortId = () => crypto.randomBytes(4).toString('hex');

/** Live view: rows rebuilt from the seed, seed hidden until reveal. */
function view(s) {
  const { rowState, batches } = replay(s);
  return {
    id: s.id,
    title: s.title,
    publicSeed: s.publicSeed,
    commitment: s.commitment,
    secretSeed: s.revealedAt ? s.secretSeed : null,
    revealedAt: s.revealedAt,
    createdAt: s.createdAt,
    rows: rowSummary(rowState),
    left: rowState.reduce((n, r) => n + r.left.length, 0),
    total: rowState.reduce((n, r) => n + r.total, 0),
    batches,
    chasePrizes: s.chasePrizes,
  };
}

// ---------------------------------------------------------------- api

async function api(req, res, url) {
  const seg = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method;

  if (seg[0] === 'session' && method === 'POST') {
    const { key } = await readBody(req);
    return keyMatches(String(key || ''))
      ? json(res, 200, { ok: true })
      : fail(res, 401, 'That key does not match.');
  }

  if (seg[0] === 'breaks' && seg.length === 2 && method === 'GET') {
    const s = sessions.get(seg[1]);
    if (!s) return fail(res, 404, 'No break with that link.');
    return json(res, 200, view(s));
  }

  if (!authed(req)) return fail(res, 401, 'Admin key required.');

  if (seg[0] === 'breaks' && seg.length === 1) {
    if (method === 'GET') {
      return json(res, 200, {
        breaks: [...sessions.values()]
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 40)
          .map((s) => ({
            id: s.id, title: s.title, createdAt: s.createdAt,
            batches: s.batches.length, revealedAt: s.revealedAt,
          })),
      });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const rowsIn = Array.isArray(body.rows) ? body.rows : [];
      if (!rowsIn.length) return fail(res, 400, 'Add at least one row.');
      if (rowsIn.length > 12) return fail(res, 400, 'Twelve rows is the maximum.');

      const rows = [];
      rowsIn.forEach((r, i) => {
        const total = Math.trunc(Number(r.total));
        if (!Number.isFinite(total) || total < 1 || total > MAX_ROW) {
          throw new Error(`Row ${i + 1} needs a card count between 1 and ${MAX_ROW}.`);
        }
        rows.push({
          id: 'r' + (i + 1),
          name: String(r.name || `Row ${i + 1}`).trim().slice(0, 24) || `Row ${i + 1}`,
          total,
        });
      });

      const secretSeed = newSecretSeed();
      const s = {
        id: shortId(),
        title: String(body.title || '').trim().slice(0, 80) || 'Untitled break',
        publicSeed: String(body.publicSeed || '').trim().slice(0, 120) ||
          new Date().toISOString().slice(0, 16).replace('T', ' '),
        secretSeed,
        commitment: commitmentOf(secretSeed),
        createdAt: Date.now(),
        revealedAt: null,
        rows,
        nonceCounter: 0,
        batches: [],
        chasePrizes: (Array.isArray(body.chasePrizes) ? body.chasePrizes : [])
          .map((p) => String(p).trim().slice(0, 40)).filter(Boolean).slice(0, 40),
      };
      sessions.set(s.id, s);
      save();
      return json(res, 201, view(s));
    }
  }

  if (seg[0] === 'breaks' && seg.length >= 2) {
    const s = sessions.get(seg[1]);
    if (!s) return fail(res, 404, 'No break with that link.');
    const action = seg[2];

    if (!action && method === 'DELETE') {
      sessions.delete(s.id);
      save();
      return json(res, 200, { ok: true });
    }

    if (action === 'reveal' && method === 'POST') {
      if (!s.revealedAt) { s.revealedAt = Date.now(); save(); }
      return json(res, 200, view(s));
    }

    if (s.revealedAt) return fail(res, 409, 'This break is sealed. Start a new one to keep drawing.');

    // Run a queue. items is a flat list of row ids, one per card.
    if (action === 'draws' && method === 'POST') {
      const body = await readBody(req);
      const mode = body.mode === 'sequential' ? 'sequential' : 'random';
      const items = (Array.isArray(body.items) ? body.items : []).map(String);
      if (!items.length) return fail(res, 400, 'The queue is empty.');
      if (items.length > MAX_QUEUE) return fail(res, 400, `Keep a run under ${MAX_QUEUE} cards.`);
      for (const id of items) {
        if (!s.rows.some((r) => r.id === id)) return fail(res, 400, 'That row is not in this break.');
      }

      // Consecutive cards from one row become a single batch, so sequential
      // runs come out as one clean strip of numbers.
      const groups = [];
      for (const id of items) {
        const last = groups[groups.length - 1];
        if (last && last.rowId === id) last.count += 1;
        else groups.push({ rowId: id, count: 1 });
      }

      const before = s.batches.length;
      for (const g of groups) {
        s.nonceCounter += 1;
        s.batches.push({ nonce: s.nonceCounter, rowId: g.rowId, mode, count: g.count, at: Date.now(), marks: {} });
      }

      let out;
      try {
        out = view(s);
      } catch (err) {
        s.batches.length = before;
        return fail(res, 400, err.message);
      }

      const drawn = out.batches.slice(before);
      if (drawn.every((b) => b.cards.length === 0)) {
        s.batches.length = before;
        return fail(res, 400, 'That row is empty.');
      }
      save();
      return json(res, 200, { batches: drawn, break: out });
    }

    if (action === 'undo' && method === 'POST') {
      if (!s.batches.length) return fail(res, 400, 'Nothing to undo.');
      s.batches.pop();
      save();
      return json(res, 200, view(s));
    }

    // Tag a drawn card with the buyer who won it, and optionally a chase prize.
    if (action === 'mark' && method === 'POST') {
      const body = await readBody(req);
      const batch = s.batches.find((b) => b.nonce === Number(body.nonce));
      if (!batch) return fail(res, 404, 'No draw with that number.');
      const idx = Math.trunc(Number(body.index));
      if (!Number.isInteger(idx) || idx < 0 || idx >= batch.count) {
        return fail(res, 400, 'That card is not in this draw.');
      }
      const buyer = String(body.buyer || '').trim().slice(0, 40);
      const prize = String(body.prize || '').trim().slice(0, 40);
      if (!buyer && !prize) delete batch.marks[idx];
      else batch.marks[idx] = { buyer, prize };
      save();
      return json(res, 200, view(s));
    }
  }

  return fail(res, 404, 'Unknown endpoint.');
}

// ---------------------------------------------------------------- static

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!path.extname(rel)) rel += '.html';
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Nope.');
  fs.readFile(file, (err, data) => {
    if (err) return fail(res, 404, 'Page not found.');
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true, breaks: sessions.size });

  if (url.pathname.startsWith('/api/')) {
    try { await api(req, res, url); }
    catch (err) { if (!res.headersSent) fail(res, 400, err.message || 'Something went wrong.'); }
    return;
  }
  if (req.method !== 'GET') return fail(res, 405, 'Method not allowed.');
  serveStatic(res, url.pathname);
});

await load();
server.listen(PORT, () => console.log(`Breakroll on http://localhost:${PORT}`));
