// The tokens Sapling coins can be paired with ("stock quotes"): mostly
// tokenized stocks (xStocks, Backpack Securities), set by Sapling's multisig
// with SetStockQuote (one config account per token, owned by the vault
// program). Sapling's docs: such a token "come[s] with controls held by [its]
// issuer: it can pause the token, freeze an account that holds it", and fees
// in it are turned into ZEC "never below Pyth's price less 1%".
// This tracks the list and each token's issuer controls. Pure; quotes-check.mjs fetches.

export const VAULT_PROGRAM = "A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF";
export const QUOTE_DISCRIMINATOR = "7ed15d42b54482dc";   // a stock-quote config account (seen 2026-11-08)

/** A Token-2022 mint (jsonParsed info) → the controls its issuer holds. */
export function tokenControls(info) {
  const ext = Object.fromEntries((info?.extensions ?? []).map((e) => [e.extension, e.state ?? {}]));
  const md = ext.tokenMetadata ?? {};
  const sc = ext.scaledUiAmountConfig;
  return {
    symbol: md.symbol || null, name: md.name || null,
    mintAuthority: info?.mintAuthority ?? null, freezeAuthority: info?.freezeAuthority ?? null,
    permanentDelegate: ext.permanentDelegate?.delegate ?? null,
    paused: ext.pausableConfig ? Boolean(ext.pausableConfig.paused) : null,
    pauseAuthority: ext.pausableConfig?.authority ?? null,
    defaultFrozen: ext.defaultAccountState ? ext.defaultAccountState.accountState === "frozen" : null,
    transferHook: ext.transferHook?.programId ?? null,
    // a scheduled change to how balances are shown (a stock split, say)
    multiplier: sc ? sc.multiplier : null,
    nextMultiplier: sc && Number(sc.newMultiplierEffectiveTimestamp) > 0 && sc.newMultiplier !== sc.multiplier
      ? { value: sc.newMultiplier, at: new Date(Number(sc.newMultiplierEffectiveTimestamp) * 1000).toISOString() } : null,
  };
}

const label = (q) => (q.symbol ? `$${q.symbol}` : `${q.mint.slice(0, 4)}…${q.mint.slice(-4)}`);

/**
 * @param prev { config: { mint, hash, ...tokenControls } } from the last run (null on the first)
 * @param now  the same, this run
 * @returns { alerts, events }  (all news: these are issuer or Sapling decisions, not faults)
 */
export function compareQuotes(prev, now) {
  const alerts = [], events = [];
  if (!prev) return { alerts, events };
  for (const [cfg, q] of Object.entries(now)) {
    const p = prev[cfg];
    if (!p) { events.push(`Sapling added ${label(q)}${q.name ? ` (${q.name})` : ""} to the tokens coins can be paired with.`); continue; }
    if (p.hash !== q.hash) events.push(`Sapling changed the pairing settings for ${label(q)}.`);
    if (!p.paused && q.paused) events.push(`${label(q)} has been paused by its issuer: coins paired with it can't trade it until it's unpaused.`);
    if (p.paused && !q.paused) events.push(`${label(q)} is no longer paused by its issuer.`);
    for (const [k, what] of [["freezeAuthority", "freeze holders' accounts"], ["permanentDelegate", "move tokens out of any account"], ["pauseAuthority", "pause the token"], ["mintAuthority", "create more of it"]])
      if ((p[k] ?? null) !== (q[k] ?? null)) events.push(`${label(q)}: who can ${what} changed from ${p[k] ?? "nobody"} to ${q[k] ?? "nobody"}.`);
    if (q.transferHook && q.transferHook !== p.transferHook) events.push(`${label(q)} now runs a transfer hook (${q.transferHook}) on every transfer.`);
    if (q.nextMultiplier && JSON.stringify(q.nextMultiplier) !== JSON.stringify(p.nextMultiplier))
      events.push(`${label(q)}: its issuer has scheduled balances to be shown ×${q.nextMultiplier.value} from ${q.nextMultiplier.at} (a split or similar).`);
  }
  for (const [cfg, p] of Object.entries(prev))
    if (!now[cfg]) events.push(`Sapling removed ${label(p)} from the tokens coins can be paired with.`);
  return { alerts, events };
}

/** Summary for the site. */
export function quotesSummary(now) {
  const list = Object.values(now);
  return {
    tokens: list.length,
    paused: list.filter((q) => q.paused).map(label),
    withPermanentDelegate: list.filter((q) => q.permanentDelegate).length,
    withFreezeAuthority: list.filter((q) => q.freezeAuthority).length,
    scheduledMultiplier: list.filter((q) => q.nextMultiplier).map((q) => `${label(q)} ×${q.nextMultiplier.value} ${q.nextMultiplier.at}`),
    symbols: list.map(label).sort(),
  };
}

// ---- conversions ------------------------------------------------------------
// Sapling turns the fees it earns in a pairing token into ZEC: ConvertStockBegin,
// a Jupiter swap, ConvertStockEnd. ConvertStockEnd logs an event (layout read
// 2026-11-08 from a real conversion; not published by Sapling):
//   8 discriminator · 32 coin? · 32 token mint · u64 token sold · u64 ZEC received ·
//   u64 minimum ZEC asked for · u64 the program's own floor · …
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";

/** A transaction (jsonParsed) → the conversion in it, or null. */
export function parseConversion(tx, b58encode) {
  const logs = tx?.meta?.logMessages ?? [];
  const at = logs.findIndex((l) => /Instruction: ConvertStockEnd/.test(l));
  if (at < 0 || tx.meta.err) return null;
  const data = logs.slice(at + 1, at + 4).find((l) => l.startsWith("Program data: "));
  if (!data) return null;
  const d = Buffer.from(data.slice(14), "base64");
  if (d.length < 104) return null;
  const c = { sig: tx.transaction.signatures[0], at: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
    mint: b58encode(d.subarray(40, 72)), sold: d.readBigUInt64LE(72).toString(), zecOut: d.readBigUInt64LE(80).toString(),
    minOut: d.readBigUInt64LE(88).toString(), floor: d.readBigUInt64LE(96).toString(), usdcLeg: null };
  // the dollars the token fetched, when the swap went through USDC: the biggest USDC amount moved
  const pre = new Map((tx.meta.preTokenBalances ?? []).map((b) => [b.accountIndex, b]));
  let usdc = 0;
  for (const b of tx.meta.postTokenBalances ?? []) {
    if (b.mint !== USDC) continue;
    const delta = Math.abs(Number(b.uiTokenAmount.uiAmount ?? 0) - Number(pre.get(b.accountIndex)?.uiTokenAmount.uiAmount ?? 0));
    if (delta > usdc) usdc = delta;
  }
  if (usdc > 0) c.usdcLeg = Math.round(usdc * 1e6) / 1e6;
  // the token's decimals, from the token balances
  const dec = [...(tx.meta.postTokenBalances ?? []), ...(tx.meta.preTokenBalances ?? [])].find((b) => b.mint === c.mint)?.uiTokenAmount.decimals;
  c.decimals = dec ?? null;
  return c;
}

/**
 * What a conversion fetched, and how far below that the program's own floor sat.
 * There is no market price to compare with here: Pyth's price service needs a key.
 */
export function judgeConversion(c) {
  const sold = c.decimals != null ? Number(c.sold) / 10 ** c.decimals : null;
  return { ...c, soldUi: sold, zecOutUi: Number(c.zecOut) / 1e8,
    // how much less ZEC the program would have accepted than it got, in %
    floorPctBelow: Number(c.zecOut) > 0 ? Math.round((1 - Number(c.floor) / Number(c.zecOut)) * 10000) / 100 : null,
    priceUsd: sold && c.usdcLeg ? Math.round((c.usdcLeg / sold) * 100) / 100 : null,
    belowFloor: BigInt(c.zecOut) < BigInt(c.floor) || BigInt(c.zecOut) < BigInt(c.minOut) };
}

/** News and alerts from judged conversions. */
export function conversionFindings(list, labelOf) {
  const alerts = [], events = [];   // events: none yet (nothing to compare prices with)
  for (const j of list) {
    const name = labelOf(j.mint);
    if (j.belowFloor) alerts.push(`Sapling converted ${j.soldUi ?? j.sold} ${name} into ${j.zecOutUi} ZEC, below the minimum its own program logged (${j.sig})`);
  }
  return { alerts, events };
}
