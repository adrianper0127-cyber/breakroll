import { makeStream, uniformBelow } from './fair.js';

/**
 * Row pools and the draw rules.
 *
 * A row is a physical row of cards numbered 1..total. Drawing removes a card
 * from that row for good — the counter on screen is what is genuinely left.
 *
 * random      picks uniformly from whatever is still in the row.
 * sequential  walks forward from the row's cursor to the next cards that
 *             haven't gone yet, wrapping past the end back to card 1.
 *
 * Nothing about live state is trusted: `replay` rebuilds every row from the
 * seed and the batch log, so the same inputs always land on the same cards.
 */

export function freshRows(rows) {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    total: r.total,
    left: Array.from({ length: r.total }, (_, i) => i + 1),
    cursor: 1,
  }));
}

/** Runs one batch against live row state and returns the cards it took. */
export function applyBatch(rowState, batch, secretSeed, publicSeed) {
  const row = rowState.find((r) => r.id === batch.rowId);
  if (!row) throw new Error('That row is not in this break.');

  const want = Math.min(batch.count, row.left.length);
  const cards = [];

  if (batch.mode === 'sequential') {
    let guard = 0;
    while (cards.length < want && guard <= row.total * 2) {
      guard += 1;
      const at = row.left.indexOf(row.cursor);
      if (at !== -1) {
        cards.push(row.cursor);
        row.left.splice(at, 1);
      }
      row.cursor = row.cursor >= row.total ? 1 : row.cursor + 1;
    }
  } else {
    const next = makeStream(secretSeed, publicSeed, batch.nonce);
    for (let i = 0; i < want; i++) {
      const at = uniformBelow(next, row.left.length);
      cards.push(row.left[at]);
      row.left.splice(at, 1);
    }
    if (cards.length) {
      const last = cards[cards.length - 1];
      row.cursor = last >= row.total ? 1 : last + 1;
    }
  }

  return cards;
}

/** Rebuilds all row state from scratch. Returns rows plus each batch's cards. */
export function replay(session) {
  const rowState = freshRows(session.rows);
  const results = [];
  for (const batch of session.batches) {
    results.push({ ...batch, cards: applyBatch(rowState, batch, session.secretSeed, session.publicSeed) });
  }
  return { rowState, batches: results };
}

/** What the client needs to paint the row cards. */
export function rowSummary(rowState) {
  return rowState.map((r) => ({
    id: r.id,
    name: r.name,
    total: r.total,
    left: r.left.length,
    cursor: r.cursor,
  }));
}
