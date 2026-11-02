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

// Trades, newest first, paged back until Sapling's history runs out.
// complete: we know we have every trade back to the launch.
async function allTrades(mint, launchedAt) {
  const seen = new Map();
  let before = null, complete = false;
  for (let page = 0; page < maxPages; page++) {
    const q = new URLSearchParams({ limit: "1000" });
    if (before) q.set("before", before);
    const batch = await getJson(`${apiBase}/api/coins/${mint}/trades?${q}`) ?? [];
    const list = Array.isArray(batch) ? batch : (batch.trades ?? []);
    if (!list.length) { complete = true; break; } // nothing older
    const fresh = list.filter((t) => !seen.has(t.signature));
    for (const t of fresh) seen.set(t.signature, t);
    if (!fresh.length) {
      // the API ignored "before": one page is all we can get. It is the whole
      // history if it is short or already starts at the launch.
      const oldest = Math.min(...list.map((t) => Date.parse(t.blockTime)));
      complete = list.length < 50 || Boolean(launchedAt && oldest - Date.parse(launchedAt) <= 5000);
      break;
    }
    before = fresh.reduce((a, t) => (Date.parse(t.blockTime) < Date.parse(a.blockTime) ? t : a)).signature;
    await sleep(pauseMs);
  }
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
  let zecUsd = state.zecUsd ?? null;
  for (const c of picks) {
    try {
      const detail = await getJson(`${apiBase}/api/coins/${c.mint}`);
      if (!detail) continue;
      if (detail.marketCapUsd && Number(detail.marketCapZec)) zecUsd = detail.marketCapUsd / (Number(detail.marketCapZec) / 1e8);
      const { trades, complete } = await allTrades(c.mint, detail.launchedAt);
      let holders = null;
      try { holders = await largestHolders(c.mint); } catch { rpcFailures++; }
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
      notes.push(`${c.symbol}: not refreshed (${e.message.slice(0, 120)})`);
    }
    await sleep(pauseMs);
  }
  if (rpcFailures) notes.push(`holder concentration not read for ${rpcFailures} coin(s) this run (RPC limits); tried again later`);
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
