# Breakroll

A row-draw console for running live card breaks, built to be operated one-handed on a phone
while you're on camera — and to prove afterwards that you didn't rig it.

## The model

You set up rows the way they physically sit in your bins: **Row 1 — 202 cards**, **Row 2 — 203
cards**, as many rows as you need. Every draw pulls a card *out* of that row, so the counter on
screen is genuinely what's left.

**Random** picks uniformly from whatever is still in the row.
**Sequential** takes the next consecutive card numbers, carrying on from where that row left off
and skipping anything already gone.

- **Tap a row to select it**, then press **Spin**. Selecting never draws, so a stray thumb
  mid-stream can't burn a card. The button names the row you're about to draw from — "Spin Row 2".
- **Multi-draw** a row for N cards at once — stepper, quick buttons, or "all".
- **Queue** several draws across rows and run them together. Consecutive cards from the same row
  come out as one strip, so a sequential run reads `131 132 133 134`.
- **Tap any drawn card** to tag the buyer who won it, and mark it as a chase hit.
- **Undo** puts the last draw back into the row.

## The fairness part

This is the bit the app you screenshotted doesn't do, and it's what you can point chat at when
someone says "that's rigged."

1. When you start a break, a secret 32-byte seed is generated and its **SHA-256 fingerprint** is
   shown. Read that out on stream before you take a single bid. It's one-way — it reveals nothing,
   but it's permanently locked to the seed behind it.
2. You also set a **public seed** — the eBay show ID, or the date. Say it out loud. It goes into
   every draw, so nobody can claim you pre-rolled the whole night last week.
3. Draw #N takes its randomness from `HMAC-SHA256(seed, "publicSeed|N|counter")`, picking from
   whatever was left in that row at that moment, rejection sampled so every remaining card is
   exactly as likely. Draw numbers are monotonic and **never reused, even after an undo** — an
   undone draw leaves a permanent gap in the numbering.
4. After the break, hit **Reveal seed**. Anyone can open `/verify?b=<break id>` and the page
   replays the entire run — every draw, in order — **in their own browser** with WebCrypto, then
   checks the seed against the fingerprint you published up front. Nothing on that page trusts the
   server's stored answer. If they don't match, it says so in red.

Sequential draws are deterministic by definition, so they replay too; the seed is what makes the
random ones checkable.

## Pages

| Route | What it's for |
|---|---|
| `/` | Your console. Needs the admin key. |
| `/overlay?b=<id>` | Transparent overlay for an OBS browser source. Add `&rows=0` to hide row counters. |
| `/verify?b=<id>` | Public. Put this link in chat and in your listing description. |
| `/healthz` | Health check for Railway. |

## Deploying on Railway

Fastest path, no GitHub:

```bash
npm i -g @railway/cli
railway login
railway init            # name it "breakroll"
railway up              # uploads this folder and builds it
railway domain          # gives you a public https URL
```

Or push to a repo and use *New Project → Deploy from GitHub repo*. Nixpacks detects Node on its
own; `railway.json` sets the start command and the health check.

Then set these variables on the service:

| Variable | Value |
|---|---|
| `ADMIN_KEY` | A long random string. Anyone holding it can draw on your breaks. |
| `DATA_DIR` | `/data` — only if you attach a volume. |

Railway injects `PORT` itself; don't set it.

### Keeping breaks across deploys

Railway's filesystem is ephemeral, so a redeploy wipes past breaks unless you attach a volume.
**Settings → Volumes → New Volume**, mount path `/data`, then set `DATA_DIR=/data`. Worth doing —
a buyer may come back next week and ask you to re-verify a pull.

Mid-stream state is safe either way: everything lives server-side, so a phone refresh, a dropped
connection, or switching from your phone to a laptop picks up exactly where you were.

## Running it locally

```bash
ADMIN_KEY=pick-something-long npm start
# http://localhost:3000
```

Zero dependencies — Node's standard library only. Nothing to install, nothing to audit but
`server.js` and the two files in `lib/`.

## Tests

```bash
node test.mjs
```

Covers the draw rules (no card dealt twice, counters match cards dealt, sequential cursor and
end-of-row behaviour, clamping when a row runs dry), undo and nonce retirement, replay determinism,
auth, and that reveal seals the break.

## A note on eBay's rules

eBay Live has its own policies on how auctions and randomized lots are run, and they change. This
tool records and proves what you drew — it doesn't decide whether a given break format is allowed
on the platform. Check eBay's current live-selling and trading-card policies before you run one.
