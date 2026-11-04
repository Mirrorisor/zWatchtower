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

import { isOnCurve } from "./lib/coins.mjs";
import { createHash } from "node:crypto";
import { readBasket, judgeBasket } from "./lib/basket.mjs";
import { redact } from "./lib/redact.mjs";
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
// earlier runs to check again as well (e.g. ones with alerts still open)
const extraRuns = (opt("--runs", "") || "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0);
const concurrency = Number(opt("--concurrency", 8));

const hex = (buf) => Buffer.from(buf).toString("hex");
// node:crypto works on every Node from 18 (the global WebCrypto object doesn't)
const sha256 = async (s) => createHash("sha256").update(s).digest("hex");

async function getJson(url, init, attempts = 3) {
  let status = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const r = await fetch(url, init);
    if (r.status === 404) return { notFound: true };
    if (r.ok) return r.json();
    status = r.status;
    // rate limited: back off harder
    await new Promise((res) => setTimeout(res, (r.status === 429 ? 2000 * 2 ** attempt : 1000 * (attempt + 1))));
  }
  throw new Error(`HTTP error${status ? ` ${status}` : ""} for ${redact(url)}`);
}
// RPC calls share one small pool, so re-checking several runs at once doesn't trip the provider's rate limit
let inFlight = 0;
const waiting = [];
async function slot(fn) {
  while (inFlight >= 3) await new Promise((r) => waiting.push(r));
  inFlight++;
  try { return await fn(); } finally { inFlight--; waiting.shift()?.(); }
}

async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const j = await slot(() => getJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }, 6));
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
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 },
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

// For up to 3 confirmed payout rows that name their transaction, the ZEC the
// holder actually received in it.
async function sampleReceived(holders, payouts) {
  const out = [];
  for (const [owner] of holders) {
    const row = payouts.get(owner);
    const sig = row && Object.entries(row).find(([k, v]) => /sig/i.test(k) && typeof v === "string" && v.length > 60)?.[1];
    if (!sig || row.status !== "confirmed") continue;
    try {
      const tx = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
      const m = tx?.meta;
      const post = m?.postTokenBalances?.find((b) => b.owner === owner && b.mint === ZEC_MINT);
      const pre = post && m.preTokenBalances.find((b) => b.accountIndex === post.accountIndex);
      const entry = { owner: owner.slice(0, 6), share: row.share, rentZec: row.rentZec ?? null,
        received: post ? String(BigInt(post.uiTokenAmount.amount) - BigInt(pre ? pre.uiTokenAmount.amount : 0)) : "no ZEC account change" };
      // for the first one, every token balance that moved in that transaction: where did the rest go?
      if (!out.length && m) {
        const key = (b) => `${b.owner}|${b.mint}`;
        const net = new Map();
        for (const b of m.preTokenBalances ?? []) net.set(key(b), (net.get(key(b)) ?? 0n) - BigInt(b.uiTokenAmount.amount));
        for (const b of m.postTokenBalances ?? []) net.set(key(b), (net.get(key(b)) ?? 0n) + BigInt(b.uiTokenAmount.amount));
        entry.txMoves = [...net].filter(([, v]) => v !== 0n).map(([k, v]) => {
          const [o, mint] = k.split("|");
          return { owner: o === REWARDS_WALLET ? "rewards wallet" : o, mint: mint === ZEC_MINT ? "ZEC" : mint, delta: String(v) };
        });
        entry.signature = sig;
        // everything this holder received from the rewards wallet within 20 minutes of this payout:
        // one payment (shares really are smaller) or several (paid in parts)?
        try {
          const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
          const ata = keys[post.accountIndex];
          const sigs = await rpc("getSignaturesForAddress", [ata, { limit: 100 }]);
          const t0 = tx.blockTime;
          let total = 0n, payments = 0;
          for (const x of sigs ?? []) {
            if (x.err || x.blockTime == null || Math.abs(x.blockTime - t0) > 20 * 60) continue;
            const t = await rpc("getTransaction", [x.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
            const mm = t?.meta; if (!mm) continue;
            const d = (o) => {
              const po = mm.postTokenBalances?.find((b) => b.owner === o && b.mint === ZEC_MINT);
              if (!po) return 0n;
              const pr = mm.preTokenBalances?.find((b) => b.accountIndex === po.accountIndex);
              return BigInt(po.uiTokenAmount.amount) - BigInt(pr ? pr.uiTokenAmount.amount : 0);
            };
            if (d(REWARDS_WALLET) < 0n && d(owner) > 0n) { total += d(owner); payments++; }
          }
          entry.fromRewardsWithin20min = { payments, total: String(total), share: row.share };
        } catch (e) { entry.fromRewardsWithin20min = { error: e.message.slice(0, 60) }; }
      }
      out.push(entry);
    } catch (e) { out.push({ owner: owner.slice(0, 6), error: e.message.slice(0, 60) }); }
    if (out.length >= 3) break;
  }
  // and what the rewards wallet holds now
  try {
    const accts = await rpc("getTokenAccountsByOwner", [REWARDS_WALLET, { mint: ZEC_MINT }, { encoding: "jsonParsed" }]);
    const held = (accts?.value ?? []).reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
    out.push({ rewardsWalletHoldsZat: String(held) });
  } catch {}
  return out.length ? out : "payout rows don't name a transaction";
}

// When shares don't match the published formula, test simple alternatives so
// the report says which one Sapling's numbers fit (or that none does).
function diagnoseShares(holders, payouts, run, pot, sum, e) {
  const rows = holders.map(([owner, bal]) => ({ owner, bal: BigInt(bal), row: payouts.get(owner) })).filter((x) => x.row);
  const shareSum = rows.reduce((a, x) => a + BigInt(x.row.share), 0n);
  const fits = (potX, sumX, filter = () => true) => rows.filter(filter)
    .every((x) => BigInt(x.row.share) === (potX * x.bal) / sumX);
  const rent = BigInt(run.rentZec || 0), rolled = BigInt(run.rolledOver || 0), paid = BigInt(run.paid);
  const eligible = (x) => !e || (Number(x.bal) / 10 ** TOKEN_DECIMALS) * Number(e.zecPerToken) * Number(e.zecUsd) >= MIN_HOLDING_USD;
  const sumEligible = rows.filter(eligible).reduce((a, x) => a + x.bal, 0n);
  const tries = {
    "pot minus rent": rent > 0n && fits(pot - rent, sum),
    "pot minus rolled over": rolled > 0n && fits(pot - rolled, sum),
    "paid plus rent": fits(paid + rent, sum),
    "sum of eligible holders only": sumEligible > 0n && fits(pot, sumEligible),
  };
  const bad = rows.filter((x) => BigInt(x.row.share) !== (pot * x.bal) / sum);
  // how far off: formula share / published share, per row
  const ratios = rows.filter((x) => BigInt(x.row.share) > 0n).map((x) => Number((pot * x.bal) / sum) / Number(x.row.share));
  return {
    ratio: ratios.length ? { min: Math.min(...ratios).toFixed(4), max: Math.max(...ratios).toFixed(4) } : null,
    rowFields: Object.keys(rows[0]?.row ?? {}),
    pot: String(pot), sumOfBalances: String(sum), sumOfShares: String(shareSum), paid: String(paid), rent: String(rent),
    rolledOver: String(rolled), holders: holders.length, payoutRows: payouts.size,
    explainedBy: Object.entries(tries).filter(([, ok]) => ok).map(([k]) => k),
    sample: bad.slice(0, 3).map((x) => ({ owner: x.owner.slice(0, 6), balance: String(x.bal), expected: String((pot * x.bal) / sum),
      share: x.row.share, status: x.row.status })),
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
  ownersByRun.set(id, new Set(payouts.keys()));
  if (run.releaseSignature) releases.set(id, run.releaseSignature);
  runData.set(id, { holders: s.holders, payouts, pot, paid: BigInt(run.paid), rent: BigInt(run.rentZec || 0),
    rolled: BigInt(run.rolledOver || 0), release: run.releaseSignature ?? null, coin: run.symbol,
    mint: run.mint ?? run.coinMint ?? run.tokenMint ?? null, runFields: Object.keys(run) });
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
  if (badShares) {
    p(`${badShares} shares not floor(pot*balance/sum)`);
    out.diagnosis = diagnoseShares(s.holders, payouts, run, pot, sum, e);
    // what did a few holders actually receive on chain?
    if (rpcUrl) out.diagnosis.onChain = await sampleReceived(s.holders, payouts);
  }
  if (missing) p(`${missing} holders without a payout row`);
  if (extra) p(`${extra} payout rows for non-holders`);
  if (below) p(`${below} holders below the $${MIN_HOLDING_USD} minimum`);
  if (!e) p("no eligibility prices published");
  if (pot !== BigInt(run.paid) + BigInt(run.rolledOver || 0) + BigInt(run.rentZec || 0))
    p("pot != paid + rolledOver + rent");

  // Shares off by a whole factor: is the run paid as a basket of tokens? The
  // payout rows then list only the ZEC leg; read the other legs from the chain.
  // (only when every share is well under its formula share, as one leg of a split is)
  const legLike = badShares && s.holders.every(([owner, bal]) => {
    const row = payouts.get(owner);
    return !row || BigInt(row.share) === 0n || BigInt(row.share) * 3n <= ((pot * BigInt(bal)) / sum) * 2n;
  });
  if (legLike && rpcUrl && run.releaseSignature) {
    try {
      const rel = await rpc("getTransaction", [run.releaseSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
      const b = rel?.meta?.postTokenBalances?.find((x) => x.owner === REWARDS_WALLET && x.mint === ZEC_MINT);
      const zecAta = b && (rel.transaction.message.accountKeys[b.accountIndex]?.pubkey ?? rel.transaction.message.accountKeys[b.accountIndex]);
      if (!zecAta) throw new Error("rewards wallet not in the release");
      // the run's own window: from its release to its return of the rolled-over ZEC
      const ret = run.returnSignature ? await rpc("getTransaction", [run.returnSignature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]) : null;
      const t0 = rel.blockTime, t1 = ret?.blockTime ?? Math.ceil(Date.parse(run.finishedAt) / 1000);
      if (!t0 || !Number.isFinite(t1)) throw new Error("can't tell when the run started and ended");
      const rows = s.holders.map(([owner, balance]) => ({ owner, balance, row: payouts.get(owner) }))
        .filter((x) => x.row?.status === "confirmed").map((x) => ({ owner: x.owner, balance: x.balance, share: x.row.share }));
      // what Sapling paid beyond the ZEC shares went to the swaps
      const otherZat = BigInt(run.paid) - rows.reduce((a, r) => a + BigInt(r.share), 0n);
      const basket = await readBasket(rpc, { zecAta, start: t0 - 2, end: t1 + 2, holders: new Set(payouts.keys()), otherZat: otherZat > 0n ? otherZat : null });
      const j2 = judgeBasket({ rows, pot, sum, paid: BigInt(run.paid) }, basket);
      out.basket = j2;
      if (j2.inconclusive) throw new Error(j2.problems[0]);
      if (j2.ok) {
        out.problems = out.problems.filter((x) => !/shares not floor/.test(x));
        delete out.diagnosis;
        out.note = `paid as a basket of ${j2.tokens.length} tokens (${j2.tokens.join(", ")}): every holder got each token in proportion to their share`;
      } else p(`basket payout doesn't add up: ${j2.problems.join("; ")}`);
    } catch (err) {
      // couldn't read the other legs: not checked (an open alert stays open), not a finding
      out.basket = { error: err.message.slice(0, 80) };
      out.unchecked = true;
      out.problems = out.problems.filter((x) => !/shares not floor/.test(x));
      delete out.diagnosis;
      out.note = `not checked: shares look like one leg of a basket, and the other legs couldn't be read or told apart (${out.basket.error})`;
    }
  }
  // paid covers every leg of a basket, the rows only the ZEC leg
  if (BigInt(run.paid) !== confirmed - rent && !out.basket?.ok && !out.unchecked) p("paid != confirmed shares - rent");

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

// ---- follow the money: every payment out of the rewards wallet in the two
// hours after a flagged run's release, sorted by who received it.
const TREASURY = "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr";
const ownersByRun = new Map();   // run id -> Set of owners in its payout rows
const runData = new Map();       // run id -> holders, payouts, pot… (done runs)

// Runs that share one release transaction are batches of one distribution:
// each lists the whole pot, and shares are of the whole group's balances.
// Re-check the formula across the group; true when every share then fits.
function checkBatchGroup(ids) {
  const rs = ids.map((i) => runData.get(i));
  const pot = rs[0].pot;
  if (!rs.every((r) => r.pot === pot)) return { ok: false, why: "batches list different pots" };
  const sumAll = rs.reduce((a, r) => a + r.holders.reduce((b, [, bal]) => b + BigInt(bal), 0n), 0n);
  let bad = 0, shares = 0n, confirmedMinusRent = 0n;
  for (const r of rs) for (const [owner, bal] of r.holders) {
    const row = r.payouts.get(owner); if (!row) continue;
    shares += BigInt(row.share);
    if (BigInt(row.share) !== (pot * BigInt(bal)) / sumAll) bad++;
    if (row.status === "confirmed") confirmedMinusRent += BigInt(row.share) - BigInt(row.rentZec || 0);
  }
  return { ok: bad === 0, badShares: bad, batches: ids.length, pot: String(pot), sumOfShares: String(shares), paidToHolders: String(confirmedMinusRent) };
}
const releases = new Map();      // run id -> release signature
async function followMoney(runId) {
  const sig = releases.get(runId);
  const rel = await rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  const keysOf = (tx) => tx.transaction.message.accountKeys.map((k) => k.pubkey ?? k);
  const rw = rel.meta.postTokenBalances.find((b) => b.owner === REWARDS_WALLET && b.mint === ZEC_MINT);
  if (!rw) return { error: "rewards wallet not in the release" };
  const ata = keysOf(rel)[rw.accountIndex], t0 = rel.blockTime, t1 = t0 + 2 * 3600;
  const sigs = (await rpc("getSignaturesForAddress", [ata, { limit: 1000 }])) ?? [];
  const inWindow = sigs.filter((x) => !x.err && x.blockTime >= t0 && x.blockTime <= t1);
  const own = ownersByRun.get(runId) ?? new Set();
  const others = new Set([...ownersByRun].filter(([id]) => id !== runId).flatMap(([, set]) => [...set]));
  const by = { thisRunHolders: 0n, treasury: 0n, otherRunsHolders: 0n, unknown: 0n };
  const unknown = new Map(), unknownTx = new Map();
  let inflow = 0n, outflow = 0n, txs = 0;
  for (const x of inWindow.slice(0, 150)) {
    const tx = await rpc("getTransaction", [x.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
    const m = tx?.meta; if (!m) continue;
    txs++;
    const net = new Map();
    for (const b of m.preTokenBalances ?? []) if (b.mint === ZEC_MINT) net.set(b.owner, (net.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount));
    for (const b of m.postTokenBalances ?? []) if (b.mint === ZEC_MINT) net.set(b.owner, (net.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    const mine = net.get(REWARDS_WALLET) ?? 0n;
    if (mine > 0n) { inflow += mine; continue; }
    if (mine === 0n) continue;
    outflow += -mine;
    for (const [o, v] of net) {
      if (o === REWARDS_WALLET || v <= 0n) continue;
      const k = own.has(o) ? "thisRunHolders" : o === TREASURY ? "treasury" : others.has(o) ? "otherRunsHolders" : "unknown";
      by[k] += v;
      if (k === "unknown") { unknown.set(o, (unknown.get(o) ?? 0n) + v); if (!unknownTx.has(o)) unknownTx.set(o, x.signature); }
    }
  }
  // The coin's biggest holdings, including program-controlled ones that holder
  // lists leave out: is a big share held through Sapling accounts (the Terminal
  // guard's holdings)? Their owners are program addresses owned by the guard.
  let holdings = null;
  const rd = runData.get(runId);
  if (rd?.mint) {
    try {
      const largest = (await rpc("getTokenLargestAccounts", [rd.mint]))?.value ?? [];
      const info = (await rpc("getMultipleAccounts", [largest.map((a) => a.address), { encoding: "jsonParsed" }]))?.value ?? [];
      const owners = largest.map((a, i) => info[i]?.data?.parsed?.info?.owner ?? null);
      const ownerAccts = (await rpc("getMultipleAccounts", [owners.filter(Boolean), { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]))?.value ?? [];
      const progOf = new Map(owners.filter(Boolean).map((o, i) => [o, ownerAccts[i]?.owner ?? null]));
      const listed = new Set(rd.holders.map(([o]) => o));
      const snapshotSum = rd.holders.reduce((a, [, b]) => a + BigInt(b), 0n);
      const rows = largest.map((a, i) => ({ owner: owners[i], amount: a.amount, wallet: owners[i] ? isOnCurve(owners[i]) : null,
        ownerProgram: progOf.get(owners[i]) ?? null, inSnapshot: listed.has(owners[i]) }));
      const unlisted = rows.filter((r) => !r.inSnapshot);
      const byProgram = {};
      for (const r of unlisted) { const k = r.wallet ? "wallet" : (r.ownerProgram ?? "unknown"); byProgram[k] = String(BigInt(byProgram[k] ?? 0) + BigInt(r.amount)); }
      holdings = { mint: rd.mint, snapshotSum: String(snapshotSum), top20: rows.map((r) => ({ ...r, owner: r.owner && r.owner.slice(0, 8) })),
        notInSnapshotByOwnerProgram: byProgram };
    } catch (e) { holdings = { error: e.message.slice(0, 80) }; }
  } else holdings = { note: "the run doesn't name its coin's mint", runFields: rd?.runFields };
  return { run: runId, holdings, releaseAt: new Date(t0 * 1000).toISOString(), window: "2 hours after the release",
    txsRead: txs, txsInWindow: inWindow.length, inflow: String(inflow), outflow: String(outflow),
    to: Object.fromEntries(Object.entries(by).map(([k, v]) => [k, String(v)])),
    topUnknown: await Promise.all([...unknown].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 5).map(async ([o, v]) => {
      // who is it? a normal wallet (on the curve) or a program's address, and what owns its account
      let account = null;
      try {
        const a = await rpc("getAccountInfo", [o, { encoding: "base64", dataSlice: { offset: 0, length: 0 } }]);
        account = a?.value ? { owner: a.value.owner, executable: a.value.executable, lamports: a.value.lamports } : "no account";
      } catch {}
      // what happened to the ZEC afterwards: still there, or sent on, and by which programs
      let after = null;
      try {
        const ta = await rpc("getTokenAccountsByOwner", [o, { mint: ZEC_MINT }, { encoding: "jsonParsed" }]);
        const acct = ta?.value?.[0];
        if (acct) {
          const sigs2 = (await rpc("getSignaturesForAddress", [acct.pubkey, { limit: 5 }])) ?? [];
          const progs = new Set();
          for (const x2 of sigs2.slice(0, 3)) {
            if (x2.signature === unknownTx.get(o)) continue;
            const t2 = await rpc("getTransaction", [x2.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
            for (const ix of [...(t2?.transaction?.message?.instructions ?? []), ...((t2?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? []))])
              if (ix.programId) progs.add(ix.programId);
          }
          after = { zecLeft: acct.account.data.parsed.info.tokenAmount.amount, laterTxs: sigs2.length - 1, programs: [...progs] };
        } else after = { zecAccount: "closed" };
      } catch (e) { after = { error: e.message.slice(0, 50) }; }
      return { owner: o, zat: String(v), wallet: isOnCurve(o), account, after, firstTx: unknownTx.get(o),
        alsoHolderOf: [...ownersByRun].filter(([, set]) => set.has(o)).map(([id]) => id) };
    })) };
}

async function main() {
  let last = to;
  if (last === null) {
    // find the newest run by probing upward
    last = from;
    while (!(await getJson(API + (last + 100))).notFound) last += 100;
    while (!(await getJson(API + (last + 1))).notFound) last += 1;
  }
  const ids = extraRuns.filter((i) => i < from);
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
    // a run paid as a basket that checks out has a note, not a problem: it passed
    passed: runs.length - flagged.filter((r) => !(r.basket?.ok && !r.problems.length)).length,
    flagged: flagged.length,
    unchecked: unchecked.length,
    // only the range decides where the next pass starts; re-checked older runs (--runs) don't move it
    firstUnchecked: unchecked.some((r) => r.id >= from) ? Math.min(...unchecked.filter((r) => r.id >= from).map((r) => r.id)) : null,
    zecPaidInDoneRuns: (Number(paid) / 1e8).toFixed(8),
    onChainChecks: Boolean(rpcUrl),
    checkedIds: runs.filter((r) => !r.unchecked && r.release !== "unchecked").map((r) => r.id),
    // the tokens each verified basket run paid, for the rewards explorer
    baskets: runs.filter((r) => r.basket?.ok).map((r) => ({ id: r.id, mint: runData.get(r.id)?.mint ?? null, tokens: r.basket.tokens })),
  };
  // batches: flagged runs whose release transaction is shared with other runs
  const byRelease = new Map();
  for (const [id, r] of runData) if (r.release) { if (!byRelease.has(r.release)) byRelease.set(r.release, []); byRelease.get(r.release).push(id); }
  const groups = [];
  for (const ids of byRelease.values()) {
    if (ids.length < 2 || !ids.some((i) => flagged.some((f) => f.id === i && f.diagnosis))) continue;
    const g = { runs: ids.sort((a, b) => a - b), ...checkBatchGroup(ids) };
    groups.push(g);
    if (g.ok) for (const f of flagged) if (ids.includes(f.id)) {
      // the shares fit the whole distribution: not a problem with Sapling's payouts
      f.problems = f.problems.filter((x) => !/shares not floor|paid != confirmed shares/.test(x));
      f.note = `paid in ${ids.length} batches sharing one release (runs ${g.runs.join(", ")}); shares fit the whole distribution`;
    }
  }
  if (groups.length) summary.batchGroups = groups;
  summary.distinctReleases = byRelease.size;
  summary.runsWithRelease = [...runData.values()].filter((r) => r.release).length;

  // where a flagged run's pot went, for the first one whose shares are off
  const traced = flagged.find((r) => r.diagnosis && releases.has(r.id));
  if (rpcUrl && traced) {
    try { summary.followTheMoney = await followMoney(traced.id); }
    catch (e) { summary.followTheMoney = { run: traced.id, error: e.message.slice(0, 80) }; }
  }

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
