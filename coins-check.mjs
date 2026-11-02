#!/usr/bin/env node
// zWatchtower: coin report cards (prototype)
//
// For every coin launched on Sapling: the creator's launch buy and sells,
// buys in the first seconds, how concentrated holdings are, mint and freeze
// authority, whether the tax can change, and where the creator fee goes.
// Facts come from Sapling's own coin API and Solana; see lib/coins.mjs.
//
// Each run refreshes at most --max-coins cards (new coins first, then the
// stalest), so a public RPC's limits are respected; the rest wait.
//
// Usage:
//   node coins-check.mjs --rpc URL --state coins-state.json --out coins.json --json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { buildCard, LIMITS, EARLY_SECONDS } from "./lib/coins.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const apiBase = opt("--api", "https://sapling.cash");
const statePath = opt("--state", "coins-state.json");
const outPath = opt("--out", "coins.json");
const maxCoins = Number(opt("--max-coins", "40"));
const maxPages = Number(opt("--max-pages", "20"));
const pauseMs = Number(opt("--pause", "300"));
const asJson = args.includes("--json");

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function getJson(url, init) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(url, init);
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${url}: rate-limited`);
}
const rpc = async (method, params) => {
  const j = await getJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j?.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j?.result;
};

// /api/search/coins rows: [mint, symbol, name, mediaId, marketCapZec, holders, volume24hZec, venue?]
async function listCoins() {
  const j = await getJson(`${apiBase}/api/search/coins`);
  const rows = Array.isArray(j) ? j : (j?.coins ?? j?.results ?? j?.data ?? []);
  return rows.map((r) => Array.isArray(r)
    ? { mint: r[0], symbol: r[1], name: r[2], marketCapZec: r[4] ?? null, holders: r[5] ?? null, venue: r[7] ?? "pump" }
    : { mint: r.mint, symbol: r.symbol, name: r.name, marketCapZec: r.marketCapZec ?? null, holders: r.holderCount ?? null, venue: r.venue ?? "pump" })
    .filter((c) => c.mint);
}

// Trades, newest first. Sapling's trade API pages in a way not yet known, so
// each paging style is tried once per run and the first that returns older
// trades is used for the rest of the run. Failures never lose the first page.
const PAGING = [
  ["before", (seen, oldest) => ({ before: oldest.signature })],
  ["cursor", (seen, oldest) => ({ cursor: oldest.signature })],
  ["until", (seen, oldest) => ({ until: oldest.signature })],
  ["offset", (seen) => ({ offset: String(seen.size) })],
  ["page", (seen, oldest, page) => ({ page: String(page + 1) })],
];
const paging = { style: null, tried: {}, pageCap: 0 };
const statusOf = (e) => {
  const m = e.message.match(/HTTP \d+|rate-limited|"code":\s*(-?\d+)[^}]*?"message":\s*"([^"]{0,60})/);
  return m ? (m[1] ? `RPC ${m[1]} ${m[2]}` : m[0]) : e.message.slice(0, 60);
};

async function tradesPage(mint, extra) {
  const q = new URLSearchParams({ limit: "1000", ...extra });
  const batch = await getJson(`${apiBase}/api/coins/${mint}/trades?${q}`) ?? [];
  return Array.isArray(batch) ? batch : (batch.trades ?? []);
}

// complete: we know we have every trade back to the launch.
async function allTrades(mint, launchedAt) {
  const seen = new Map();
  const add = (list) => { const fresh = list.filter((t) => !seen.has(t.signature)); for (const t of fresh) seen.set(t.signature, t); return fresh; };
  const first = await tradesPage(mint, {});
  add(first);
  paging.pageCap = Math.max(paging.pageCap, first.length);
  const oldestTime = () => Math.min(...[...seen.values()].map((t) => Date.parse(t.blockTime)));
  const atLaunch = () => Boolean(launchedAt && seen.size && oldestTime() - Date.parse(launchedAt) <= 5000);
  if (!first.length || atLaunch()) return { trades: [...seen.values()], complete: true };

  for (let page = 1; page < maxPages; page++) {
    const oldest = [...seen.values()].reduce((a, t) => (Date.parse(t.blockTime) < Date.parse(a.blockTime) ? t : a));
    const styles = paging.style ? PAGING.filter(([n]) => n === paging.style)
      : PAGING.filter(([n]) => !(n in paging.tried) || paging.tried[n] === "works");
    let fresh = null;
    for (const [name, make] of styles) {
      try {
        const list = await tradesPage(mint, make(seen, oldest, page));
        const got = add(list);
        if (got.length) { paging.style = name; paging.tried[name] = "works"; fresh = got; break; }
        if (!list.length && paging.style === name) { fresh = []; break; } // history ran out
        paging.tried[name] ??= list.length ? "ignored" : "empty";
      } catch (e) { paging.tried[name] ??= statusOf(e); }
      await sleep(pauseMs);
    }
    if (!fresh || !fresh.length) break;
    if (atLaunch()) return { trades: [...seen.values()], complete: true };
    await sleep(pauseMs);
  }
  // no paging that works: one page is the whole history only if it wasn't full
  const complete = atLaunch() || (seen.size === first.length && paging.pageCap > first.length && paging.pageCap >= 50);
  return { trades: [...seen.values()], complete };
}

async function largestHolders(mint) {
  const largest = await rpc("getTokenLargestAccounts", [mint]);
  const accts = (largest?.value ?? []).slice(0, 20);
  if (!accts.length) return [];
  const info = await rpc("getMultipleAccounts", [accts.map((a) => a.address), { encoding: "jsonParsed" }]);
  return accts.map((a, i) => ({ owner: info?.value?.[i]?.data?.parsed?.info?.owner ?? null, amount: a.amount }));
}

async function main() {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { cards: {}, refreshedAt: {} };
  const notes = [];
  const coins = await listCoins();

  // new coins first, then the stalest cards
  const picks = [...coins].sort((a, b) =>
    (state.refreshedAt[a.mint] ? Date.parse(state.refreshedAt[a.mint]) : 0) -
    (state.refreshedAt[b.mint] ? Date.parse(state.refreshedAt[b.mint]) : 0)).slice(0, maxCoins);

  // mint accounts, 100 per call
  const mintInfo = {};
  for (let i = 0; i < picks.length; i += 100) {
    try {
      const batch = picks.slice(i, i + 100).map((c) => c.mint);
      const res = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
      batch.forEach((m, j) => { mintInfo[m] = res?.value?.[j]?.data?.parsed?.info ?? null; });
    } catch (e) { notes.push(`mint accounts not read this run: ${e.message}`); }
  }

  let refreshed = 0, rpcFailures = 0, tradeGaps = 0;
  const holderErrors = {};
  let zecUsd = state.zecUsd ?? null;
  for (const c of picks) {
    try {
      const detail = await getJson(`${apiBase}/api/coins/${c.mint}`);
      if (!detail) continue;
      if (detail.marketCapUsd && Number(detail.marketCapZec)) zecUsd = detail.marketCapUsd / (Number(detail.marketCapZec) / 1e8);
      const { trades, complete } = await allTrades(c.mint, detail.launchedAt);
      let holders = null;
      try { holders = await largestHolders(c.mint); } catch (e) { rpcFailures++; holderErrors[statusOf(e)] = (holderErrors[statusOf(e)] ?? 0) + 1; }
      const card = buildCard(detail, trades, mintInfo[c.mint] ?? null, holders, { tradesComplete: complete });
      if (card.notes.some((n) => /couldn't be checked/.test(n))) tradeGaps++;
      // keep facts from an earlier, fuller look if this one couldn't see them
      const prev = state.cards[c.mint];
      if (prev && holders === null && prev.facts?.top10Pct != null) {
        card.facts.top10Pct = prev.facts.top10Pct; card.facts.topWallet = prev.facts.topWallet;
        card.notes.push(`Holder concentration from ${state.refreshedAt[c.mint].slice(0, 10)}`);
        if (prev.facts.top10Pct > LIMITS.top10Pct) card.flags.push(`Top 10 wallets hold ${prev.facts.top10Pct}% of supply`);
        card.flagCount = card.flags.length;
      }
      state.cards[c.mint] = card;
      state.refreshedAt[c.mint] = new Date().toISOString();
      refreshed++;
    } catch (e) {
      notes.push(`${c.symbol}: not refreshed (${statusOf(e)})`);
    }
    await sleep(pauseMs);
  }
  if (rpcFailures) notes.push(`holder concentration not read for ${rpcFailures} coin(s) this run (${Object.entries(holderErrors).map(([k, n]) => `${k} x${n}`).join(", ")}); tried again later`);
  notes.push(`trade paging: ${paging.style ? `using "${paging.style}"` : "none found yet"}; tried ${Object.entries(paging.tried).map(([k, v]) => `${k}: ${v}`).join(", ") || "none"}; largest page ${paging.pageCap}`);
  if (tradeGaps) notes.push(`${tradeGaps} coin(s): trade history didn't reach the launch, so launch buys weren't judged`);

  // the list is fresh every run, so market cap and holders always are
  const byMint = new Map(coins.map((c) => [c.mint, c]));
  for (const [mint, card] of Object.entries(state.cards)) {
    const live = byMint.get(mint);
    if (!live) continue;
    card.marketCapZec = live.marketCapZec;
    card.holders = live.holders ?? card.holders;
  }
  state.zecUsd = zecUsd;

  const cards = Object.values(state.cards);
  const publicCards = cards.map((c) => ({ ...c, refreshedAt: state.refreshedAt[c.mint] }))
    .sort((a, b) => Number(b.marketCapZec ?? 0) - Number(a.marketCapZec ?? 0));
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), zecUsd, limits: LIMITS,
    earlySeconds: EARLY_SECONDS, cards: publicCards }));
  writeFileSync(statePath, JSON.stringify(state));

  const flagCounts = {};
  for (const c of cards) for (const f of c.flags) {
    const k = f.replace(/[\d.]+%?/g, "N").replace(/\bwallets?\b/, "wallet(s)");
    flagCounts[k] = (flagCounts[k] ?? 0) + 1;
  }
  const report = {
    checkedAt: new Date().toISOString(), coins: coins.length, carded: cards.length, refreshed,
    flagged: cards.filter((c) => c.flagCount > 0).length, flagCounts, notes, alerts: [],
  };
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
