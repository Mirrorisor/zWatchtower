#!/usr/bin/env node
// zWatchtower: wrapped ZEC check
//
// How much ZEC exists on Solana (the token every Sapling trade uses) and on
// NEAR, and who can create or freeze it. Alerts when the Solana token's mint
// or freeze authority changes; notes big supply moves; keeps a supply history.
//
//   node zec-check.mjs --rpc <solana rpc> --state data/zec-state.json --out data/zec.json [--json]
//
// Reads only public chain data. Needs Node 18+.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { SOLANA_ZEC, NEAR_ZEC, compare, changeOver } from "./lib/zec.mjs";
import { redact } from "./lib/redact.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const nearRpc = opt("--near-rpc", "https://rpc.mainnet.near.org");
const statePath = opt("--state", "./zec-state.json");
const outPath = opt("--out", "./zec.json");

async function post(url, body) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) { const j = await r.json(); if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 120)); return j.result; }
    } catch (e) { if (a === 3) throw new Error(redact(`${url}: ${e.message}`)); }
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  throw new Error(redact(`lookup failed: ${url}`));
}

async function solana() {
  const r = await post(rpcUrl, { jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [SOLANA_ZEC, { encoding: "jsonParsed" }] });
  const i = r?.value?.data?.parsed?.info;
  if (!i) throw new Error("ZEC mint account not readable");
  return { supply: Number(i.supply) / 10 ** i.decimals, decimals: i.decimals, mintAuthority: i.mintAuthority ?? null, freezeAuthority: i.freezeAuthority ?? null };
}

async function nearView(method) {
  const r = await post(nearRpc, { jsonrpc: "2.0", id: 1, method: "query",
    params: { request_type: "call_function", finality: "final", account_id: NEAR_ZEC, method_name: method, args_base64: "e30=" } });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

async function near() {
  const [supply, meta] = await Promise.all([nearView("ft_total_supply"), nearView("ft_metadata")]);
  return { supply: Number(BigInt(supply)) / 10 ** meta.decimals, decimals: meta.decimals };
}

async function main() {
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const notes = [];
  const at = new Date().toISOString();
  const sol = await solana();   // without this there's nothing to check: let it fail the run
  let nr = null;
  try { nr = await near(); } catch (e) { notes.push(`NEAR supply not read: ${e.message.slice(0, 100)}`); }
  const { alerts, events, state } = compare(prev, { at, solana: sol, near: nr });
  writeFileSync(statePath, JSON.stringify(state));
  const DAY = 864e5;
  const out = {
    apiVersion: 1, generatedAt: at,
    solana: { mint: SOLANA_ZEC, supply: sol.supply, mintAuthority: sol.mintAuthority, freezeAuthority: sol.freezeAuthority,
      authoritiesSince: state.authorities.since,
      change24h: changeOver(state.history, "solana", DAY, at), change7d: changeOver(state.history, "solana", 7 * DAY, at) },
    near: nr ? { token: NEAR_ZEC, supply: nr.supply, change24h: changeOver(state.history, "near", DAY, at) } : null,
    history: state.history.filter((h, i, a) => i === a.length - 1 || Date.parse(h.at) % (6 * 3600e3) < 3600e3).slice(-500),
    reserves: "not yet checked: the bridge doesn't publish the Zcash addresses that hold the ZEC behind these tokens",
    notes,
  };
  writeFileSync(outPath, JSON.stringify(out));
  const report = { alerts, events, notes, summary: { solanaSupply: Math.round(sol.supply * 100) / 100, nearSupply: nr ? Math.round(nr.supply * 100) / 100 : null,
    mintAuthority: sol.mintAuthority, freezeAuthority: sol.freezeAuthority, change24h: out.solana.change24h } };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
}
main().catch((e) => { console.error(redact(e.message)); process.exitCode = 2; });
