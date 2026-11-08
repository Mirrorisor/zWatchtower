#!/usr/bin/env node
// zWatchtower: "90% back" check
//
// sapling.llc: "Ninety percent of every fee goes back to the people who use
// Sapling, paid in ZEC. Always." sapling.cash/stats shows where the fees went.
// This reads that breakdown, works out Sapling's own share from it, and checks
// every line we measure ourselves:
//   - paid to holders: the sum of every coin's holder-rewards total
//   - received by the Zcash Foundation: the sum of every coin's donations
//   - bought back and burned by coins' flywheels: the flywheel check's on-chain total
//   - paid to deployers and payees: the coin records' payee totals (a lower bound)
//
//   node split-check.mjs --payees data/payees-state.json --watchtower data/state.json --out data/split.json [--json]
//   node split-check.mjs --keys        print the stats fields (to map a renamed one)
//
// Reads Sapling's public API and our own state files. Needs Node 18+.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { findLegs, judgeSplit, splitFindings, flatten, parseStatsPage } from "./lib/split.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const BASE = opt("--api", "https://sapling.cash").replace(/\/$/, "");
const readJson = (p) => (p && existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null);

async function getJson(path) {
  for (let a = 0; a < 4; a++) {
    try { const r = await fetch(BASE + path); if (r.ok) return await r.json(); } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  throw new Error(`lookup failed: ${path}`);
}

async function getText(path) {
  for (let a = 0; a < 3; a++) {
    try { const r = await fetch(BASE + path); if (r.ok) return await r.text(); } catch {}
    await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
  }
  return null;
}

async function main() {
  const stats = await getJson("/api/stats");
  if (args.includes("--keys")) { for (const [k, v] of Object.entries(flatten(stats))) console.log(k, v); return; }
  const fields = opt("--fields") ? JSON.parse(opt("--fields")) : {};
  const found = findLegs(stats, fields);
  const notes = [];
  // the full breakdown is only on the stats page (rendered on Sapling's server)
  const html = await getText("/stats");
  const page = html ? parseStatsPage(html) : { zec: {}, pct: {}, found: [] };
  if (!html) notes.push("stats page not read: breakdown from the API only");
  // the page's lines win (they are the breakdown's own definitions); the API fills gaps
  const legs = { ...found.legs, ...page.zec };
  const from = { ...found.from, ...Object.fromEntries(Object.keys(page.zec).map((l) => [l, "stats page"])) };
  const unmapped = found.unmapped.filter((l) => legs[l] == null && page.pct[l] == null);

  // our own measurements
  const ours = {};
  const payees = readJson(opt("--payees"));
  if (payees?.coins) {
    const sum = (k) => Object.values(payees.coins).reduce((a, c) => a + BigInt(c[k] ?? 0), 0n);
    ours.holders = Number(sum("holderPaidZat")) / 1e8;
    ours.donated = Number(sum("donatedZat")) / 1e8;
    ours.payees = Number(sum("payeePaidZat")) / 1e8;
  } else notes.push("fee recipients not read yet: holder, donation and payee lines not checked");
  const fly = readJson(opt("--watchtower"))?.latest?.flywheel?.summary?.headline;
  if (fly?.chainZat != null) ours.flywheel = Number(fly.chainZat) / 1e8;
  else notes.push("flywheel check hasn't run yet: flywheel line not checked");
  // Sapling's coin records and stats are read minutes apart: a payout in between can differ slightly (2% allowed)

  const j = judgeSplit(legs, ours, { shares: page.pct });
  const outPath = opt("--out");
  const prev = readJson(outPath);
  const baseline = !prev;
  const { alerts, notes: more } = splitFindings(j, { baseline });
  notes.push(...more);
  if (unmapped.length) notes.push(`not found in Sapling's stats: ${unmapped.join(", ")}`);
  // the verdict changing is news either way
  const events = [];
  const was = prev?.claim?.verdict;
  if (was && was !== "not checked" && j.claim !== "not checked" && was !== j.claim)
    events.push(`Sapling's "90% back" claim: by its own stats, Sapling now keeps ${j.saplingSharePct}% of settled fees (verdict ${was} → ${j.claim}).`);
  for (const [leg, paths] of Object.entries(found.ambiguous)) notes.push(`${leg}: several stats fields could be it (${paths.join(", ")}); left out`);

  const out = {
    apiVersion: 1, generatedAt: new Date().toISOString(),
    claim: { text: "Ninety percent of every fee goes back to the people who use Sapling, paid in ZEC. Always.", source: "https://sapling.llc/",
      verdict: j.claim, saplingSharePct: j.saplingSharePct, backPct: j.backPct, settledZec: j.settledZec ?? null, fromShares: Boolean(j.fromShares) },
    breakdown: legs, sharesShown: page.pct, revenueZec: page.revenueZec ?? null, pageReadVia: page.via ?? null, fieldsUsed: from, checks: j.checks,
    statsFields: Object.keys(flatten(stats)),   // names only, so a renamed field is easy to spot
    notes,
  };
  if (outPath) writeFileSync(outPath, JSON.stringify(out));
  const report = { alerts, events: baseline ? [] : events, notes,
    summary: { claim: j.claim, saplingSharePct: j.saplingSharePct, backPct: j.backPct,
      checks: j.checks.map((c) => `${c.leg}: ${c.matches ? "matches" : "differs"} (Sapling ${c.sapling}, ours ${c.ours}${c.lowerBound ? ", lower bound" : ""})`),
      unmapped, baseline } };
  if (args.includes("--json")) console.log(JSON.stringify(report));
  else console.log(report);
}
main().catch((e) => { console.error(e.message); process.exitCode = 2; });
