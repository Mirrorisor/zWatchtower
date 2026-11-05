#!/usr/bin/env node
// zWatchtower: fee recipients and Sapling's permanence promises
//
// Reads every Sapling coin's record each pass: where its fee share goes (the
// Zcash Foundation, holder rewards, a wallet, or the creator) and the totals
// paid. Alerts when a coin that donated or paid holder rewards (permanent,
// per Sapling's docs) stops, when a paid total goes down, or when the coins'
// donations stop adding up to Sapling's platform total. A coin's recipient
// changing is posted as news.
//
//   node payees-check.mjs --state data/payees-state.json --out data/payees.json [--json]
//
// Reads only Sapling's public API. Needs Node 18+.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { coinFacts, comparePayees, payeeTable } from "./lib/payees.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--api", "https://sapling.cash").replace(/\/$/, "");
const statePath = opt("--state", "./payees-state.json");
const outPath = opt("--out", "./payees.json");
const concurrency = Number(opt("--concurrency", 6));

async function getJson(path) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(BASE + path); if (r.status === 404) return null; if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  throw new Error(`lookup failed: ${path}`);
}

async function main() {
  const prev = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { coins: {} };
  const notes = [];
  // every coin Sapling lists
  const mints = [];
  for (let page = 0; page < 30; page++) {
    const s = await getJson(`/api/search/coins?limit=200&offset=${page * 200}`);
    const list = s?.coins ?? [];
    mints.push(...list.map((x) => (Array.isArray(x) ? x[0] : x.mint)));
    if (list.length < 200) break;
  }
  const now = {};
  let failed = 0;
  for (let i = 0; i < mints.length; i += concurrency) {
    await Promise.all(mints.slice(i, i + concurrency).map(async (m) => {
      try { const j = await getJson(`/api/coins/${m}`); if (j) now[m] = coinFacts({ ...(j.coin ?? j), mint: m }); } catch { failed++; }
    }));
  }
  if (failed) notes.push(`${failed} coin record(s) not read; checked again next time`);
  const stats = await getJson("/api/stats").catch(() => null);
  const firstRun = !Object.keys(prev.coins).length;
  const { alerts, events, donationsAddUp } = comparePayees(prev.coins, now, stats?.donatedZec ?? null);
  if (donationsAddUp && !donationsAddUp.matches && !firstRun)
    alerts.push(`the coins' donations (${(Number(donationsAddUp.coinsZat) / 1e8).toFixed(6)} ZEC) don't add up to Sapling's platform total (${(Number(donationsAddUp.platformZat) / 1e8).toFixed(6)} ZEC)`);
  const coins = { ...prev.coins, ...now };
  writeFileSync(statePath, JSON.stringify({ coins, at: new Date().toISOString() }));

  const list = Object.values(coins);
  const kinds = list.reduce((m, c) => ((m[c.kind] = (m[c.kind] ?? 0) + 1), m), {});
  const z = (v) => Number(v) / 1e8;
  const out = {
    apiVersion: 1, generatedAt: new Date().toISOString(), coinsRead: Object.keys(now).length,
    recipients: kinds,   // how many coins send their fee share where
    donations: { platformZec: stats?.donatedZec != null ? z(stats.donatedZec) : null,
      coinsZec: z(list.reduce((a, c) => a + BigInt(c.donatedZat), 0n)), addUp: donationsAddUp?.matches ?? null,
      waitingZec: z(list.reduce((a, c) => a + BigInt(c.waitingZat), 0n)),
      coins: list.filter((c) => c.donates).map((c) => ({ mint: c.mint, symbol: c.symbol, donatedZec: z(c.donatedZat), waitingZec: z(c.waitingZat), marketCapUsd: c.marketCapUsd }))
        .sort((a, b) => b.donatedZec - a.donatedZec) },
    payees: payeeTable(coins).slice(0, 100),
    notes,
  };
  writeFileSync(outPath, JSON.stringify(out));
  const report = { alerts: firstRun ? [] : alerts, events: firstRun ? [] : events, notes,
    summary: { coinsRead: out.coinsRead, recipients: kinds, donatedZec: out.donations.coinsZec, donationsAddUp: out.donations.addUp,
      payeeWallets: out.payees.length, baseline: firstRun } };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
}
main().catch((e) => { console.error(e.message); process.exitCode = 2; });
