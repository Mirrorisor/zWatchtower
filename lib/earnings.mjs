// What each Sapling coin pays its holders: from the reward runs Sapling
// publishes, the tokens our rewards check found in each coin's basket, and the
// coin's market cap. Pure; rewards-explorer.mjs does the fetching.

const DAY = 86400000;

/** One run's API record → the few facts the explorer keeps. */
export function runFacts(j) {
  const r = j?.run;
  if (!r) return null;
  const out = { mint: r.mint ?? null, symbol: r.symbol ?? null, status: r.status, at: r.startedAt ?? null,
    pot: r.pot ?? null, paid: r.paid ?? null, paidCount: r.paidCount ?? null, zecUsd: j.eligibility?.zecUsd != null ? Number(j.eligibility.zecUsd) : null };
  // Most runs pay ZEC (amounts in zat). Some pay the coin itself ("paidIn": "coin", amounts in the
  // coin's base units, 6 decimals): value them in zat at the run's own price.
  out.paidIn = r.paidIn ?? "zec";
  const zpt = Number(j.eligibility?.zecPerToken);
  if (out.paidIn === "coin") {
    out.paidCoin = r.paid ?? null;
    out.paid = Number.isFinite(zpt) && r.paid != null ? String(Math.round((Number(r.paid) / 1e6) * zpt * 1e8)) : null;
  } else if (out.paidIn !== "zec") out.paid = null;   // a unit we don't know: left out of the totals
  // share of each holder's formula amount paid as ZEC (1 = all ZEC; 0.5 = half ZEC, half other tokens)
  if (r.status === "done" && j.snapshot?.holders?.length && j.payouts?.length && r.pot) {
    const pot = BigInt(r.pot), sum = j.snapshot.holders.reduce((a, [, b]) => a + BigInt(b), 0n);
    const bal = new Map(j.snapshot.holders);
    const f = j.payouts.filter((p) => BigInt(p.share) > 0n && bal.has(p.owner))
      .map((p) => Number(p.share) / Number((pot * BigInt(bal.get(p.owner))) / sum)).filter(Number.isFinite).sort((a, b) => a - b);
    if (f.length && sum > 0n) out.zecFraction = Math.round(f[Math.floor(f.length / 2)] * 1000) / 1000;
    // value of the holdings that shared this run, in ZEC, at the run's own price (pump.fun coins: 6 decimals)
    if (Number.isFinite(zpt) && zpt > 0) out.eligibleZec = (Number(sum) / 1e6) * zpt;
  }
  return out;
}

/**
 * Per-coin summary, biggest last-7-days payout first.
 * @param runs     { id: runFacts }
 * @param mcaps    { mint: marketCapUsd }
 * @param baskets  { mint: { tokens: ["ZEC", "$SAPLING", ...], run } } from the rewards check
 */
export function aggregate(runs, { mcaps = {}, baskets = {}, now = Date.now() } = {}) {
  const by = new Map();
  for (const [id, r] of Object.entries(runs)) {
    if (!r?.mint || r.status !== "done" || r.paid == null) continue;
    const c = by.get(r.mint) ?? { mint: r.mint, symbol: r.symbol, runs: 0, paidZat: 0n, paid7dZat: 0n, runs7d: 0, lastRun: null, lastAt: null, zecUsd: null, zecFraction: null, eligibleZec: null, paidInCoin: false, recentZat: 0n };
    if (r.paidIn === "coin") c.paidInCoin = true;
    c.runs++;
    c.paidZat += BigInt(r.paid ?? 0);
    const t = Date.parse(r.at);
    if (t >= now - 7 * DAY) { c.paid7dZat += BigInt(r.paid ?? 0); c.runs7d++; }
    if (t >= now - 2 * 3600e3) c.recentZat += BigInt(r.paid ?? 0);   // Sapling's coin page may not count these yet
    if (!c.lastAt || r.at > c.lastAt) {
      c.lastAt = r.at; c.lastRun = Number(id); c.symbol = r.symbol ?? c.symbol;
      if (r.zecUsd) c.zecUsd = r.zecUsd;
      if (r.zecFraction != null && r.paidIn !== "coin") c.zecFraction = r.zecFraction;
      if (r.eligibleZec) c.eligibleZec = r.eligibleZec;
    }
    by.set(r.mint, c);
  }
  const zat = (v) => Number(v) / 1e8;
  return [...by.values()].map((c) => {
    const basket = baskets[c.mint]?.tokens ?? null;
    const paid7dUsd = c.zecUsd ? zat(c.paid7dZat) * c.zecUsd : null;
    const mcap = mcaps[c.mint] ?? null;
    return {
      mint: c.mint, symbol: c.symbol, runs: c.runs, runs7d: c.runs7d, lastRun: c.lastRun, lastRunAt: c.lastAt,
      paidZec: zat(c.paidZat), paid7dZec: zat(c.paid7dZat), paid7dUsd: paid7dUsd == null ? null : Math.round(paid7dUsd * 100) / 100,
      // tokens: from the rewards check when it has read a basket; otherwise all-ZEC runs say ZEC
      tokens: c.paidInCoin ? [...new Set([...(basket ?? (c.zecFraction > 0.98 ? ["ZEC"] : [])), `$${c.symbol}`])]
        : basket ?? (c.zecFraction != null && c.zecFraction > 0.98 ? ["ZEC"] : null),
      zecFraction: c.zecFraction,
      paidInCoin: c.paidInCoin, recentZec: zat(c.recentZat),
      marketCapUsd: mcap,
      // what $1,000 held earned in the last 7 days: the week's payouts over the value of the
      // holdings that share them (pools and holders under $20 don't), at the latest run's price
      // (left out when the eligible holdings are under $1,000: a tiny base gives meaningless numbers)
      per1kWeekUsd: c.eligibleZec && c.zecUsd && c.eligibleZec * c.zecUsd >= 1000 ? Math.round((zat(c.paid7dZat) / c.eligibleZec) * 1000 * 100) / 100 : null,
      eligibleUsd: c.eligibleZec && c.zecUsd ? Math.round(c.eligibleZec * c.zecUsd) : null,
    };
  }).sort((a, b) => (b.paid7dUsd ?? 0) - (a.paid7dUsd ?? 0) || b.paidZec - a.paidZec);
}

/**
 * Compare our totals with what Sapling's coin pages say they've paid holders
 * (holderRewardsPaidZec). Adds saplingPaidZec and matchesSapling to each coin;
 * a difference under 2% (or 0.0001 ZEC) counts as matching.
 * @param totals { mint: zat string from the coin page }
 */
export function crossCheck(coins, totals) {
  let checked = 0, matching = 0;
  const differ = [];
  for (const c of coins) {
    const t = totals[c.mint];
    if (t == null) { c.saplingPaidZec = null; c.matchesSapling = null; continue; }
    const s = Number(t) / 1e8;
    c.saplingPaidZec = s;
    const near = (x) => Math.abs(x - s) <= Math.max(0.0001, s * 0.02);
    // a run from the last two hours that Sapling's page hasn't added yet still matches
    c.matchesSapling = near(c.paidZec) || (c.recentZec > 0 && near(c.paidZec - c.recentZec));
    // runs paid in the coin itself are valued at each run's price; Sapling values them its own way
    if (!c.matchesSapling && c.paidInCoin && Math.abs(c.paidZec - s) <= s * 0.15) { c.matchesSapling = null; c.valuedDifferently = true; continue; }
    checked++;
    if (c.matchesSapling) matching++;
    else differ.push({ symbol: c.symbol, mint: c.mint, ours: Math.round(c.paidZec * 1e6) / 1e6, sapling: s });
  }
  return { checked, matching, differ: differ.sort((a, b) => Math.abs(b.ours - b.sapling) - Math.abs(a.ours - a.sapling)) };
}
