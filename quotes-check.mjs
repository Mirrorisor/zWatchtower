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
import { VAULT_PROGRAM, QUOTE_DISCRIMINATOR, tokenControls, compareQuotes, quotesSummary, parseConversion, judgeConversion, conversionFindings } from "./lib/quotes.mjs";
import { encode as b58 } from "./lib/base58.mjs";
import { redact } from "./lib/redact.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "quotes-state.json");
const SETTINGS_BYTES = 337;   // layout read 2026-11-08 (611-byte accounts); not published by Sapling

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
  const saved = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  let prev = saved.quotes ?? null;
  // state written before settings-only fingerprints (8 Nov): record again rather than call every token changed
  if (prev && Object.values(prev).some((q) => !("referenceRaw" in q))) prev = null;
  const disc = b58(Buffer.from(QUOTE_DISCRIMINATOR, "hex"));
  const accts = await rpc("getProgramAccounts", [VAULT_PROGRAM, { encoding: "base64", filters: [{ memcmp: { offset: 0, bytes: disc } }] }]);
  if (!Array.isArray(accts) || !accts.length) throw new Error("no pairing-token config accounts found");
  const now = {};
  for (const a of accts) {
    const data = Buffer.from(a.account.data[0], "base64");
    // only the settings part: later bytes change on every conversion (its time and amount)
    now[a.pubkey] = { mint: b58(data.subarray(8, 40)), hash: createHash("sha256").update(data.subarray(0, SETTINGS_BYTES)).digest("hex").slice(0, 16),
      referenceRaw: data.length >= 337 ? data.readBigUInt64LE(329).toString() : null };   // a stored number; its meaning isn't published (not a price)
  }
  const configs = Object.keys(now);
  for (let i = 0; i < configs.length; i += 100) {
    const batch = configs.slice(i, i + 100);
    const infos = (await rpc("getMultipleAccounts", [batch.map((c) => now[c].mint), { encoding: "jsonParsed" }]))?.value ?? [];
    batch.forEach((c, j) => Object.assign(now[c], tokenControls(infos[j]?.data?.parsed?.info)));
  }
  const { alerts, events } = compareQuotes(prev, now);
  const notes = prev ? [] : ["first run: list recorded, nothing announced"];

  // conversions: every transaction touching a token's settings since the last run; the ones with ConvertStockEnd
  const lastSig = saved.lastSig ?? {}, firstScan = !saved.lastSig;
  const log = saved.conversions ?? [];
  const fresh = [];
  for (const cfg of configs) {
    let sigs;
    try { sigs = await rpc("getSignaturesForAddress", [cfg, { limit: firstScan ? 50 : 100, ...(lastSig[cfg] ? { until: lastSig[cfg] } : {}) }]); }
    catch (e) { notes.push(`${now[cfg].symbol ?? cfg}: history not read (${redact(e.message)})`); continue; }
    if (!sigs?.length) continue;
    lastSig[cfg] = sigs[0].signature;
    for (const sg of sigs.filter((x) => !x.err)) {
      if (log.some((c) => c.sig === sg.signature) || fresh.some((c) => c.sig === sg.signature)) continue;
      let tx;
      try { tx = await rpc("getTransaction", [sg.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]); } catch { continue; }
      const c = parseConversion(tx, b58);
      if (c) fresh.push(judgeConversion(c));
    }
  }
  const labelOf = (mint) => { const q = Object.values(now).find((x) => x.mint === mint); return q?.symbol ? `$${q.symbol}` : `${mint.slice(0, 4)}…`; };
  if (!firstScan) { const f = conversionFindings(fresh, labelOf); alerts.push(...f.alerts); events.push(...f.events); }
  else if (fresh.length) notes.push(`first scan: ${fresh.length} past conversion(s) recorded, nothing announced`);
  const conversions = [...fresh, ...log].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 300);

  writeFileSync(statePath, JSON.stringify({ quotes: now, lastSig, conversions, at: new Date().toISOString() }));
  const priced = conversions.filter((c) => c.priceUsd != null);
  const report = { alerts, events, notes, summary: { ...quotesSummary(now),
    conversions: conversions.length, newConversions: fresh.length, priced: priced.length,
    floorPctBelow: conversions.length ? { min: Math.min(...conversions.map((c) => c.floorPctBelow ?? 0)), max: Math.max(...conversions.map((c) => c.floorPctBelow ?? 0)) } : null,
    latest: conversions.slice(0, 5).map((c) => ({ at: c.at, token: labelOf(c.mint), sold: c.soldUi, zec: c.zecOutUi, priceUsd: c.priceUsd, floorPctBelow: c.floorPctBelow, sig: c.sig })) } };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
}
main().catch((e) => { console.error(redact(e.message)); process.exitCode = 2; });
