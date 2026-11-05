// Where each Sapling coin's fee share goes, and whether Sapling keeps the
// promises its docs make about it: a coin that donates to the Zcash Foundation
// or pays holder rewards does so permanently, and paid totals only grow.
// Pure; payees-check.mjs does the fetching.

const zat = (v) => (v == null ? null : BigInt(String(v).split(".")[0]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");

/** One coin's API record → the facts kept. */
export function coinFacts(c) {
  const kind = c.donates ? "zcash-foundation" : c.holderRewards ? "holders" : c.payee ? "wallet" : "creator";
  return {
    mint: c.mint, symbol: c.symbol ?? null, marketCapUsd: c.marketCapUsd ?? null, kind,
    payee: c.payee ?? null, payeeIsSolana: c.payee ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(c.payee) : null,
    donates: Boolean(c.donates), holderRewards: Boolean(c.holderRewards),
    donatedZat: String(zat(c.donation?.donatedZec) ?? 0n), waitingZat: String(zat(c.donation?.waitingZec) ?? 0n),
    onTheWayZat: String(zat(c.donation?.onTheWayZec) ?? 0n),
    payeePaidZat: String(zat(c.payeePaidZec) ?? 0n), holderPaidZat: String(zat(c.holderRewardsPaidZec) ?? 0n),
    feeBalanceZat: String(zat(c.feeBalanceZec) ?? 0n),
  };
}

/**
 * Compare this pass with the last one.
 * @param prev  { mint: coinFacts } from the last pass (or {} on the first)
 * @param now   { mint: coinFacts } read this pass (coins not read this time are left out)
 * @param platformDonatedZat Sapling's platform-wide donated total (stats), or null
 */
export function comparePayees(prev, now, platformDonatedZat = null, { eventMinUsd = 10000 } = {}) {
  const alerts = [], events = [];
  for (const [mint, c] of Object.entries(now)) {
    const p = prev[mint];
    if (!p) continue;
    const name = `$${c.symbol ?? p.symbol} (${short(mint)})`;
    // promises the docs make: permanent
    if (p.donates && !c.donates) alerts.push(`${name} donated its fee share to the Zcash Foundation, which Sapling's docs say is permanent, and no longer does`);
    if (p.holderRewards && !c.holderRewards) alerts.push(`${name} paid holder rewards, which Sapling's docs say is permanent, and no longer does`);
    // totals only grow
    for (const [k, label] of [["donatedZat", "donated to the Zcash Foundation"], ["payeePaidZat", "paid to its payee"], ["holderPaidZat", "paid to holders"]])
      if (BigInt(c[k]) < BigInt(p[k])) alerts.push(`${name}: the total ${label} went down, from ${fmt(p[k])} to ${fmt(c[k])} ZEC`);
    // a new recipient is news (for coins people hold)
    const big = (c.marketCapUsd ?? 0) >= eventMinUsd;
    if (big && p.kind !== c.kind) {
      const to = { "zcash-foundation": "the Zcash Foundation", holders: "holder rewards", wallet: `wallet ${short(c.payee)}`, creator: "its creator" }[c.kind];
      events.push(`${name}: its fee share now goes to ${to} (it went to ${{ "zcash-foundation": "the Zcash Foundation", holders: "holder rewards", wallet: `wallet ${short(p.payee)}`, creator: "its creator" }[p.kind]}).`);
    } else if (big && c.kind === "wallet" && p.payee !== c.payee)
      events.push(`${name}: its fee share was redirected from wallet ${short(p.payee)} to ${short(c.payee)}.`);
  }
  // the coins' donations add up to Sapling's platform total
  let donationsAddUp = null;
  const all = { ...prev, ...now };
  if (platformDonatedZat != null) {
    const sum = Object.values(all).reduce((a, c) => a + BigInt(c.donatedZat), 0n);
    const gap = sum > BigInt(platformDonatedZat) ? sum - BigInt(platformDonatedZat) : BigInt(platformDonatedZat) - sum;
    donationsAddUp = { coinsZat: String(sum), platformZat: String(platformDonatedZat), matches: gap <= 10000n };   // 0.0001 ZEC
  }
  return { alerts, events, donationsAddUp };
}
const fmt = (z) => (Number(z) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");

/** Who collects fees: wallets ranked by coins paying them, with paid totals. */
export function payeeTable(coins) {
  const by = new Map();
  for (const c of Object.values(coins)) {
    if (c.kind !== "wallet" || !c.payee) continue;
    const e = by.get(c.payee) ?? { payee: c.payee, solana: c.payeeIsSolana, coins: [], paidZat: 0n };
    e.coins.push({ mint: c.mint, symbol: c.symbol, paidZec: Number(c.payeePaidZat) / 1e8, marketCapUsd: c.marketCapUsd });
    e.paidZat += BigInt(c.payeePaidZat);
    by.set(c.payee, e);
  }
  return [...by.values()].map((e) => ({ ...e, paidZec: Number(e.paidZat) / 1e8, paidZat: undefined, coinCount: e.coins.length }))
    .sort((a, b) => b.coinCount - a.coinCount || b.paidZec - a.paidZec);
}
