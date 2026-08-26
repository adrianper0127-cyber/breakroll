const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let key = localStorage.getItem('br.key') || '';
let brk = null;                 // current break view from the server
let mode = localStorage.getItem('br.mode') === 'sequential' ? 'sequential' : 'random';
let queue = [];                 // row ids, one entry per card
let lastRun = [];               // batches from the most recent run
let fresh = new Set();          // nonces to animate on next paint
let selectedRow = localStorage.getItem('br.row') || null;
let drawing = false;

// ---------------------------------------------------------------- net

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-admin-key': key } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

let msgTimer;
function say(text, kind = 'bad') {
  clearTimeout(msgTimer);
  $('msg').innerHTML = text ? `<div class="notice ${kind}">${esc(text)}</div>` : '';
  if (text) msgTimer = setTimeout(() => ($('msg').innerHTML = ''), 5000);
}

async function copy(text, what) {
  try { await navigator.clipboard.writeText(text); say(`${what} copied.`, 'good'); }
  catch { window.prompt(`Copy ${what}:`, text); }
}

// ---------------------------------------------------------------- sheet

function openSheet(html, wire) {
  $('sheet').innerHTML = html;
  $('scrim').hidden = false;
  if (wire) wire($('sheet'));
  const first = $('sheet').querySelector('input, button');
  if (first && first.tagName === 'INPUT') setTimeout(() => first.select(), 60);
}
const closeSheet = () => { $('scrim').hidden = true; $('sheet').innerHTML = ''; };
$('scrim').onclick = (e) => { if (e.target === $('scrim')) closeSheet(); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

// ---------------------------------------------------------------- routing

function route() {
  $('gate').hidden = !!key;
  $('setup').hidden = !key || !!brk;
  $('console').hidden = !key || !brk;
  $('masthead').hidden = !!brk;
  if (key && !brk) loadRecent();
}

// ---------------------------------------------------------------- setup

let editorRows = [{ name: 'Row 1', total: 200 }, { name: 'Row 2', total: 200 }];

function paintEditor() {
  $('row-editor').innerHTML = editorRows.map((r, i) => `
    <div class="btnrow" style="margin-bottom:8px">
      <input data-k="name" data-i="${i}" value="${esc(r.name)}" style="flex:2 1 120px" aria-label="Row name">
      <input data-k="total" data-i="${i}" type="number" inputmode="numeric" min="1" max="2000"
             value="${r.total}" style="flex:1 1 80px" aria-label="Card count">
      ${editorRows.length > 1 ? `<button class="tiny ghost" data-del="${i}" style="flex:0 0 auto">Remove</button>` : ''}
    </div>`).join('');

  for (const el of $('row-editor').querySelectorAll('input')) {
    el.oninput = () => {
      const r = editorRows[Number(el.dataset.i)];
      r[el.dataset.k] = el.dataset.k === 'total' ? Number(el.value) : el.value;
    };
  }
  for (const el of $('row-editor').querySelectorAll('[data-del]')) {
    el.onclick = () => { editorRows.splice(Number(el.dataset.del), 1); paintEditor(); };
  }
}

$('row-add').onclick = () => {
  if (editorRows.length >= 12) return say('Twelve rows is the maximum.');
  editorRows.push({ name: `Row ${editorRows.length + 1}`, total: 200 });
  paintEditor();
};

$('new-go').onclick = async () => {
  try {
    brk = await call('/api/breaks', {
      method: 'POST',
      body: {
        title: $('new-title').value,
        publicSeed: $('new-seed').value,
        rows: editorRows,
        chasePrizes: $('new-chases').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
      },
    });
    localStorage.setItem('br.break', brk.id);
    queue = []; lastRun = [];
    route(); paint();
  } catch (err) { say(err.message); }
};

async function loadRecent() {
  try {
    const { breaks } = await call('/api/breaks');
    $('recent').innerHTML = !breaks.length ? '' :
      `<div class="panel"><div class="panel-title"><span class="eyebrow">Earlier breaks</span></div>` +
      breaks.map((b) => `<div class="hrow" data-id="${b.id}" style="cursor:pointer">
        <span class="hno">${b.batches}</span><span>${esc(b.title)}</span>
        <span class="hwho">${b.revealedAt ? 'sealed' : 'open'}</span></div>`).join('') + '</div>';
    for (const el of $('recent').querySelectorAll('[data-id]')) {
      el.onclick = async () => {
        try {
          brk = await call(`/api/breaks/${el.dataset.id}`);
          localStorage.setItem('br.break', brk.id);
          queue = []; lastRun = brk.batches.slice(-1);
          route(); paint();
        } catch (err) { say(err.message); }
      };
    }
  } catch (err) {
    if (/key/i.test(err.message)) { key = ''; localStorage.removeItem('br.key'); route(); }
  }
}

// ---------------------------------------------------------------- gate

$('gate-go').onclick = async () => {
  const k = $('gate-key').value.trim();
  if (!k) return say('Enter the admin key.');
  try {
    key = k;
    await call('/api/session', { method: 'POST', body: { key: k } });
    localStorage.setItem('br.key', k);
    say(''); route();
  } catch (err) { key = ''; say(err.message); }
};
$('gate-key').onkeydown = (e) => { if (e.key === 'Enter') $('gate-go').click(); };

// ---------------------------------------------------------------- painting

const rowById = (id) => brk.rows.find((r) => r.id === id);

function paint() {
  $('b-title').textContent = brk.title;
  $('b-count').textContent = `${brk.left}/${brk.total}`;

  paintRows();
  paintSpin();
  paintMode();
  paintQueue();
  paintStage();
  paintHistory();
  paintPrizes();

  const sealed = !!brk.secretSeed;
  $('seal').innerHTML = sealed
    ? `Revealed seed <b class="revealed">${esc(brk.secretSeed)}</b>`
    : `Sealed commitment <b>${esc(brk.commitment)}</b>`;
}

function paintRows() {
  // Default to the first row with cards left, so Spin is usable immediately.
  if (!selectedRow || !brk.rows.some((r) => r.id === selectedRow && r.left > 0)) {
    const firstLive = brk.rows.find((r) => r.left > 0);
    selectedRow = firstLive ? firstLive.id : null;
  }

  $('rows').innerHTML = brk.rows.map((r) => `
    <div class="rowcard${r.left === 0 ? ' spent' : ''}" data-row="${r.id}"
         role="button" tabindex="0" aria-pressed="${r.id === selectedRow}">
      <div class="rowname">${esc(r.name)}</div>
      <div class="rowleft">${r.left}</div>
      <div class="rowtotal">of ${r.total}</div>
      <div class="bar"><i style="width:${(r.left / r.total) * 100}%"></i></div>
    </div>`).join('');

  for (const el of $('rows').querySelectorAll('[data-row]')) {
    const go = () => selectRow(el.dataset.row);
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  }

  $('multidraw').innerHTML = brk.rows.map((r) =>
    `<button class="ghost" data-multi="${r.id}"${r.left === 0 ? ' disabled' : ''}>Multi-draw ${esc(r.name)}</button>`).join('');
  for (const el of $('multidraw').querySelectorAll('[data-multi]')) {
    el.onclick = () => multiSheet(el.dataset.multi);
  }
}

function selectRow(id) {
  if (drawing) return;
  selectedRow = id;
  localStorage.setItem('br.row', id);
  paintRows();
  paintSpin();
}

function paintSpin() {
  const row = selectedRow ? rowById(selectedRow) : null;
  const ready = !!row && row.left > 0 && !brk.secretSeed;
  const btn = $('act-spin');
  btn.disabled = !ready || drawing;
  btn.textContent = drawing ? 'Drawing…'
    : brk.secretSeed ? 'Break sealed'
    : !row ? 'Every row is empty'
    : row.left === 0 ? `${row.name} is empty`
    : `Spin ${row.name}`;
}

function paintMode() {
  $('mode-random').setAttribute('aria-pressed', String(mode === 'random'));
  $('mode-seq').setAttribute('aria-pressed', String(mode === 'sequential'));
  $('modehint').textContent = mode === 'random'
    ? 'Any card still left in the row, picked from the sealed seed.'
    : 'Consecutive card numbers, carrying on from where the row left off.';
}

function setMode(m) {
  mode = m;
  localStorage.setItem('br.mode', m);
  paintMode();
  paintQueue();
}
$('mode-random').onclick = () => setMode('random');
$('mode-seq').onclick = () => setMode('sequential');

function paintQueue() {
  $('queue-panel').hidden = queue.length === 0;
  if (!queue.length) return;
  $('queue-count').textContent = `Queue — ${queue.length} card${queue.length === 1 ? '' : 's'} · ${mode === 'random' ? 'random' : 'sequential'}`;
  $('queue-chips').innerHTML = queue.map((id, i) =>
    `<span class="chip" data-q="${i}">${esc(rowById(id)?.name || id)} <b>✕</b></span>`).join('');
  for (const el of $('queue-chips').querySelectorAll('[data-q]')) {
    el.onclick = () => { queue.splice(Number(el.dataset.q), 1); paintQueue(); };
  }
  $('queue-run').textContent = `Run ${queue.length} draw${queue.length === 1 ? '' : 's'}`;
}
$('queue-clear').onclick = () => { queue = []; paintQueue(); };
$('queue-run').onclick = () => { const items = queue.slice(); queue = []; paintQueue(); drawNow(items); };

function paintStage() {
  const meta = $('stage-meta');
  if (!lastRun.length) {
    meta.innerHTML = '';
    $('stage').innerHTML = '<p class="empty">Nothing drawn yet. Tap a row above.</p>';
    $('stage-hint').hidden = true;
    return;
  }
  const total = lastRun.reduce((n, b) => n + b.cards.length, 0);
  const names = [...new Set(lastRun.map((b) => rowById(b.rowId)?.name || b.rowId))];
  meta.innerHTML =
    `<span class="tag">${esc(names.join(' + '))}</span>` +
    `<span class="tag">${total} card${total === 1 ? '' : 's'}</span>` +
    `<span class="tag">${lastRun[0].mode === 'random' ? 'random' : 'seq'}</span>` +
    `<span class="tag">#${lastRun[0].nonce}${lastRun.length > 1 ? `–${lastRun[lastRun.length - 1].nonce}` : ''}</span>`;

  let html = '<div class="cards">';
  let delay = 0;
  for (const b of lastRun) {
    b.cards.forEach((card, i) => {
      const m = b.marks?.[i];
      const anim = fresh.has(b.nonce) && !reduced();
      html += `<div class="cardno${m?.prize ? ' chase' : ''}${anim ? ' land' : ''}"
        style="animation-delay:${anim ? delay : 0}ms" data-nonce="${b.nonce}" data-idx="${i}" role="button" tabindex="0">
        ${card}${m ? `<span class="who">${esc(m.buyer || m.prize)}${m.buyer && m.prize ? ` · ${esc(m.prize)}` : ''}</span>` : ''}
      </div>`;
      delay += 70;
    });
  }
  $('stage').innerHTML = html + '</div>';
  $('stage-hint').hidden = false;
  fresh.clear();

  for (const el of $('stage').querySelectorAll('[data-nonce]')) {
    const go = () => markSheet(Number(el.dataset.nonce), Number(el.dataset.idx));
    el.onclick = go;
    el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  }
}

function paintHistory() {
  const flat = [];
  for (const b of brk.batches) {
    b.cards.forEach((card, i) => flat.push({ b, card, i, m: b.marks?.[i] }));
  }
  $('hist-panel').hidden = flat.length === 0;
  if (!flat.length) return;
  $('hist-count').textContent = `Draw history — ${flat.length} card${flat.length === 1 ? '' : 's'}`;
  $('act-undo').disabled = !!brk.secretSeed;
  $('hist').innerHTML = flat.reverse().slice(0, 250).map(({ b, card, i, m }) => `
    <div class="hrow${m?.prize ? ' chase' : ''}" data-nonce="${b.nonce}" data-idx="${i}" style="cursor:pointer">
      <span class="hno">#${b.nonce}</span>
      <span class="hrowname">${esc(rowById(b.rowId)?.name || b.rowId)}</span>
      <span class="hcard">Card ${card}</span>
      <span class="hwho">${m ? esc([m.buyer, m.prize].filter(Boolean).join(' · ')) : ''}</span>
    </div>`).join('');
  for (const el of $('hist').querySelectorAll('[data-nonce]')) {
    el.onclick = () => markSheet(Number(el.dataset.nonce), Number(el.dataset.idx));
  }
}

function paintPrizes() {
  const prizes = brk.chasePrizes || [];
  $('prize-panel').hidden = prizes.length === 0;
  if (!prizes.length) return;
  const claimed = new Map();
  for (const b of brk.batches) {
    for (const [i, m] of Object.entries(b.marks || {})) {
      if (m.prize) claimed.set(m.prize, m.buyer || 'pulled');
    }
  }
  $('prize-count').textContent = `Chase prizes — ${prizes.length - claimed.size} left of ${prizes.length}`;
  $('prizes').innerHTML = prizes.map((p) =>
    `<span class="prize${claimed.has(p) ? ' gone' : ''}">${esc(p)}${claimed.has(p) ? ` — ${esc(claimed.get(p))}` : ''}</span>`).join('');
}

// ---------------------------------------------------------------- actions

let busy = false;

async function drawNow(items) {
  if (busy || !items.length) return;
  const row = rowById(items[0]);
  if (row && row.left === 0 && items.every((i) => i === items[0])) return say(`${row.name} is empty.`);

  busy = true;
  drawing = true;
  paintSpin();
  try {
    const { batches, break: b } = await call(`/api/breaks/${brk.id}/draws`, {
      method: 'POST',
      body: { items, mode },
    });
    brk = b;
    lastRun = batches;
    fresh = new Set(batches.map((x) => x.nonce));
    drawing = false;
    paint();
  } catch (err) {
    drawing = false;
    paintSpin();
    say(err.message);
  }
  busy = false;
}

$('act-spin').onclick = () => {
  if (!selectedRow) return say('Pick a row first.');
  drawNow([selectedRow]);
};

function multiSheet(rowId) {
  const row = rowById(rowId);
  openSheet(`
    <div class="eyebrow">Multi-draw</div>
    <h3 style="font-size:20px;margin:4px 0 2px">${esc(row.name)}</h3>
    <p class="hint" style="margin:0 0 6px">${row.left} card${row.left === 1 ? '' : 's'} available · ${mode === 'random' ? 'random' : 'sequential'}</p>
    <div class="stepper">
      <button class="ghost" id="ms-down" aria-label="One fewer">−</button>
      <input id="ms-n" type="number" inputmode="numeric" min="1" max="${row.left}" value="1" aria-label="How many cards">
      <button class="ghost" id="ms-up" aria-label="One more">+</button>
    </div>
    <div class="quick">
      ${[2, 3, 4, 5, 10].filter((n) => n <= row.left).map((n) => `<button class="tiny ghost" data-q="${n}">${n}</button>`).join('')}
      ${row.left > 10 ? `<button class="tiny ghost" data-q="${row.left}">all ${row.left}</button>` : ''}
    </div>
    <button class="primary wide" id="ms-now" style="margin-bottom:8px">Draw now</button>
    <div class="btnrow">
      <button class="ghost" id="ms-queue">Add to queue</button>
      <button class="ghost" id="ms-cancel">Cancel</button>
    </div>`, (el) => {
    const input = el.querySelector('#ms-n');
    const clamp = () => {
      let n = Math.trunc(Number(input.value) || 1);
      input.value = Math.max(1, Math.min(row.left, n));
      return Number(input.value);
    };
    el.querySelector('#ms-down').onclick = () => { input.value = Math.max(1, clamp() - 1); };
    el.querySelector('#ms-up').onclick = () => { input.value = Math.min(row.left, clamp() + 1); };
    for (const q of el.querySelectorAll('[data-q]')) q.onclick = () => { input.value = q.dataset.q; };
    el.querySelector('#ms-now').onclick = () => { const n = clamp(); closeSheet(); drawNow(Array(n).fill(rowId)); };
    el.querySelector('#ms-queue').onclick = () => {
      const n = clamp();
      if (queue.length + n > 200) return say('Keep a run under 200 cards.');
      queue.push(...Array(n).fill(rowId));
      closeSheet(); paintQueue();
    };
    el.querySelector('#ms-cancel').onclick = closeSheet;
  });
}

function markSheet(nonce, idx) {
  const batch = brk.batches.find((b) => b.nonce === nonce);
  if (!batch) return;
  const card = batch.cards[idx];
  const m = batch.marks?.[idx] || {};
  const claimed = new Set();
  for (const b of brk.batches) for (const mk of Object.values(b.marks || {})) if (mk.prize) claimed.add(mk.prize);

  openSheet(`
    <div class="eyebrow">${esc(rowById(batch.rowId)?.name || batch.rowId)} · draw #${nonce}</div>
    <h3 style="font-family:var(--display);font-size:44px;letter-spacing:-0.04em;margin:2px 0 12px">Card ${card}</h3>
    <label class="field">
      <span class="field-name">Winning buyer</span>
      <input id="mk-buyer" value="${esc(m.buyer || '')}" placeholder="ebay username" autocapitalize="none" spellcheck="false">
    </label>
    <label class="field">
      <span class="field-name">Chase prize — optional</span>
      <select id="mk-prize" style="width:100%;background:#120d1e;border:1px solid var(--edge);border-radius:10px;color:var(--chalk);font-family:var(--body);font-size:16px;padding:11px 12px">
        <option value="">No chase</option>
        ${(brk.chasePrizes || []).map((p) =>
          `<option value="${esc(p)}"${m.prize === p ? ' selected' : ''}${claimed.has(p) && m.prize !== p ? ' disabled' : ''}>${esc(p)}${claimed.has(p) && m.prize !== p ? ' — already pulled' : ''}</option>`).join('')}
      </select>
    </label>
    <button class="primary wide" id="mk-save" style="margin-bottom:8px">Save</button>
    <div class="btnrow">
      <button class="ghost" id="mk-clear">Clear tag</button>
      <button class="ghost" id="mk-cancel">Cancel</button>
    </div>`, (el) => {
    const send = async (buyer, prize) => {
      try {
        brk = await call(`/api/breaks/${brk.id}/mark`, { method: 'POST', body: { nonce, index: idx, buyer, prize } });
        closeSheet(); paint();
      } catch (err) { say(err.message); }
    };
    el.querySelector('#mk-save').onclick = () =>
      send(el.querySelector('#mk-buyer').value, el.querySelector('#mk-prize').value);
    el.querySelector('#mk-clear').onclick = () => send('', '');
    el.querySelector('#mk-cancel').onclick = closeSheet;
  });
}

$('act-undo').onclick = async () => {
  const last = brk.batches[brk.batches.length - 1];
  if (!last) return;
  if (!confirm(`Undo draw #${last.nonce} — ${last.cards.length} card${last.cards.length === 1 ? '' : 's'} back into ${rowById(last.rowId)?.name}?`)) return;
  try {
    brk = await call(`/api/breaks/${brk.id}/undo`, { method: 'POST' });
    lastRun = brk.batches.slice(-1);
    paint();
    say('Undone. That draw number is retired and will not be reused.', 'good');
  } catch (err) { say(err.message); }
};

$('act-menu').onclick = () => {
  const sealed = !!brk.secretSeed;
  openSheet(`
    <div class="eyebrow">${esc(brk.title)}</div>
    <p class="seal" style="margin:8px 0 16px">${sealed
      ? `Revealed seed <b class="revealed">${esc(brk.secretSeed)}</b>`
      : `Sealed commitment <b>${esc(brk.commitment)}</b>`}<br>Public seed: ${esc(brk.publicSeed)}</p>
    <button class="ghost wide" id="mn-overlay" style="margin-bottom:8px">Open stream overlay</button>
    <button class="ghost wide" id="mn-verify" style="margin-bottom:8px">Copy verify link</button>
    <button class="ghost wide" id="mn-copy" style="margin-bottom:8px">Copy last draw</button>
    <button class="ghost wide" id="mn-reveal" style="margin-bottom:8px"${sealed ? ' disabled' : ''}>Reveal seed and seal the break</button>
    <div class="btnrow">
      <button class="ghost" id="mn-close">Close break</button>
      <button class="ghost" id="mn-cancel">Back</button>
    </div>`, (el) => {
    el.querySelector('#mn-overlay').onclick = () => {
      const url = `${location.origin}/overlay?b=${brk.id}`;
      window.open(url, '_blank', 'noopener'); copy(url, 'Overlay URL'); closeSheet();
    };
    el.querySelector('#mn-verify').onclick = () => { copy(`${location.origin}/verify?b=${brk.id}`, 'Verify link'); closeSheet(); };
    el.querySelector('#mn-copy').onclick = () => {
      const lines = lastRun.flatMap((b) => b.cards.map((c, i) =>
        `${rowById(b.rowId)?.name} card ${c}${b.marks?.[i]?.buyer ? ` — ${b.marks[i].buyer}` : ''}`));
      copy(`${brk.title}\n${lines.join('\n')}\n\nVerify: ${location.origin}/verify?b=${brk.id}`, 'Last draw');
      closeSheet();
    };
    el.querySelector('#mn-reveal').onclick = async () => {
      if (!confirm('Reveal the seed? This seals the break — no more draws on it.')) return;
      try {
        brk = await call(`/api/breaks/${brk.id}/reveal`, { method: 'POST' });
        closeSheet(); paint();
        say('Seed revealed. Viewers can recheck every draw now.', 'good');
      } catch (err) { say(err.message); }
    };
    el.querySelector('#mn-close').onclick = () => {
      brk = null; queue = []; lastRun = [];
      localStorage.removeItem('br.break');
      closeSheet(); route();
    };
    el.querySelector('#mn-cancel').onclick = closeSheet;
  });
};

// ---------------------------------------------------------------- boot

(async function boot() {
  paintEditor();
  const saved = localStorage.getItem('br.break');
  if (key && saved) {
    try {
      brk = await call(`/api/breaks/${saved}`);
      lastRun = brk.batches.slice(-1);
    } catch { localStorage.removeItem('br.break'); }
  }
  route();
  if (brk) paint();
})();
