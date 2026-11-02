// Coin report cards: $ZWATCH's real launch (1 Nov 2026), and made-up coins
// that must trip each flag.
import { buildCard, isOnCurve, repeatHolders } from "../lib/coins.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

// wallets vs program addresses
check("a wallet that signs is on the curve", isOnCurve("4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ"));
check("the admin wallet is on the curve", isOnCurve("5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV"));
check("Sapling's fee PDA is off the curve", !isOnCurve("69nv6e1SZfdo9J6j45uuke4PBdLi6RYAiJpecG6HGLEY"));
check("Sapling's fee config PDA is off the curve", !isOnCurve("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh"));

// $ZWATCH, as Sapling's API returned it on 1 Nov 2026
const zwatch = {
  mint: "9Kz9RmVm8tqXRLZDRxaPZm2tkhjCrp7X8RUz1Ayzcash", name: "zWatchtower", symbol: "ZWATCH", stage: "seed",
  marketCapZec: "236071258", marketCapUsd: 2904.45, holderCount: 2, launchedAt: "2026-11-01T12:17:26.000Z",
  holderRewards: false, donates: true, venue: "launchlab", taxBps: 300,
  creator: "4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ", launcher: "4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ",
  bondingCurve: "8EoKTgNTRUQ3HRY133L8Gc4uuKiQztycV52XY9KBjZbY", complete: false, migrated: false,
  mintSupply: "1000000000000000", payee: "GEf2m9e4FhhRcvr8k4zJu3PBwCfN61R7q2qfbiuHw6sq", payeeDeclared: true,
};
const zwatchTrades = [
  { signature: "4E9Y", blockTime: "2026-11-01T12:17:29.000Z", isBuy: true, user: "6bD2YsuNF2MjMdYiLHRzmHswx3BzmtRgkFhJuBF6czBs", tokenAmount: "9555913046085" },
  { signature: "4q6C", blockTime: "2026-11-01T12:17:26.000Z", isBuy: true, user: "4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ", tokenAmount: "3353572733066" },
];
const t22 = (cfgAuth) => ({ mintAuthority: null, freezeAuthority: null,
  extensions: [{ extension: "transferFeeConfig", state: { transferFeeConfigAuthority: cfgAuth } }] });
let c = buildCard(zwatch, zwatchTrades, t22("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh"));
check("$ZWATCH: creator's launch buy is 0.3353%", c.facts.creatorLaunchPct === 0.3353, c.facts.creatorLaunchPct);
check("$ZWATCH: one early buyer took 0.9555%", c.facts.earlyBuyers === 1 && c.facts.earlyBuyersPct === 0.9555, JSON.stringify(c.facts));
check("$ZWATCH: fees go to the Zcash Foundation", c.feesTo === "Zcash Foundation");
check("$ZWATCH: no red flags, tax change noted", c.flagCount === 0 && c.notes.some((n) => /change this coin's tax/.test(n)), c.flags.join("; "));

// a coin that trips everything
const creator = "4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ";
const sniper = "6bD2YsuNF2MjMdYiLHRzmHswx3BzmtRgkFhJuBF6czBs";
const bad = { ...zwatch, donates: false, payeeDeclared: false, launchedAt: "2026-11-01T00:00:00.000Z" };
const badTrades = [
  { blockTime: "2026-11-01T00:00:00.000Z", isBuy: true, user: creator, tokenAmount: "80000000000000" },    // 8%
  { blockTime: "2026-11-01T00:00:02.000Z", isBuy: true, user: sniper, tokenAmount: "150000000000000" },    // 15%
  { blockTime: "2026-11-01T00:00:30.000Z", isBuy: true, user: "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV", tokenAmount: "10000000000000" },
  { blockTime: "2026-11-01T02:00:00.000Z", isBuy: false, user: creator, tokenAmount: "64000000000000" },   // sold 80%
];
const holders = [
  { owner: "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh", amount: "700000000000000" },   // a program address: left out
  { owner: sniper, amount: "450000000000000" },
  { owner: creator, amount: "100000000000000" },
];
c = buildCard(bad, badTrades, { mintAuthority: "Evil", freezeAuthority: "Evil" }, holders);
check("flags: creator's big launch buy", c.flags.some((f) => /Creator bought 8% of supply at launch/.test(f)), c.flags.join(" | "));
check("flags: creator sold most of it", c.flags.some((f) => /Creator has sold 80%/.test(f)));
check("flags: snipers in the first seconds", c.flags.some((f) => /1 wallet bought 15% in the first 10 seconds/.test(f)));
check("flags: concentration, with program accounts left out", c.facts.top10Pct === 55 && c.flags.some((f) => /Top 10 wallets hold 55%/.test(f)), c.facts.top10Pct);
check("flags: mint and freeze authority", c.flags.filter((f) => /minted|frozen/.test(f)).length === 2);
check("fees to the creator when nothing else is set", c.feesTo === "creator");
check("6 flags in all", c.flagCount === 6, c.flagCount);

// trades that don't reach back to the launch can't say anything about it
c = buildCard(bad, badTrades.slice(3), null, null);
check("partial trade history: no launch claims, a note instead", c.facts.creatorLaunchPct === undefined &&
  c.notes.some((n) => /couldn't be checked/.test(n)) && c.flagCount === 0, JSON.stringify(c));

// wallets in the top 10 of several coins
{
  const cA = { symbol: "A", mint: "mA", creator: "W1", launchedAt: "2026-11-01T00:00:00.000Z",
    facts: { top10: [{ owner: "W1", pct: 4 }, { owner: "W2", pct: 3 }] } };
  const cB = { symbol: "B", mint: "mB", creator: "W9", launchedAt: "2026-11-01T00:00:00.000Z",
    facts: { top10: [{ owner: "W2", pct: 6 }, { owner: "W1", pct: 1 }, { owner: "W3", pct: 1 }] } };
  const hist = { mB: { kept: [{ user: "W2", isBuy: true, blockTime: "2026-11-01T00:00:03.000Z" }] } };
  const r = repeatHolders([cA, cB], hist);
  const w2 = r.find((x) => x.owner === "W2"), w1 = r.find((x) => x.owner === "W1");
  check("repeat holders: two wallets in both coins, one-coin wallets left out", r.length === 2 && !r.some((x) => x.owner === "W3"), JSON.stringify(r));
  check("repeat holders: biggest holding first, early buys and creators noted",
    w2.coins[0].symbol === "B" && w2.earlyBuyerIn.join() === "B" && w1.created.join() === "A", JSON.stringify(r));
}

// ---- end to end: coins-check.mjs against a fake Sapling API and RPC ----
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "coins-test-"));
// coin B has 3 pages of trades, served 2 at a time, newest first
const B = { ...bad, mint: "BbbbB", symbol: "BAD" };
// a second buyer in the same second as the sniper, so a 2-trade page ends
// partway through that second
const pages = [...badTrades, { blockTime: "2026-11-01T00:00:02.000Z", isBuy: true, user: "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV", tokenAmount: "10000000000000" }]
  .map((t, i) => ({ ...t, signature: `s${i}` }))
  .sort((a, b) => Date.parse(b.blockTime) - Date.parse(a.blockTime));
let extra = [];   // trades that happen after the first run
const server = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (x, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(x)); };
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/api/search/coins") return send([
      [zwatch.mint, "ZWATCH", "zWatchtower", "m", "236071258", 2, "0", "launchlab"],
      [B.mint, "BAD", "Bad coin", "m", "999999999", 40, "0", "launchlab"]]);
    if (u.pathname === `/api/coins/${zwatch.mint}`) return send(zwatch);
    if (u.pathname === `/api/coins/${B.mint}`) return send(B);
    if (u.pathname === `/api/coins/${zwatch.mint}/trades`) {
      const before = u.searchParams.get("before");
      return send(zwatchTrades.filter((t) => !before || Date.parse(t.blockTime) < Number(before) * 1000).map((t) => ({ ...t })));
    }
    if (u.pathname === `/api/coins/${B.mint}/trades`) {
      const before = u.searchParams.get("before");
      if (before && !/^\d{10}$/.test(before)) return send({ error: "bad before" }, 400);   // as Sapling: seconds only
      const all = [...extra, ...pages];
      return send(all.filter((t) => !before || Date.parse(t.blockTime) < Number(before) * 1000).slice(0, 2));
    }
    if (u.pathname === "/rpc") {
      const { method, params } = JSON.parse(body);
      if (method === "getMultipleAccounts" && params[0].includes(B.mint))
        return send({ result: { value: params[0].map((m) => ({ data: { parsed: { info: m === B.mint ? { mintAuthority: "Evil", freezeAuthority: null } : t22("WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh") } } })) } });
      if (method === "getTokenLargestAccounts") {
        if (params[0] === zwatch.mint) return send({ error: { code: 429, message: "rate limited" } });
        return send({ result: { value: holders.map((h, i) => ({ address: `acct${i}`, amount: h.amount })) } });
      }
      if (method === "getMultipleAccounts") return send({ result: { value: params[0].map((a) => ({ data: { parsed: { info: { owner: holders[Number(a.slice(4))].owner } } } })) } });
    }
    send({ error: "nope" }, 404);
  });
});
await new Promise((ok) => server.listen(0, ok));
const base = `http://127.0.0.1:${server.address().port}`;
const out = join(dir, "coins.json"), st = join(dir, "state.json");
const run = (minUsd = "0", maxPages = "60") => new Promise((done) => {
  const p = spawn(process.execPath, [join(here, "../coins-check.mjs"), "--json", "--api", base, "--rpc", `${base}/rpc`,
    "--state", st, "--out", out, "--pause", "0", "--min-mcap-usd", minUsd, "--max-pages", maxPages]);
  let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("close", (code) => { let report = null; try { report = JSON.parse(o); } catch {} done({ code, report, err: e }); });
});
try {
  const x = await run();
  const pub = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
  const badCard = pub.cards?.find((c) => c.mint === B.mint);
  const zCard = pub.cards?.find((c) => c.mint === zwatch.mint);
  check("end to end: both coins carded, biggest market cap first", x.code === 0 && pub.cards?.length === 2 && pub.cards[0].mint === B.mint, x.err);
  check("end to end: trades paged back to the launch", badCard?.facts.creatorLaunchPct === 8 && badCard?.facts.creatorSoldPct === 80, JSON.stringify(badCard?.facts));
  check("end to end: mint authority read from chain", badCard?.flags.some((f) => /minted/.test(f)));
  check("end to end: a rate-limited holder lookup is a note, not a crash", zCard && zCard.facts.top10Pct === undefined &&
    x.report.notes.some((n) => /concentration not read for 1/.test(n)), JSON.stringify(x.report?.notes));
  check("end to end: report counts flagged coins", x.report.flagged === 1 && x.report.carded === 2, JSON.stringify(x.report));
  check("end to end: a page ending partway through a second loses no trade", badCard?.facts.earlyBuyers === 2 &&
    badCard?.facts.earlyBuyersPct === 16, JSON.stringify(badCard?.facts));
  check("end to end: wallets in the top 10 of both coins are listed", pub.repeatHolders?.length === 0, JSON.stringify(pub.repeatHolders));

  // a long history read over several runs, one page per run, then kept
  rmSync(st, { force: true });
  const reads = [];
  for (let i = 0; i < 6; i++) {
    const r = await run("0", "1");
    reads.push(JSON.parse(readFileSync(out, "utf8")).cards.find((c) => c.mint === B.mint));
    if (i === 0) check("end to end: a launch not reached yet says so", r.code === 0 && reads[0].facts.creatorLaunchPct === undefined &&
      reads[0].notes.some((n) => /Launch not reached yet/.test(n)), JSON.stringify(reads[0].notes));
  }
  const done = reads[5];
  check("end to end: the history resumes across runs until the launch", done.facts.creatorLaunchPct === 8 &&
    done.facts.earlyBuyers === 2 && done.facts.creatorSoldPct === 80, JSON.stringify(done.facts));
  // later, the creator sells the rest: only the new trades are read
  extra = [{ signature: "late", blockTime: "2026-11-01T05:00:00.000Z", isBuy: false, user: creator, tokenAmount: "16000000000000" }];
  await run("0", "1");
  const after = JSON.parse(readFileSync(out, "utf8")).cards.find((c) => c.mint === B.mint);
  check("end to end: trades after the launch is kept are still counted", after.facts.creatorSoldPct === 100 &&
    after.facts.creatorLaunchPct === 8, JSON.stringify(after.facts));
  extra = [];

  // only coins worth $10k+ on their own page get a card; B's list figure is
  // inflated (as Sapling's is for coins on their launch curve) but its page says $2.9k
  B.marketCapUsd = 2904; zwatch.marketCapUsd = 25000;
  rmSync(st, { force: true });
  const z = await run("10000");
  const pub3 = JSON.parse(readFileSync(out, "utf8"));
  check("end to end: only coins above $10k on their own page are carded", pub3.cards.length === 1 &&
    pub3.cards[0].mint === zwatch.mint && z.report.notes.some((n) => /1 shortlisted coin\(s\) were under \$10,000/.test(n)),
    JSON.stringify({ cards: pub3.cards.map((c) => c.symbol), notes: z.report.notes }));
  zwatch.marketCapUsd = 2904; zwatch.marketCapZec = "236071258";
  rmSync(st, { force: true });
  const w = await run("10000");
  check("end to end: a coin that drops under the line loses its card", JSON.parse(readFileSync(out, "utf8")).cards.length === 0, JSON.stringify(w.report));
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}

process.exitCode = failures ? 1 : 0;
