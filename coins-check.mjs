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
import { buildCard, repeatHolders, cardEvents, LIMITS, EARLY_SECONDS } from "./lib/coins.mjs";

// Bump when a change to how cards are read would move facts by itself: the
// first run after it sets a new baseline and posts no events.
const ENGINE = 2;

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const apiBase = opt("--api", "https://sapling.cash");
const statePath = opt("--state", "coins-state.json");
const outPath = opt("--out", "coins.json");
const maxCoins = Number(opt("--max-coins", "40"));
const maxPages = Number(opt("--max-pages", "60")); // 500 trades a page
// Only coins worth at least this much (USD) get a card. Sapling's coin list
// overstates coins still on their launch curve, so the list only shortlists;
// each coin's own page decides.
const minMcapUsd = Number(opt("--min-mcap-usd", "10000"));
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

// Trades come newest first, 500 a page, and Sapling pages them only by time:
// ?before=<unix seconds> returns trades strictly older than that second
// (a signature, ISO time or milliseconds are refused with HTTP 400).
//
// A coin's launch never changes, so its history is read once and kept, and
// a long history is read over several runs. Only the trades a card needs are
// kept: the creator's, and everything in the first seconds after launch.
// Each later run reads only the trades since the last one.
const statusOf = (e) => {
  const m = e.message.match(/HTTP \d+|rate-limited|"code":\s*(-?\d+)[^}]*?"message":\s*"([^"]{0,60})/);
  return m ? (m[1] ? `RPC ${m[1]} ${m[2]}` : m[0]) : e.message.slice(0, 60);
};

async function tradesPage(mint, beforeSec) {
  const q = new URLSearchParams({ limit: "1000", ...(beforeSec != null ? { before: String(beforeSec) } : {}) });
  const batch = await getJson(`${apiBase}/api/coins/${mint}/trades?${q}`) ?? [];
  return Array.isArray(batch) ? batch : (batch.trades ?? []);
}

// Page back from `before` (null: the newest) until a page reaches stopMs,
// history runs out, or the page budget is spent. A page that ends partway
// through a second is followed by one that re-reads that second, so no trade
// in it is skipped; repeats are dropped by signature.
async function walk(mint, before, stopMs, budget, add, oldest = Infinity) {
  let newest = null, pages = 0, ranOut = false;
  while (pages < budget) {
    const list = await tradesPage(mint, before); pages++;
    if (!list.length) { ranOut = true; break; }
    add(list);
    const ts = list.map((t) => Date.parse(t.blockTime));
    newest ??= Math.max(...ts);
    const o = Math.min(...ts), sec = Math.floor(o / 1000);
    before = o < oldest ? sec + 1 : sec;
    oldest = Math.min(oldest, o);
    if (stopMs != null && o <= stopMs) break;
    await sleep(pauseMs);
  }
  return { oldest, newest, pages, ranOut, before };
}

const slim = (t) => ({ signature: t.signature, blockTime: t.blockTime, isBuy: t.isBuy, user: t.user, tokenAmount: t.tokenAmount });

async function readHistory(mint, detail, hist) {
  const creator = detail.launcher ?? detail.creator ?? null;
  const launchMs = detail.launchedAt ? Date.parse(detail.launchedAt) : null;
  hist ??= { kept: [], newestMs: null, oldestMs: null, complete: false, startsAfterLaunch: false, pagesRead: 0 };
  const known = new Set(hist.kept.map((t) => t.signature));
  const keep = (t) => t.user === creator || (launchMs != null && Date.parse(t.blockTime) - launchMs <= (EARLY_SECONDS + 5) * 1000);
  const add = (list) => { for (const t of list) if (keep(t) && !known.has(t.signature)) { known.add(t.signature); hist.kept.push(slim(t)); } };
  const budget = maxPages;   // for each direction
  if (hist.newestMs != null) {                       // trades since last time
    const r = await walk(mint, null, hist.newestMs, budget, add);
    hist.pagesRead += r.pages;
    if (r.newest != null) hist.newestMs = Math.max(hist.newestMs, r.newest);
  }
  if (!hist.complete && budget > 0) {                // back towards the launch
    const r = await walk(mint, hist.before ?? null, null, budget, add, hist.oldestMs ?? Infinity);
    hist.before = r.before;               // where the next run carries on
    hist.pagesRead += r.pages;
    hist.newestMs ??= r.newest;
    if (Number.isFinite(r.oldest)) hist.oldestMs = Math.min(hist.oldestMs ?? Infinity, r.oldest);
    if (r.ranOut) {
      hist.complete = true;
      hist.startsAfterLaunch = Boolean(launchMs != null && hist.oldestMs != null && hist.oldestMs - launchMs > 5000);
    }
  }
  const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const why = !hist.complete
    ? `Launch not reached yet: read back to ${when(hist.oldestMs)} so far (${hist.pagesRead} pages); continues next run`
    : hist.startsAfterLaunch ? `Sapling's trade history for this coin starts ${when(hist.oldestMs)}, after its launch` : null;
  return { hist, complete: hist.complete && !hist.startsAfterLaunch, why };
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
  state.history ??= {};
  state.events ??= [];
  const events = [];
  const notes = [];
  const coins = await listCoins();
  let zecUsd = state.zecUsd ?? null;
  if (!zecUsd && coins.length) {
    const d = await getJson(`${apiBase}/api/coins/${coins[0].mint}`).catch(() => null);
    if (d?.marketCapUsd && Number(d.marketCapZec)) zecUsd = d.marketCapUsd / (Number(d.marketCapZec) / 1e8);
  }
  const listUsd = (c) => (zecUsd ? Number(c.marketCapZec ?? 0) / 1e8 * zecUsd : Infinity);
  const shortlist = coins.filter((c) => listUsd(c) >= minMcapUsd);
  const shortlisted = new Set(shortlist.map((c) => c.mint));

  // new coins first, then the stalest cards
  const picks = [...shortlist].sort((a, b) =>
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
  let belowLine = 0;
  const gapWhy = {};
  for (const c of picks) {
    try {
      const detail = await getJson(`${apiBase}/api/coins/${c.mint}`);
      if (!detail) continue;
      if (detail.marketCapUsd && Number(detail.marketCapZec)) zecUsd = detail.marketCapUsd / (Number(detail.marketCapZec) / 1e8);
      if (detail.marketCapUsd != null && detail.marketCapUsd < minMcapUsd) {
        delete state.cards[c.mint];
        state.refreshedAt[c.mint] = new Date().toISOString();
        belowLine++; await sleep(pauseMs); continue;
      }
      const { hist, complete, why } = await readHistory(c.mint, detail, state.history[c.mint]);
      state.history[c.mint] = hist;
      const trades = hist.kept;
      let holders = null;
      try { holders = await largestHolders(c.mint); } catch (e) { rpcFailures++; holderErrors[statusOf(e)] = (holderErrors[statusOf(e)] ?? 0) + 1; }
      const card = buildCard(detail, trades, mintInfo[c.mint] ?? null, holders, { tradesComplete: complete });
      if (card.notes.some((n) => /couldn't be checked/.test(n))) { tradeGaps++; if (why) { card.notes.push(why); const k = why.startsWith("Launch not") ? "still reading" : "history starts after launch"; gapWhy[k] = (gapWhy[k] ?? 0) + 1; } }
      // keep facts from an earlier, fuller look if this one couldn't see them
      const prev = state.cards[c.mint];
      if (prev && holders === null && prev.facts?.top10Pct != null) {
        card.facts.top10Pct = prev.facts.top10Pct; card.facts.top10 = prev.facts.top10; card.facts.topWallet = prev.facts.topWallet;
        card.notes.push(`Holder concentration from ${state.refreshedAt[c.mint].slice(0, 10)}`);
        if (prev.facts.top10Pct > LIMITS.top10Pct) card.flags.push(`Top 10 wallets hold ${prev.facts.top10Pct}% of supply`);
        card.flagCount = card.flags.length;
      }
      if (state.engine === ENGINE) {
        for (const text of cardEvents(state.cards[c.mint], card, minMcapUsd)) {
          events.push(text);
          state.events.unshift({ at: new Date().toISOString(), mint: c.mint, symbol: card.symbol, text });
        }
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
  if (tradeGaps) notes.push(`${tradeGaps} coin(s): trade history didn't reach the launch, so launch buys weren't judged (${Object.entries(gapWhy).map(([k, n]) => `${k}: ${n}`).join(", ")})`);

  // the list is fresh every run, so market cap and holders always are
  const byMint = new Map(coins.map((c) => [c.mint, c]));
  for (const [mint, card] of Object.entries(state.cards)) {
    const live = byMint.get(mint);
    if (!live) continue;
    card.marketCapZec = live.marketCapZec;
    card.holders = live.holders ?? card.holders;
  }
  state.zecUsd = zecUsd;

  if (belowLine) notes.push(`${belowLine} shortlisted coin(s) were under $${minMcapUsd.toLocaleString("en-US")} on their own page, so no card`);
  // a card stays public only while the coin is still above the line
  for (const [mint, card] of Object.entries(state.cards)) {
    if (!shortlisted.has(mint) || (card.marketCapUsd ?? 0) < minMcapUsd) delete state.cards[mint];
  }
  for (const mint of Object.keys(state.history)) if (!byMint.has(mint)) delete state.history[mint];
  const cards = Object.values(state.cards);
  const repeats = repeatHolders(cards, state.history);
  if (state.engine !== ENGINE) notes.push(`card reading changed (engine ${ENGINE}): this run sets the baseline, no events posted`);
  state.engine = ENGINE;
  state.events = state.events.slice(0, 100);
  if (repeats.length) notes.push(`${repeats.length} wallet(s) are in the top 10 of more than one coin`);
  const publicCards = cards.map((c) => ({ ...c, refreshedAt: state.refreshedAt[c.mint] }))
    .sort((a, b) => Number(b.marketCapZec ?? 0) - Number(a.marketCapZec ?? 0));
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), zecUsd, minMcapUsd, limits: LIMITS,
    earlySeconds: EARLY_SECONDS, cards: publicCards, repeatHolders: repeats, events: state.events.slice(0, 30) }));
  writeFileSync(statePath, JSON.stringify(state));

  const flagCounts = {};
  for (const c of cards) for (const f of c.flags) {
    const k = f.replace(/[\d.]+%?/g, "N").replace(/\bwallets?\b/, "wallet(s)");
    flagCounts[k] = (flagCounts[k] ?? 0) + 1;
  }
  const report = {
    checkedAt: new Date().toISOString(), coins: coins.length, minMcapUsd, shortlisted: shortlist.length, carded: cards.length, refreshed,
    flagged: cards.filter((c) => c.flagCount > 0).length, flagCounts, notes, alerts: [], events,
  };
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
