#!/usr/bin/env node
// zWatchtower: liquidity check
//
// Sapling's docs: its liquidity is "one shared pool: protocol-owned
// $SAPLING/ZEC liquidity on PumpSwap", and "its LP tokens are burned the moment
// they are minted, so nobody can ever pull it: not a holder, not a coin, not
// Sapling." Each run checks, on chain:
//   - the LP token's supply is 0 (every LP token burned, none left to redeem)
//   - only the pool can create LP tokens, and nobody can freeze them
//   - the pool is still the $SAPLING/ZEC PumpSwap pool
//   - where the pool's creator fee goes (Sapling's treasury, per the docs)
//
//   node liquidity-check.mjs --rpc URL --state data/liquidity-state.json [--json]
//
// Read-only. Exit code 1 when there is an alert, 2 when the check cannot run.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { POOL, parsePool, judgeLiquidity } from "./lib/liquidity.mjs";
import { redact } from "./lib/redact.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "liquidity-state.json");
const API = opt("--api", "https://sapling.cash").replace(/\/$/, "");

async function rpc(method, params) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      if (r.status === 429) { await new Promise((res) => setTimeout(res, 2000 * (a + 1))); continue; }
      const j = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    } catch (e) { if (a === 3) throw e; await new Promise((res) => setTimeout(res, 1500 * (a + 1))); }
  }
}

async function main() {
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const acct = (await rpc("getAccountInfo", [POOL, { encoding: "base64" }]))?.value;
  if (!acct) throw new Error("the $SAPLING/ZEC pool account wasn't found");
  const pool = parsePool(Buffer.from(acct.data[0], "base64"));
  const mint = (await rpc("getAccountInfo", [pool.lpMint, { encoding: "jsonParsed" }]))?.value?.data?.parsed?.info;
  if (!mint) throw new Error("the pool's LP token wasn't found");
  const bal = async (a) => (await rpc("getTokenAccountBalance", [a]))?.value?.uiAmount ?? null;
  const [baseUi, quoteUi] = [await bal(pool.baseAccount), await bal(pool.quoteAccount)];
  let lockedZec = null;
  try { const s = await (await fetch(API + "/api/stats")).json(); if (s.lpLockedZec != null) lockedZec = Number(s.lpLockedZec) / 1e8; } catch {}

  const r = judgeLiquidity({ owner: acct.owner, pool, lp: { supply: mint.supply, mintAuthority: mint.mintAuthority ?? null, freezeAuthority: mint.freezeAuthority ?? null },
    baseUi, quoteUi, lockedZec }, prev);
  writeFileSync(statePath, JSON.stringify({ pool, at: new Date().toISOString() }));
  const report = { alerts: r.alerts, events: prev ? r.events : [], notes: [], summary: r.summary };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
  if (r.alerts.length) process.exitCode = 1;
}
main().catch((e) => { console.error(redact(e.message)); process.exitCode = 2; });
