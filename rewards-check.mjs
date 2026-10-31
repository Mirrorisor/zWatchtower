#!/usr/bin/env node
// zWatchtower: rewards check (prototype)
//
// Independently re-checks Sapling holder-reward runs from public data.
// For each run published at https://sapling.cash/api/rewards/<id> it checks:
//   1. sha256(JSON.stringify(snapshot)) equals run.snapshotHash
//   2. every holder in the snapshot is worth at least the $20 minimum,
//      at the run's own recorded prices (eligibility.zecPerToken, zecUsd)
//   3. every share = floor(pot * balance / sum of balances)
//   4. every snapshot holder has exactly one payout row, and no extras
//   5. pot = paid + rolledOver + rentZec
//   6. paid = sum of confirmed shares - rent taken from them
//   7. (with --rpc) the release transaction exists, succeeded, and moved
//      exactly the pot to the rewards wallet; and the snapshot hash
//      appears in the program's event data
//
// Usage:
//   node rewards-check.mjs                       # all runs, API checks only
//   node rewards-check.mjs --from 1000 --to 1071
//   node rewards-check.mjs --rpc https://api.mainnet-beta.solana.com
//   node rewards-check.mjs --json > report.json
//
// Needs Node 18+ (built-in fetch and WebCrypto). Reads only; signs nothing.

const API = "https://sapling.cash/api/rewards/";
const REWARDS_WALLET = "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL";
const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const MIN_HOLDING_USD = 20;
const TOKEN_DECIMALS = 6; // pump.fun coins

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const from = Number(opt("--from", 1));
const to = opt("--to", null) ? Number(opt("--to")) : null;
const rpcUrl = opt("--rpc", null);
const asJson = args.includes("--json");
const concurrency = Number(opt("--concurrency", 8));

const hex = (buf) => Buffer.from(buf).toString("hex");
const sha256 = async (s) =>
  hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));

async function getJson(url, init) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, init);
    if (r.status === 404) return { notFound: true };
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw new Error(`HTTP error for ${url}`);
}

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const j = await getJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

// Our own lookup failing (rate limit, blocked IP, timeout) says nothing about
// the run, so it is a note and the run counts as not checked on chain.
async function checkRelease(run) {
  try { return await checkReleaseOnChain(run); }
  catch (err) { return { release: "unchecked", releaseError: err.message }; }
}

async function checkReleaseOnChain(run) {
  if (!run.releaseSignature) return { release: "none" };
  const tx = await rpc("getTransaction", [
    run.releaseSignature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 },
  ]);
  if (!tx) return { release: "signature-not-on-chain" };
  const m = tx.meta;
  if (m.err) return { release: "failed-on-chain", err: m.err };
  const delta = (owner) => {
    const post = m.postTokenBalances.find((b) => b.owner === owner && b.mint === ZEC_MINT);
    if (!post) return 0n;
    const pre = m.preTokenBalances.find((b) => b.accountIndex === post.accountIndex);
    return BigInt(post.uiTokenAmount.amount) - BigInt(pre ? pre.uiTokenAmount.amount : 0);
  };
  const received = delta(REWARDS_WALLET);
  const hashInLogs = (m.logMessages || [])
    .filter((l) => l.startsWith("Program data: "))
    .some((l) => hex(Buffer.from(l.slice(14), "base64")).includes(run.snapshotHash));
  return {
    release: received === BigInt(run.pot) ? "ok" : "amount-mismatch",
    received: String(received),
    hashInEvent: hashInLogs,
  };
}

async function checkRun(id) {
  const j = await getJson(API + id);
  if (j.notFound) return { id, notFound: true };
  const run = j.run;
  const out = { id, coin: run.symbol, status: run.status, problems: [] };
  const p = (msg) => out.problems.push(msg);

  if (run.status !== "done") {
    out.note = `run status "${run.status}"`;
    if (run.pot !== null && run.paid !== "0") p("non-done run reports a payout");
    if (rpcUrl && run.releaseSignature) Object.assign(out, await checkRelease(run));
    if (out.release === "ok") p("failed run's release moved ZEC on chain");
    return out;
  }

  const s = j.snapshot;
  const h = await sha256(JSON.stringify(s));
  if (h !== run.snapshotHash) p("snapshot hash mismatch");

  const pot = BigInt(run.pot);
  const sum = s.holders.reduce((a, [, b]) => a + BigInt(b), 0n);
  const payouts = new Map((j.payouts || []).map((x) => [x.owner, x]));
  let confirmed = 0n, rent = 0n, badShares = 0, missing = 0, below = 0;
  const e = j.eligibility;
  for (const [owner, bal] of s.holders) {
    const expected = (pot * BigInt(bal)) / sum;
    const row = payouts.get(owner);
    if (!row) { missing++; continue; }
    if (BigInt(row.share) !== expected) badShares++;
    if (row.status === "confirmed") {
      confirmed += BigInt(row.share);
      rent += BigInt(row.rentZec || 0);
    }
    if (e) {
      // balance is in base units; zecPerToken is per whole token
      const usd = (Number(bal) / 10 ** TOKEN_DECIMALS) *
        Number(e.zecPerToken) * Number(e.zecUsd);
      if (usd < MIN_HOLDING_USD) below++;
    }
  }
  const extra = (j.payouts || []).length - (s.holders.length - missing);
  if (badShares) p(`${badShares} shares not floor(pot*balance/sum)`);
  if (missing) p(`${missing} holders without a payout row`);
  if (extra) p(`${extra} payout rows for non-holders`);
  if (below) p(`${below} holders below the $${MIN_HOLDING_USD} minimum`);
  if (!e) p("no eligibility prices published");
  if (pot !== BigInt(run.paid) + BigInt(run.rolledOver || 0) + BigInt(run.rentZec || 0))
    p("pot != paid + rolledOver + rent");
  if (BigInt(run.paid) !== confirmed - rent) p("paid != confirmed shares - rent");

  if (rpcUrl) {
    Object.assign(out, await checkRelease(run));
    if (out.release === "unchecked") out.note = `release not checked on chain (${out.releaseError})`;
    else if (out.release !== "ok") p(`release: ${out.release}`);
    if (out.hashInEvent === false) p("snapshot hash not found in release event");
  }
  out.pot = run.pot;
  out.paid = run.paid;
  return out;
}

async function main() {
  let last = to;
  if (last === null) {
    // find the newest run by probing upward
    last = from;
    while (!(await getJson(API + (last + 100))).notFound) last += 100;
    while (!(await getJson(API + (last + 1))).notFound) last += 1;
  }
  const ids = [];
  for (let i = from; i <= last; i++) ids.push(i);

  const results = [];
  for (let i = 0; i < ids.length; i += concurrency) {
    const batch = ids.slice(i, i + concurrency);
    results.push(...(await Promise.all(batch.map((id) =>
      checkRun(id).catch((err) => ({ id, unchecked: true, problems: [], note: `not checked: ${err.message}` }))))));
    if (!asJson) process.stderr.write(`\rchecked ${results.length}/${ids.length}`);
  }
  if (!asJson) process.stderr.write("\n");

  const runs = results.filter((r) => !r.notFound);
  const flagged = runs.filter((r) => r.problems.length || r.note);
  const unchecked = runs.filter((r) => r.unchecked || r.release === "unchecked");
  const done = runs.filter((r) => r.status === "done");
  const paid = done.reduce((a, r) => a + BigInt(r.paid || 0), 0n);
  const summary = {
    checkedAt: new Date().toISOString(),
    runs: runs.length,
    passed: runs.length - flagged.length,
    flagged: flagged.length,
    unchecked: unchecked.length,
    firstUnchecked: unchecked.length ? Math.min(...unchecked.map((r) => r.id)) : null,
    zecPaidInDoneRuns: (Number(paid) / 1e8).toFixed(8),
    onChainChecks: Boolean(rpcUrl),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, flagged, results }, null, 2));
  } else {
    console.log(summary);
    for (const r of flagged)
      console.log(`run ${r.id} ${r.coin || ""}: ${[r.note, ...r.problems].filter(Boolean).join("; ")}`);
  }
  process.exitCode = flagged.some((r) => r.problems.length) ? 1 : 0;
}

main();
