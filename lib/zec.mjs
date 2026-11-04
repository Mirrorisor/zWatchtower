// Wrapped ZEC on other chains: how much exists, and who can create or freeze
// it. Pure; zec-check.mjs does the fetching.

// ZEC on Solana (Omni Bridge, minted by NEAR's bridge through a program address)
export const SOLANA_ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
// ZEC on NEAR (NEAR Intents' multi-chain token)
export const NEAR_ZEC = "zec.omft.near";

const HOUR = 3600e3;
// a supply move this big within an hour is worth saying out loud (not an alert: bridging is normal)
export const BIG_MOVE_ZEC = 2000;

/**
 * @param prev  state from the last run ({ authorities, history })
 * @param now   { at, solana: { supply, mintAuthority, freezeAuthority }, near: { supply } | null }
 * @returns { alerts, events, state }
 */
export function compare(prev, now) {
  const alerts = [], events = [];
  const st = { authorities: prev?.authorities ?? null, history: [...(prev?.history ?? [])] };
  const a = { mint: now.solana.mintAuthority ?? null, freeze: now.solana.freezeAuthority ?? null };
  if (!st.authorities) st.authorities = { ...a, since: now.at };   // first run: baseline
  else {
    if (a.mint !== st.authorities.mint)
      alerts.push(`ZEC on Solana: the authority that can create new ZEC changed from ${st.authorities.mint ?? "none"} to ${a.mint ?? "none"}`);
    if (a.freeze !== st.authorities.freeze)
      alerts.push(`ZEC on Solana: the authority that can freeze ZEC accounts changed from ${st.authorities.freeze ?? "none"} to ${a.freeze ?? "none"}`);
    if (alerts.length) st.authorities = { ...a, since: now.at };
  }
  // supply moves over the last hour
  const hourAgo = [...st.history].reverse().find((h) => Date.parse(h.at) <= Date.parse(now.at) - HOUR + 5 * 60e3);
  if (hourAgo && hourAgo.solana != null) {
    const d = now.solana.supply - hourAgo.solana;
    if (Math.abs(d) >= BIG_MOVE_ZEC)
      events.push(`ZEC on Solana: ${Math.round(Math.abs(d)).toLocaleString("en-US")} ZEC ${d > 0 ? "bridged in (created)" : "bridged out (burned)"} in the last hour. Supply now ${Math.round(now.solana.supply).toLocaleString("en-US")} ZEC.`);
  }
  // one point per run, thinned to hourly after a day, kept 120 days
  st.history.push({ at: now.at, solana: now.solana.supply, near: now.near?.supply ?? null });
  const cutoff = Date.parse(now.at) - 120 * 24 * HOUR, dayAgo = Date.parse(now.at) - 24 * HOUR;
  const seenHour = new Set();
  st.history = st.history.filter((h) => {
    const t = Date.parse(h.at);
    if (t < cutoff) return false;
    if (t >= dayAgo) return true;
    const k = h.at.slice(0, 13);
    if (seenHour.has(k)) return false;
    seenHour.add(k);
    return true;
  });
  return { alerts, events, state: st };
}

/** Change in supply over a window, from the history. */
export function changeOver(history, field, ms, nowAt) {
  const end = history.at(-1)?.[field];
  const start = history.find((h) => Date.parse(h.at) >= Date.parse(nowAt) - ms)?.[field];
  return end != null && start != null ? end - start : null;
}
