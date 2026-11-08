#!/usr/bin/env node
// zWatchtower: pairing tokens ("stock quotes")
//
// Sapling coins can be paired with tokenized stocks (NVDAx, TSLAx, SPYx...)
// and a few other tokens. Sapling's multisig sets that list on chain with
// SetStockQuote: one config account per token, owned by the vault program.
// The tokens' issuers hold controls over them: pausing, freezing accounts,
// moving tokens out of any account (a permanent delegate). Each run this:
//   - reads every pairing token's config account and posts when Sapling adds,
//     removes or changes one
//   - reads each token's issuer controls and posts when one is paused or
//     unpaused, when who holds a control changes, or when a balance
//     multiplier (a split) is scheduled
//
//   node quotes-check.mjs --rpc URL --state data/quotes-state.json [--json]
//
// Needs an RPC that allows getProgramAccounts (the server's Helius does).
// Read-only. Exit code 2 when the check cannot run.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { VAULT_PROGRAM, QUOTE_DISCRIMINATOR, tokenControls, compareQuotes, quotesSummary } from "./lib/quotes.mjs";
import { encode as b58 } from "./lib/base58.mjs";
import { redact } from "./lib/redact.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "quotes-state.json");

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
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")).quotes : null;
  const disc = b58(Buffer.from(QUOTE_DISCRIMINATOR, "hex"));
  const accts = await rpc("getProgramAccounts", [VAULT_PROGRAM, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: disc } }] }]);
  if (!Array.isArray(accts) || !accts.length) throw new Error("no pairing-token config accounts found");
  const now = {};
  for (const a of accts) {
    const data = Buffer.from(a.account.data[0], "base64");
    now[a.pubkey] = { mint: b58(data.subarray(8, 40)), hash: createHash("sha256").update(data).digest("hex").slice(0, 16) };
  }
  const configs = Object.keys(now);
  for (let i = 0; i < configs.length; i += 100) {
    const batch = configs.slice(i, i + 100);
    const infos = (await rpc("getMultipleAccounts", [batch.map((c) => now[c].mint), { encoding: "jsonParsed" }]))?.value ?? [];
    batch.forEach((c, j) => Object.assign(now[c], tokenControls(infos[j]?.data?.parsed?.info)));
  }
  const { alerts, events } = compareQuotes(prev, now);
  writeFileSync(statePath, JSON.stringify({ quotes: now, at: new Date().toISOString() }));
  const report = { alerts, events, notes: prev ? [] : ["first run: list recorded, nothing announced"], summary: quotesSummary(now) };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
}
main().catch((e) => { console.error(redact(e.message)); process.exitCode = 2; });
