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
