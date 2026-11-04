#!/usr/bin/env node
// zWatchtower rewards explorer
//
// Indexes every holder-reward run Sapling publishes (once in full, then only
// new runs) and writes, per coin: how much it has paid holders, in which
// tokens, in the last 7 days, and about what $1,000 held earned.
//
//   node rewards-explorer.mjs --state data/rewards-index.json --out data/rewards.json \
//     [--coins data/coins.json] [--creators data/creators.json] [--baskets data/state.json] [--json]
//
// Reads only Sapling's public API. Needs Node 18+.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { runFacts, aggregate, crossCheck } from "./lib/earnings.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = (opt("--api", "https://sapling.cash")).replace(/\/$/, "");
const API = BASE + "/api/rewards/";
const statePath = opt("--state", "./rewards-index.json");
const outPath = opt("--out", "./rewards.json");
const concurrency = Number(opt("--concurrency", 6));
const maxNew = Number(opt("--max-new", 2500));
const readJson = (p) => { try { return p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null; } catch { return null; } };

async function getRun(id) {
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(API + id);
      if (r.status === 404) return { notFound: true };
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  throw new Error(`run ${id}: lookup failed`);
}

async function main() {
  // bump when runFacts changes what it keeps: the index is then rebuilt once
  const VERSION = 2;   // 2: runs paid in the coin itself are valued in ZEC
  let state = readJson(statePath);
  if (!state || state.version !== VERSION) state = { version: VERSION, runs: {}, maxId: 0 };
  const notes = [];
  // runs that weren't finished last time are read again
  const redo = Object.entries(state.runs).filter(([, r]) => r && !["done", "failed"].includes(r.status)).map(([id]) => Number(id));
  let next = state.maxId + 1, misses = 0, added = 0;
  const queue = [...redo];
  // read forward until three ids in a row don't exist yet
  while (misses < 3 && added < maxNew) {
    const ids = queue.splice(0, concurrency);
    while (ids.length < concurrency) ids.push(next++);
    const got = await Promise.all(ids.map((id) => getRun(id).then((j) => [id, j], (e) => [id, { error: e.message }])));
    for (const [id, j] of got.sort((a, b) => a[0] - b[0])) {
      if (j.error) { notes.push(j.error); continue; }
      if (j.notFound) { if (id > state.maxId) misses++; continue; }
      misses = 0;
      const f = runFacts(j);
      if (f) { state.runs[id] = f; added++; }
      if (id > state.maxId) state.maxId = id;
    }
    if (notes.length > 20) break;   // Sapling's API is struggling; try again next time
  }
  // ids past maxId that came back missing are re-tried next time from maxId + 1
  writeFileSync(statePath, JSON.stringify(state));

  // market caps: report cards first, then the creator records
  const mcaps = {};
  for (const cr of readJson(opt("--creators"))?.creators ?? []) for (const k of cr.coins ?? []) if (k.marketCapUsd != null) mcaps[k.mint] = k.marketCapUsd;
  for (const c of readJson(opt("--coins"))?.cards ?? []) if (c.marketCapUsd != null) mcaps[c.mint] = c.marketCapUsd;
  const baskets = readJson(opt("--baskets"))?.rewardBaskets ?? {};
  const coins = aggregate(state.runs, { mcaps, baskets });

  // Sapling's own "paid to holders" total for each coin, refreshed every few hours (60 coin pages a run)
  state.saplingTotals ??= {};
  const stale = coins.map((c) => c.mint).filter((m) => !state.saplingTotals[m] || Date.now() - state.saplingTotals[m].at > 3 * 3600e3)
    .sort((a, b) => (state.saplingTotals[a]?.at ?? 0) - (state.saplingTotals[b]?.at ?? 0)).slice(0, 60);
  for (let i = 0; i < stale.length; i += concurrency) {
    await Promise.all(stale.slice(i, i + concurrency).map(async (m) => {
      try {
        const r = await fetch(`${BASE}/api/coins/${m}`);
        if (!r.ok) return;
        const j = await r.json(), c = j.coin ?? j;
        if (c.holderRewardsPaidZec != null) state.saplingTotals[m] = { paid: String(c.holderRewardsPaidZec), at: Date.now() };
      } catch {}
    }));
  }
  writeFileSync(statePath, JSON.stringify(state));
  const cc = crossCheck(coins, Object.fromEntries(Object.entries(state.saplingTotals).map(([m, v]) => [m, v.paid])));
  const out = {
    apiVersion: 1, generatedAt: new Date().toISOString(),
    runsIndexed: Object.keys(state.runs).length, latestRun: state.maxId,
    // our totals against the "paid to holders" figure on each coin's Sapling page
    crossCheck: { checked: cc.checked, matching: cc.matching, differ: cc.differ.slice(0, 20) },
    coins,
  };
  writeFileSync(outPath, JSON.stringify(out));
  const report = { ok: true, alerts: [], summary: { runsIndexed: out.runsIndexed, newRuns: added, latestRun: state.maxId,
    coinsPaying: coins.length, crossChecked: cc.checked, matchingSapling: cc.matching, differ: cc.differ.slice(0, 5), paid7dZec: Math.round(coins.reduce((a, c) => a + c.paid7dZec, 0) * 1e4) / 1e4, notes: notes.slice(0, 5) } };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report.summary);
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
