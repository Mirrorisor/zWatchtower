// Coin safety report cards: plain facts about each Sapling coin, and a flag
// when a fact crosses a line. Pure functions over data the collector fetched
// (Sapling's coin detail and trades, the mint account, the largest holders),
// so they run offline in tests.
import { decode as b58decode } from "./base58.mjs";

export const LIMITS = {
  creatorLaunchPct: 5,     // creator's buy at launch, % of supply
  creatorSoldPct: 50,      // share of what the creator bought that they have sold
  earlyBuyersPct: 10,      // non-creator buys in the first EARLY_SECONDS, % of supply
  top10Pct: 50,            // top 10 wallets (pools and program accounts left out), % of supply
};
export const EARLY_SECONDS = 10;

// ---- ed25519: is an address a real wallet (on the curve) or a program
// address (off the curve)? Pools, bonding curves and vaults are off the curve.
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a) { const r = a % P; return r < 0n ? r + P : r; }
function modPow(b, e) { let r = 1n; b = mod(b); while (e > 0n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; e >>= 1n; } return r; }
function modInv(a) { return modPow(a, P - 2n); }
export function isOnCurve(address) {
  const bytes = b58decode(address);
  if (bytes.length !== 32) return false;
  const le = Buffer.from(bytes);
  le[31] &= 0x7f;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(le[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const x2 = mod((y2 - 1n) * modInv(mod(D * y2 + 1n)));
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n; // x² has a square root
}

// for sentences: 91.6666 -> "91.7", 0.3353 -> "0.34"
export const fmtPct = (v) => (v > 0 && v < 1 ? v.toFixed(2) : String(Math.round(v * 10) / 10));
const pct = (part, whole) => (whole > 0n ? Number((part * 1000000n) / whole) / 10000 : 0);
const big = (v) => BigInt(v ?? 0);

/**
 * @param detail   Sapling /api/coins/<mint>
 * @param trades   Sapling /api/coins/<mint>/trades (any order)
 * @param mintInfo parsed mint account { mintAuthority, freezeAuthority, extensions? } or null
 * @param holders  [{ owner, amount }] largest token accounts with their owners, or null
 * @param opts     { tradesComplete: bool }  whether the trades go back to the launch
 */
export function buildCard(detail, trades = [], mintInfo = null, holders = null, opts = {}) {
  const supply = big(detail.mintSupply ?? "1000000000000000");
  const creator = detail.launcher ?? detail.creator ?? null;
  const launchedAt = detail.launchedAt ? Date.parse(detail.launchedAt) : null;
  const sorted = [...trades].sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime));
  const reachesLaunch = opts.tradesComplete ??
    Boolean(launchedAt && sorted.length && Date.parse(sorted[0].blockTime) - launchedAt <= 5000);

  const card = {
    mint: detail.mint, symbol: detail.symbol, name: detail.name, venue: detail.venue ?? null,
    stage: detail.stage ?? null, graduated: Boolean(detail.complete || detail.migrated),
    launchedAt: detail.launchedAt ?? null, creator,
    marketCapUsd: detail.marketCapUsd ?? null, holders: detail.holderCount ?? null,
    taxPct: detail.taxBps != null ? detail.taxBps / 100 : null,
    feesTo: detail.holderRewards ? "holders" : detail.donates ? "Zcash Foundation"
      : detail.payeeDeclared && detail.payee && detail.payee !== creator ? "another wallet" : "creator",
    facts: {}, flags: [], notes: [],
  };
  const f = card.facts;

  // creator: launch buy, total bought, sold
  if (creator && reachesLaunch) {
    const mine = sorted.filter((t) => t.user === creator);
    const launchBuy = mine.find((t) => t.isBuy && launchedAt && Date.parse(t.blockTime) - launchedAt <= 5000);
    f.creatorLaunchPct = launchBuy ? pct(big(launchBuy.tokenAmount), supply) : 0;
    const bought = mine.filter((t) => t.isBuy).reduce((a, t) => a + big(t.tokenAmount), 0n);
    const sold = mine.filter((t) => !t.isBuy).reduce((a, t) => a + big(t.tokenAmount), 0n);
    f.creatorSoldPct = bought > 0n ? Math.min(100, pct(sold, bought)) : (sold > 0n ? 100 : 0);
    if (f.creatorLaunchPct > LIMITS.creatorLaunchPct)
      card.flags.push(`Creator bought ${fmtPct(f.creatorLaunchPct)}% of supply at launch`);
    if (f.creatorSoldPct > LIMITS.creatorSoldPct)
      card.flags.push(`Creator has sold ${fmtPct(f.creatorSoldPct)}% of what they bought`);

    // early buyers other than the creator
    const early = sorted.filter((t) => t.isBuy && t.user !== creator && launchedAt &&
      Date.parse(t.blockTime) - launchedAt <= EARLY_SECONDS * 1000);
    f.earlyBuyers = new Set(early.map((t) => t.user)).size;
    f.earlyBuyersPct = pct(early.reduce((a, t) => a + big(t.tokenAmount), 0n), supply);
    if (f.earlyBuyersPct > LIMITS.earlyBuyersPct)
      card.flags.push(`${f.earlyBuyers} wallet${f.earlyBuyers === 1 ? "" : "s"} bought ${fmtPct(f.earlyBuyersPct)}% in the first ${EARLY_SECONDS} seconds`);
  } else if (creator) {
    card.notes.push("Launch buys couldn't be checked yet");
  }

  // concentration: wallets only (pools, curves and vaults are off the curve)
  if (holders) {
    const wallets = holders.filter((h) => h.owner && h.owner !== detail.bondingCurve && isOnCurve(h.owner));
    const top = wallets.sort((a, b) => (big(b.amount) > big(a.amount) ? 1 : -1)).slice(0, 10);
    f.top10Pct = pct(top.reduce((a, h) => a + big(h.amount), 0n), supply);
    f.top10 = top.map((h) => ({ owner: h.owner, pct: pct(big(h.amount), supply) }));
    f.topWallet = top[0] ? { owner: top[0].owner, pct: pct(big(top[0].amount), supply), isCreator: top[0].owner === creator } : null;
    if (f.top10Pct > LIMITS.top10Pct) card.flags.push(`Top 10 wallets hold ${fmtPct(f.top10Pct)}% of supply`);
  }

  // mint
  if (mintInfo) {
    f.mintAuthority = mintInfo.mintAuthority ?? null;
    f.freezeAuthority = mintInfo.freezeAuthority ?? null;
    if (f.mintAuthority) card.flags.push("More can be minted (mint authority is set)");
    if (f.freezeAuthority) card.flags.push("Wallets can be frozen (freeze authority is set)");
    const tf = (mintInfo.extensions ?? []).find((e) => e.extension === "transferFeeConfig")?.state;
    if (tf) {
      f.taxChangeable = Boolean(tf.transferFeeConfigAuthority);
      if (f.taxChangeable) card.notes.push("Sapling's program can still change this coin's tax rate");
    }
  }

  card.flagCount = card.flags.length;
  return card;
}

/**
 * Wallets in the top 10 of more than one coin, with what else they did:
 * created one of the cards' coins, or bought in a coin's first seconds.
 * @param cards   report cards (facts.top10 filled)
 * @param history { [mint]: { kept: trades } } as coins-check keeps it
 */
export function repeatHolders(cards, history = {}) {
  const by = new Map();
  for (const c of cards) for (const h of c.facts?.top10 ?? []) {
    if (!by.has(h.owner)) by.set(h.owner, []);
    by.get(h.owner).push({ symbol: c.symbol, mint: c.mint, pct: h.pct });
  }
  const out = [];
  for (const [owner, coins] of by) {
    if (coins.length < 2) continue;
    const created = cards.filter((c) => c.creator === owner).map((c) => c.symbol);
    const early = cards.filter((c) => {
      const launch = c.launchedAt ? Date.parse(c.launchedAt) : null;
      return launch != null && (history[c.mint]?.kept ?? []).some((t) => t.user === owner && t.isBuy &&
        Date.parse(t.blockTime) - launch <= EARLY_SECONDS * 1000);
    }).map((c) => c.symbol);
    out.push({ owner, coins: coins.sort((a, b) => b.pct - a.pct), created, earlyBuyerIn: early });
  }
  return out.sort((a, b) => b.coins.length - a.coins.length || b.coins[0].pct - a.coins[0].pct);
}
