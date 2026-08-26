// Independent replay. Every card below is recomputed here from the revealed
// seed — the server's stored results are only used for comparison.

const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const sha256Hex = async (text) => hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

function stream(key, publicSeed, nonce) {
  let counter = 0, block = new Uint8Array(0), offset = 0;
  return async function next(n) {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      if (offset >= block.length) {
        block = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${publicSeed}|${nonce}|${counter}`)));
        counter += 1; offset = 0;
      }
      const take = Math.min(n - written, block.length - offset);
      out.set(block.subarray(offset, offset + take), written);
      written += take; offset += take;
    }
    return out;
  };
}

async function uniformBelow(next, max) {
  if (max <= 1) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const v = new DataView((await next(4)).buffer).getUint32(0, false);
    if (v < limit) return v % max;
  }
}

/** Mirrors lib/engine.js exactly. */
async function replay(brk, key) {
  const rows = new Map(brk.rows.map((r) => [r.id, {
    total: r.total,
    left: Array.from({ length: r.total }, (_, i) => i + 1),
    cursor: 1,
  }]));

  const out = [];
  for (const batch of brk.batches) {
    const row = rows.get(batch.rowId);
    const want = Math.min(batch.count, row.left.length);
    const cards = [];

    if (batch.mode === 'sequential') {
      let guard = 0;
      while (cards.length < want && guard <= row.total * 2) {
        guard += 1;
        const at = row.left.indexOf(row.cursor);
        if (at !== -1) { cards.push(row.cursor); row.left.splice(at, 1); }
        row.cursor = row.cursor >= row.total ? 1 : row.cursor + 1;
      }
    } else {
      const next = stream(key, brk.publicSeed, batch.nonce);
      for (let i = 0; i < want; i++) {
        const at = await uniformBelow(next, row.left.length);
        cards.push(row.left[at]);
        row.left.splice(at, 1);
      }
      if (cards.length) {
        const last = cards[cards.length - 1];
        row.cursor = last >= row.total ? 1 : last + 1;
      }
    }
    out.push({ batch, cards });
  }
  return out;
}

function say(text, kind = 'bad') {
  $('msg').innerHTML = text ? `<div class="notice ${kind}">${esc(text)}</div>` : '';
}

async function run() {
  const id = $('bid').value.trim();
  $('out').innerHTML = '';
  if (!id) return say('Enter the break ID from the seller.');
  say('');

  let brk;
  try {
    brk = await (await fetch('/api/breaks/' + encodeURIComponent(id))).json();
    if (brk.error) throw new Error(brk.error);
  } catch (err) { return say(err.message || 'Could not load that break.'); }

  const head = `<div class="panel">
      <h2 style="font-size:19px">${esc(brk.title)}</h2>
      <p class="seal" style="margin:10px 0 0">Public seed: ${esc(brk.publicSeed)}<br>
      Published fingerprint <b>${esc(brk.commitment)}</b></p>
    </div>`;

  if (!brk.secretSeed) {
    $('out').innerHTML = head + `<p class="empty">Still sealed. The seller has not revealed the seed yet, so the draws can't be replayed — but the fingerprint above is already locked to whatever the results turn out to be.</p>`;
    return;
  }

  const fingerprint = await sha256Hex(brk.secretSeed);
  const sealOk = fingerprint === brk.commitment;
  const key = await hmacKey(brk.secretSeed);
  const replayed = await replay(brk, key);

  let mismatches = 0;
  const rowName = (rid) => (brk.rows.find((r) => r.id === rid) || {}).name || rid;

  const rows = replayed.map(({ batch, cards }) => {
    const ok = cards.join(',') === batch.cards.join(',');
    if (!ok) mismatches += 1;
    return `<div class="hrow${ok ? '' : ' chase'}">
        <span class="hno">#${batch.nonce}</span>
        <span class="hrowname">${esc(rowName(batch.rowId))}</span>
        <span class="hcard">${cards.join(', ') || '—'}</span>
        <span class="hwho">${batch.mode === 'random' ? 'random' : 'seq'}${ok ? '' : ' · MISMATCH'}</span>
      </div>`;
  }).join('');

  const allOk = sealOk && mismatches === 0;
  $('out').innerHTML = head +
    `<div class="notice ${allOk ? 'good' : 'bad'}">${
      allOk
        ? `Checked. The revealed seed matches the published fingerprint, and all ${replayed.length} draws replayed here to exactly the results that were shown on stream.`
        : sealOk
          ? `The seed matches the fingerprint, but ${mismatches} draw${mismatches === 1 ? '' : 's'} did not replay to the stored result.`
          : 'The revealed seed does not hash to the published fingerprint. Do not trust these results.'
    }</div>` +
    `<div class="panel"><p class="seal" style="margin:0">Revealed seed <b class="revealed">${esc(brk.secretSeed)}</b></p></div>` +
    `<div class="panel"><div class="panel-title"><span class="eyebrow">Replayed draws — computed in your browser</span></div>
      <div class="hist">${rows}</div></div>`;
}

$('go').onclick = run;
$('bid').onkeydown = (e) => { if (e.key === 'Enter') run(); };
const pre = new URLSearchParams(location.search).get('b');
if (pre) { $('bid').value = pre; run(); }
