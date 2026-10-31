#!/usr/bin/env node
// zWatchtower: flywheel check (prototype)
//
// Sapling says "a share of every trade buys back and burns the top 10 Sapling
// coins". Coin taxes are settled into a ZEC pot held by the vault program
// (SettleTax); each buyback draws from the pot, swaps on Raydium or pump,
// burns what it bought and returns any change (DrawGrove … CloseGrove).
//
// This checks, from public data only:
//   1. every burn Sapling lists happened on chain as listed: the pot paid the
//      listed ZEC, the listed amount of that coin was burned, and the wallet
//      doing the swap kept nothing
//   2. every movement of the pot is a tax settlement in or a buyback out;
//      anything else (a withdrawal, an unknown instruction) is an alert
//   3. the pot's balance on chain equals the sum of everything seen moving it,
//      and the balance Sapling shows
//   4. the keys signing buybacks do not change without notice
//
// Usage:
//   node flywheel-check.mjs --rpc https://api.mainnet-beta.solana.com --state flywheel-state.json
//
// Read-only. Exit code 1 when there is an alert, 2 when the check cannot run.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { checkBurn, classifyPotTx, GROVE_ACCOUNT } from "./lib/flywheel.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "flywheel-state.json");
const apiBase = opt("--api", "https://sapling.cash");
const asJson = args.includes("--json");
const pauseMs = Number(opt("--pause", "250"));

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function getJson(url, init) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url, init);
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${url}: rate-limited`);
}
const rpc = async (method, params) => {
  const j = await getJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};
const getTx = (sig) => rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);

// New signatures on the pot account since the last one seen (oldest first).
async function newPotSignatures(until) {
  const out = []; let before;
  for (;;) {
    const page = await rpc("getSignaturesForAddress", [GROVE_ACCOUNT, { limit: 1000, before, until }]);
    out.push(...page);
    if (page.length < 1000) break;
    before = page.at(-1).signature;
  }
  return out.reverse();
}

async function main() {
  const fresh = !existsSync(statePath);
  const state = fresh ? { burns: {}, pot: { lastSig: null, total: "0", complete: false, kinds: {} }, signers: [] }
    : JSON.parse(readFileSync(statePath, "utf8"));
  const alerts = [], notes = [];

  // 1. every listed burn, checked once (re-checked while it has problems)
  const live = await getJson(`${apiBase}/api/flywheel/live`);
  const listed = live.burns ?? [];
  for (const b of listed) {
    const prev = state.burns[b.signature];
    if (prev && prev.problems.length === 0 && prev.zat === String(b.zat) && prev.burned === String(b.burned)) continue;
    const res = checkBurn(await getTx(b.signature), b);
    res.symbol = b.symbol; res.at = b.at;
    state.burns[b.signature] = res;
    await sleep(pauseMs);
  }
  for (const r of Object.values(state.burns)) {
    for (const p of r.problems) alerts.push(`flywheel burn ${r.symbol ?? ""} ${r.signature}: ${p}`);
  }

  // 2. every movement of the pot since last time
  const sigs = await newPotSignatures(state.pot.lastSig ?? undefined);
  if (!state.pot.lastSig) state.pot.complete = true; // first run walks back to the pot's creation
  let total = BigInt(state.pot.total);
  for (const s of sigs) {
    const c = classifyPotTx(await getTx(s.signature));
    total += BigInt(c.delta);
    state.pot.kinds[c.kind] = (state.pot.kinds[c.kind] ?? 0) + 1;
    for (const p of c.problems) {
      alerts.push(`flywheel pot ${c.signature}: ${p}`);
      (state.pot.problems ??= []).push({ signature: c.signature, problem: p });
    }
    if (c.kind === "buyback" && !listed.some((b) => b.signature === c.signature) && !state.burns[c.signature]) {
      notes.push(`buyback ${c.signature} drew ${-BigInt(c.delta)} zat but is not in Sapling's burn list`);
    }
    if (c.kind === "inflow") state.pot.inflowZat = String(BigInt(state.pot.inflowZat ?? "0") + BigInt(c.delta));
    if (c.kind === "buyback") state.pot.buybackZat = String(BigInt(state.pot.buybackZat ?? "0") - BigInt(c.delta));
    // 4. signer keys
    if (c.kind === "buyback" || c.kind === "inflow") {
      for (const k of c.signers) {
        if (!state.signers.includes(k)) {
          if (!fresh) alerts.push(`flywheel: new signing key ${k} (${c.kind} ${c.signature})`);
          state.signers.push(k);
        }
      }
    }
    state.pot.lastSig = s.signature;
    await sleep(pauseMs);
  }
  state.pot.total = String(total);

  // 3. balances
  const bal = BigInt((await rpc("getTokenAccountBalance", [GROVE_ACCOUNT])).value.amount);
  if (state.pot.complete && bal !== total) {
    alerts.push(`flywheel pot holds ${bal} zat but the movements seen add up to ${total}`);
  }
  if (live.pot?.zat != null && BigInt(live.pot.zat) !== bal) {
    notes.push(`Sapling shows the pot at ${live.pot.zat} zat, chain says ${bal} (may be a moment out of date)`);
  }
  const listedZat = listed.reduce((a, b) => a + BigInt(b.zat), 0n);
  if (live.hero?.zat != null && BigInt(live.hero.zat) !== listedZat) {
    notes.push(`headline ${live.hero.zat} zat bought back, listed burns add up to ${listedZat}`);
  }

  const results = Object.values(state.burns);
  const perCoin = {};
  for (const r of results) {
    const k = r.symbol || r.mint;
    perCoin[k] ??= { mint: r.mint, burns: 0, zat: 0n };
    perCoin[k].burns++; perCoin[k].zat += BigInt(r.zat);
  }
  const report = {
    checkedAt: new Date().toISOString(),
    burns: results.length,
    burnsVerified: results.filter((r) => r.problems.length === 0).length,
    boughtBackZat: String(results.reduce((a, r) => a + BigInt(r.zat), 0n)),
    venues: results.reduce((a, r) => ((a[r.venue] = (a[r.venue] ?? 0) + 1), a), {}),
    perCoin: Object.fromEntries(Object.entries(perCoin).map(([k, v]) => [k, { ...v, zat: String(v.zat) }])),
    pot: { balanceZat: String(bal), shownZat: live.pot?.zat ?? null, inflowZat: state.pot.inflowZat ?? "0",
      buybackZat: state.pot.buybackZat ?? "0", movements: state.pot.kinds, reconciled: state.pot.complete && bal === total },
    signers: state.signers,
    alerts, notes,
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
  process.exitCode = alerts.length ? 1 : 0;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
