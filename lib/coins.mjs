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
// a creator "sold out" of a coin when they sold at least this share of what they bought
export const SOLD_OUT_PCT = 90;
// flag a coin whose creator sold out of at least this many of their other coins (and most of them)
export const PRIOR_SOLD_OUT = 2;

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

// Sapling shows "shielded launch" instead of a wallet for coins launched from a
// shielded Zcash wallet: the creator isn't public, so nothing is said about them.
export const isAddress = (a) => typeof a === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) && b58decode(a).length === 32;
export const creatorOf = (detail) => [detail.launcher, detail.creator].find(isAddress) ?? null;

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
  const creator = creatorOf(detail);
  const hiddenCreator = !creator && [detail.launcher, detail.creator].some((x) => typeof x === "string" && x);
  const launchedAt = detail.launchedAt ? Date.parse(detail.launchedAt) : null;
  const sorted = [...trades].sort((a, b) => Date.parse(a.blockTime) - Date.parse(b.blockTime));
  const reachesLaunch = opts.tradesComplete ??
    Boolean(launchedAt && sorted.length && Date.parse(sorted[0].blockTime) - launchedAt <= 5000);

  const card = {
    mint: detail.mint, symbol: detail.symbol, name: detail.name, venue: detail.venue ?? null,
    stage: detail.stage ?? null, graduated: Boolean(detail.complete || detail.migrated),
    launchedAt: detail.launchedAt ?? null, creator, creatorHidden: hiddenCreator,
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
  } else if (creator) {
    card.notes.push("Launch buys couldn't be checked yet");
  }
  if (hiddenCreator) card.notes.push("Launched from a shielded Zcash wallet: the creator isn't public, so their buys and sells can't be checked");

  // early buyers other than the creator
  if (reachesLaunch) {
    const early = sorted.filter((t) => t.isBuy && t.user !== creator && launchedAt &&
      Date.parse(t.blockTime) - launchedAt <= EARLY_SECONDS * 1000);
    f.earlyBuyers = new Set(early.map((t) => t.user)).size;
    f.earlyBuyersPct = pct(early.reduce((a, t) => a + big(t.tokenAmount), 0n), supply);
    if (f.earlyBuyersPct > LIMITS.earlyBuyersPct)
      card.flags.push(`${f.earlyBuyers} wallet${f.earlyBuyers === 1 ? "" : "s"} bought ${fmtPct(f.earlyBuyersPct)}% in the first ${EARLY_SECONDS} seconds`);
  } else if (!creator) {
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

  // the creator's other Sapling coins
  if (opts.creatorRecord && creator) {
    const h = creatorHistory(opts.creatorRecord, detail.mint);
    f.creatorOtherCoins = h;
    if (h.soldOut >= PRIOR_SOLD_OUT && h.soldOut * 2 >= h.checked)
      card.flags.push(`Creator sold out of ${h.soldOut} of their ${h.checked} other coins checked`);
  }

  card.flagCount = card.flags.length;
  return card;
}

// ---- creator track records ----------------------------------------------
/** One line per coin, from the same facts a card uses. */
export function launchSummary(detail, kept, complete) {
  const c = buildCard(detail, kept, null, null, { tradesComplete: complete });
  const creator = creatorOf(detail);
  const bought = kept.filter((t) => t.user === creator && t.isBuy).length > 0;
  return {
    mint: detail.mint, symbol: detail.symbol, creator, launchedAt: detail.launchedAt ?? null,
    marketCapUsd: detail.marketCapUsd ?? null, complete,
    creatorBought: complete ? bought : null,
    creatorLaunchPct: c.facts.creatorLaunchPct ?? null,
    creatorSoldPct: complete ? (c.facts.creatorSoldPct ?? 0) : null,
  };
}

/** creator -> their coins, from every launch summary */
export function creatorRecords(launches) {
  const by = new Map();
  for (const l of Object.values(launches)) {
    if (!isAddress(l.creator)) continue;
    if (!by.has(l.creator)) by.set(l.creator, []);
    by.get(l.creator).push(l);
  }
  return by;
}

/** A creator's record on their coins other than `mint`. Only coins whose
 *  history was read to the launch, and where the creator bought, are judged. */
export function creatorHistory(coins, mint) {
  const others = coins.filter((l) => l.mint !== mint);
  const judged = others.filter((l) => l.complete && l.creatorBought);
  const soldOut = judged.filter((l) => l.creatorSoldPct >= SOLD_OUT_PCT);
  return { launched: others.length, checked: judged.length, soldOut: soldOut.length,
    soldOutCoins: soldOut.map((l) => l.symbol).slice(0, 10) };
}

/** Creators with more than one coin, most sold-out first. */
export function serialCreators(records, limit = 25) {
  const out = [];
  for (const [creator, coins] of records) {
    if (coins.length < 2) continue;
    const h = creatorHistory(coins, null);
    out.push({ creator, ...h, coins: coins.map((l) => ({ mint: l.mint, symbol: l.symbol, launchedAt: l.launchedAt,
      soldPct: l.creatorSoldPct, bought: l.creatorBought })).sort((a, b) => String(b.launchedAt).localeCompare(String(a.launchedAt))) });
  }
  return out.sort((a, b) => b.soldOut - a.soldOut || b.launched - a.launched).slice(0, limit);
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

// ---- events: what changed on a card since the last run, posted once each.
// Launch facts never change, so a launch flag appearing later only means the
// history finished reading; that is not news and is not posted.
const usdShort = (n) => n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(1)}k`;
export const flagKind = (f) => /first buyers (was|were) funded/.test(f) ? "funding" : /other coins/.test(f) ? "creatorPast" : /Creator bought/.test(f) ? "creatorBuy" : /Creator has sold/.test(f) ? "creatorSold"
  : /first/.test(f) ? "early" : /Top 10/.test(f) ? "top10" : /minted/.test(f) ? "mint" : /frozen/.test(f) ? "freeze" : "other";

export function cardEvents(prev, card, minMcapUsd = 10000) {
  const tag = `$${card.symbol} (${usdShort(card.marketCapUsd)})`;
  if (!prev) return card.flagCount
    ? [`${tag} just passed ${usdShort(minMcapUsd)} market cap with ${card.flagCount} flag${card.flagCount === 1 ? "" : "s"}: ${card.flags.join("; ")}.`]
    : [];
  const had = new Set(prev.flags.map(flagKind));
  const launchKnown = prev.facts?.creatorSoldPct !== undefined;
  const out = [];
  for (const f of card.flags) {
    const k = flagKind(f);
    // launch facts and a creator's past only appear as reading catches up: not news
    if (had.has(k) || k === "creatorBuy" || k === "early" || k === "creatorPast" || k === "funding") continue;
    if (k === "creatorSold" && !launchKnown) continue;
    if (k === "top10" && prev.facts?.top10Pct == null) continue;
    out.push(`${tag}: ${f.charAt(0).toLowerCase()}${f.slice(1)}.`);
  }
  if (launchKnown && had.has("creatorSold") && prev.facts.creatorSoldPct < 100 && card.facts.creatorSoldPct >= 100)
    out.push(`${tag}: the creator has now sold everything they bought.`);
  return out;
}
