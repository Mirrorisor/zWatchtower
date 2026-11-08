// Sapling's protocol-owned liquidity: one $SAPLING/ZEC pool on PumpSwap, whose
// LP tokens Sapling's docs say "are burned the moment they are minted, so
// nobody can ever pull it: not a holder, not a coin, not Sapling".
// On chain that means the LP token's supply stays 0: any LP token in a wallet
// could be redeemed for a share of the pool. Pure; liquidity-check.mjs fetches.
import { encode as b58 } from "./base58.mjs";

export const POOL = "6ejg4aYJM3Mk1t2zBKjbJ43df3s7rBMpC9mgo526K51G";     // $SAPLING/ZEC on PumpSwap
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const SAPLING_MINT = "BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
export const LP_MINT = "4A2HF17mm2Mf1yJ28hANemPDBHMKSF6Az5yzKF6WMtBW";
export const TREASURY = "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr";   // gets the pool's creator fee (per the docs)

/** PumpSwap pool account → its fields (layout read 2026-11-08). */
export function parsePool(data) {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const pk = (o) => b58(d.subarray(o, o + 32));
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  return {
    creator: pk(11), baseMint: pk(43), quoteMint: pk(75), lpMint: pk(107),
    baseAccount: pk(139), quoteAccount: pk(171), lpSupply: dv.getBigUint64(203, true).toString(), coinCreator: d.length >= 243 ? pk(211) : null,
  };
}

/**
 * @param now  { owner, pool: parsePool(), lp: { supply, mintAuthority, freezeAuthority }, baseUi, quoteUi, lockedZec }
 * @param prev last run's { pool } (or null)
 */
export function judgeLiquidity(now, prev = null) {
  const alerts = [], events = [];
  const p = now.pool;
  if (now.owner !== PUMP_AMM) alerts.push(`the $SAPLING/ZEC pool is no longer a PumpSwap pool (owner ${now.owner})`);
  if (p.baseMint !== SAPLING_MINT || p.quoteMint !== ZEC_MINT) alerts.push(`the $SAPLING/ZEC pool's tokens changed (${p.baseMint} / ${p.quoteMint})`);
  if (p.lpMint !== LP_MINT) alerts.push(`the pool's LP token changed from ${LP_MINT} to ${p.lpMint}`);
  // the promise: every LP token burned, so nobody can withdraw
  if (BigInt(now.lp.supply) > 0n)
    alerts.push(`Sapling's docs say the pool's LP tokens are burned the moment they're minted, but ${fmt(now.lp.supply, 9)} LP tokens exist: whoever holds them can withdraw that share of the pool`);
  if (now.lp.mintAuthority !== POOL) alerts.push(`the LP token can now be created by ${now.lp.mintAuthority ?? "nobody"}, not only by the pool`);
  if (now.lp.freezeAuthority) alerts.push(`the LP token has a freeze authority (${now.lp.freezeAuthority})`);
  if (prev?.pool?.coinCreator && p.coinCreator !== prev.pool.coinCreator)
    events.push(`The $SAPLING/ZEC pool's creator fee now goes to ${p.coinCreator} (it went to ${prev.pool.coinCreator}).`);
  return {
    alerts, events,
    summary: {
      pool: POOL, lpMint: p.lpMint, lpSupply: now.lp.supply, burned: BigInt(now.lp.supply) === 0n,
      // the pool's own count of LP shares ever issued: all of them now burned when lpSupply is 0
      lpShares: fmt(p.lpSupply, 9), saplingInPool: now.baseUi ?? null, zecInPool: now.quoteUi ?? null,
      zecAddedSaplingSays: now.lockedZec ?? null, creatorFeeTo: p.coinCreator, creatorFeeToTreasury: p.coinCreator === TREASURY,
    },
  };
}
const fmt = (v, dec) => Number(BigInt(v)) / 10 ** dec;
