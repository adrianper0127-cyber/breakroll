import crypto from 'node:crypto';

/**
 * Commit / reveal fairness.
 *
 * Before the break: a secret seed is generated and its SHA-256 published.
 * Each draw batch gets a nonce. Randomness for batch N is the byte stream
 * HMAC-SHA256(secret, `${publicSeed}|${N}|${counter}`), counter climbing as
 * bytes are consumed. Nothing about a batch can be re-rolled: nonces are
 * monotonic and never reused, even after an undo.
 */

export function newSecretSeed() {
  return crypto.randomBytes(32).toString('hex');
}

export function commitmentOf(secretSeed) {
  return crypto.createHash('sha256').update(secretSeed, 'utf8').digest('hex');
}

export function makeStream(secretSeed, publicSeed, nonce) {
  let counter = 0;
  let block = Buffer.alloc(0);
  let offset = 0;
  return function next(n) {
    const out = Buffer.alloc(n);
    let written = 0;
    while (written < n) {
      if (offset >= block.length) {
        block = crypto
          .createHmac('sha256', secretSeed)
          .update(`${publicSeed}|${nonce}|${counter}`, 'utf8')
          .digest();
        counter += 1;
        offset = 0;
      }
      const take = Math.min(n - written, block.length - offset);
      block.copy(out, written, offset, offset + take);
      written += take;
      offset += take;
    }
    return out;
  };
}

/** Uniform integer in [0, max) — rejection sampled, so no modulo bias. */
export function uniformBelow(next, max) {
  if (max <= 1) return 0;
  const limit = Math.floor(0xffffffff / max) * max;
  for (;;) {
    const v = next(4).readUInt32BE(0);
    if (v < limit) return v % max;
  }
}
