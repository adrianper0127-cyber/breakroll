import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 3222;
const KEY = 'testkey1234567';
const base = `http://localhost:${PORT}`;
let pass = 0, fail = 0;

const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (extra ? ' — ' + extra : '')); }
};

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(auth ? { 'x-admin-key': KEY } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const srv = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), ADMIN_KEY: KEY, DATA_DIR: '/tmp/br-test-data' },
  stdio: 'ignore',
});

try {
  for (let i = 0; i < 40; i++) {
    try { await fetch(base + '/healthz'); break; } catch { await sleep(150); }
  }

  console.log('\n— setup —');
  let r = await api('/api/breaks', {
    method: 'POST',
    body: {
      title: 'Tuesday Shadow Break',
      publicSeed: 'ebay-show-88213',
      rows: [{ name: 'Row 1', total: 202 }, { name: 'Row 2', total: 203 }],
      chasePrizes: ['Charmander', 'Gardevoir'],
    },
  });
  ok(r.status === 201, 'break created', JSON.stringify(r.data).slice(0, 120));
  const id = r.data.id;
  ok(r.data.total === 405 && r.data.left === 405, 'totals 405/405', `${r.data.left}/${r.data.total}`);
  ok(r.data.rows[0].total === 202 && r.data.rows[1].total === 203, 'row totals');

  console.log('\n— sequential draws —');
  r = await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1', 'r1', 'r1', 'r1'] } });
  ok(JSON.stringify(r.data.batches[0].cards) === '[1,2,3,4]', 'first seq batch is 1,2,3,4', JSON.stringify(r.data.batches[0]?.cards));
  ok(r.data.batches.length === 1, 'consecutive same-row items grouped into one batch', String(r.data.batches.length));
  r = await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1', 'r1', 'r1'] } });
  ok(JSON.stringify(r.data.batches[0].cards) === '[5,6,7]', 'seq carries on from the cursor', JSON.stringify(r.data.batches[0]?.cards));
  ok(r.data.break.rows[0].left === 195, 'row 1 down to 195', String(r.data.break.rows[0].left));

  console.log('\n— random draws —');
  r = await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r2', 'r2', 'r2', 'r2', 'r2'] } });
  const rnd = r.data.batches[0].cards;
  ok(rnd.length === 5, 'five cards drawn', String(rnd.length));
  ok(new Set(rnd).size === 5, 'no repeats inside a batch', JSON.stringify(rnd));
  ok(rnd.every((c) => c >= 1 && c <= 203), 'all inside 1..203', JSON.stringify(rnd));
  ok(r.data.break.rows[1].left === 198, 'row 2 down to 198', String(r.data.break.rows[1].left));

  console.log('\n— mixed queue —');
  r = await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r1', 'r2', 'r2', 'r1'] } });
  ok(r.data.batches.length === 3, 'queue split into 3 batches by row runs', String(r.data.batches.length));
  ok(new Set(r.data.batches.map((b) => b.nonce)).size === 3, 'each batch got its own nonce');

  console.log('\n— no card is ever dealt twice —');
  const view = (await api(`/api/breaks/${id}`, { auth: false })).data;
  for (const row of view.rows) {
    const dealt = view.batches.filter((b) => b.rowId === row.id).flatMap((b) => b.cards);
    ok(new Set(dealt).size === dealt.length, `${row.name}: ${dealt.length} cards, all distinct`);
    ok(row.left === row.total - dealt.length, `${row.name}: counter matches cards dealt`, `${row.left} vs ${row.total - dealt.length}`);
  }
  ok(view.secretSeed === null, 'seed stays hidden before reveal');

  console.log('\n— undo —');
  const beforeUndo = view.left;
  const lastBatch = view.batches[view.batches.length - 1];
  r = await api(`/api/breaks/${id}/undo`, { method: 'POST' });
  ok(r.data.left === beforeUndo + lastBatch.cards.length, 'cards returned to the row', `${r.data.left} vs ${beforeUndo + lastBatch.cards.length}`);
  const nonceAfter = r.data.batches[r.data.batches.length - 1].nonce;
  r = await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r1'] } });
  ok(r.data.batches[0].nonce > lastBatch.nonce, 'nonce never reused after undo', `${r.data.batches[0].nonce} > ${lastBatch.nonce}`);

  console.log('\n— determinism —');
  const a = (await api(`/api/breaks/${id}`, { auth: false })).data;
  const b = (await api(`/api/breaks/${id}`, { auth: false })).data;
  ok(JSON.stringify(a.batches) === JSON.stringify(b.batches), 'replay is stable across requests');

  console.log('\n— marks and chases —');
  const target = a.batches[a.batches.length - 1];
  r = await api(`/api/breaks/${id}/mark`, { method: 'POST', body: { nonce: target.nonce, index: 0, buyer: 'jah_of_the_south', prize: 'Charmander' } });
  const marked = r.data.batches.find((x) => x.nonce === target.nonce);
  ok(marked.marks['0'].buyer === 'jah_of_the_south', 'buyer tagged');
  ok(marked.marks['0'].prize === 'Charmander', 'chase prize tagged');

  console.log('\n— guards —');
  ok((await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r9'] } })).status === 400, 'unknown row rejected');
  ok((await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: [] } })).status === 400, 'empty queue rejected');
  ok((await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r1'] }, auth: false })).status === 401, 'unauthed draw rejected');
  ok((await api('/api/breaks', { method: 'POST', body: { rows: [{ name: 'x', total: 99999 }] } })).status === 400, 'oversized row rejected');

  console.log('\n— draining a row —');
  let small = (await api('/api/breaks', { method: 'POST', body: { title: 'small', publicSeed: 's', rows: [{ name: 'R', total: 6 }] } })).data;
  r = await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'random', items: Array(10).fill('r1') } });
  ok(r.data.batches[0].cards.length === 6, 'draw request clamps to what is left', String(r.data.batches[0].cards.length));
  ok(r.data.break.left === 0, 'row emptied');
  ok((await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r1'] } })).status === 400, 'drawing from an empty row rejected');

  console.log('\n— sequential wrap around holes —');
  small = (await api('/api/breaks', { method: 'POST', body: { title: 'wrap', publicSeed: 'w', rows: [{ name: 'R', total: 5 }] } })).data;
  await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1', 'r1', 'r1'] } }); // 1,2,3
  r = await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1', 'r1'] } });
  ok(JSON.stringify(r.data.batches[0].cards) === '[4,5]', 'seq reaches the end', JSON.stringify(r.data.batches[0]?.cards));

  small = (await api('/api/breaks', { method: 'POST', body: { title: 'wrap2', publicSeed: 'w2', rows: [{ name: 'R', total: 5 }] } })).data;
  await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1', 'r1', 'r1', 'r1'] } }); // 1..4
  r = await api(`/api/breaks/${small.id}/draws`, { method: 'POST', body: { mode: 'sequential', items: ['r1'] } });
  ok(JSON.stringify(r.data.batches[0].cards) === '[5]', 'seq takes the last one', JSON.stringify(r.data.batches[0]?.cards));

  console.log('\n— reveal seals the break —');
  r = await api(`/api/breaks/${id}/reveal`, { method: 'POST' });
  ok(typeof r.data.secretSeed === 'string' && r.data.secretSeed.length === 64, 'seed revealed');
  const { createHash } = await import('node:crypto');
  ok(createHash('sha256').update(r.data.secretSeed).digest('hex') === r.data.commitment, 'seed hashes to the published commitment');
  ok((await api(`/api/breaks/${id}/draws`, { method: 'POST', body: { mode: 'random', items: ['r1'] } })).status === 409, 'no draws after reveal');

  console.log(`\n${pass} passed, ${fail} failed\n`);
} finally {
  srv.kill();
}
process.exit(fail ? 1 : 0);
