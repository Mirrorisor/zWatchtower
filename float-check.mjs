#!/usr/bin/env node
// zWatchtower: float check (prototype)
//
// Sapling holds ZEC only briefly: NEAR Intents delivers a payout to a one-time
// transparent "order address", and Sapling forwards it as a shielded note.
// Every order address is derived from public keys Sapling publishes
// (https://sapling.cash/.well-known/sapling-exits.json; stamps SPEC §10.1),
// so anyone can list them and check, without any viewing key:
//   - the float: ZEC sitting in order addresses right now, against the
//     published custody cap (caps.custodyZat) and in-flight cap (caps.inFlight)
//   - stuck payouts: deliveries not forwarded within --stuck-minutes
//   - history: each delivery's hold time, and the peak float ever reached
//
// Data sources (read-only):
//   --source 3xpl   (default) 3xpl API; full history. --api-key for the paid API.
//   --source zebra  --zebra http://127.0.0.1:8232  your own Zebra node; current
//                   float and stuck UTXOs only (getaddressutxos, getblock).
//
// Usage:
//   node float-check.mjs
//   node float-check.mjs --count 200 --gap 50 --stuck-minutes 60 --json
//   node float-check.mjs --source zebra --zebra http://127.0.0.1:8232
import { readFileSync } from "node:fs";
import { orderAddresses } from "./lib/derive.mjs";
import { classifyForward } from "./lib/privacy.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const source = opt("--source", "3xpl");
const apiKey = opt("--api-key", null);
const zebraUrl = opt("--zebra", "http://127.0.0.1:8232");
const count = Number(opt("--count", 100));
const gap = Number(opt("--gap", 40));
const stuckMinutes = Number(opt("--stuck-minutes", 60));
const exitsPath = opt("--exits-file", null);
const asJson = args.includes("--json");
const delayMs = Number(opt("--delay-ms", apiKey ? 100 : 1600));

const ZAT = 1e8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadExits() {
  if (exitsPath) return JSON.parse(readFileSync(exitsPath, "utf8"));
  const r = await fetch("https://sapling.cash/.well-known/sapling-exits.json");
  if (!r.ok) throw new Error(`exits file: HTTP ${r.status}`);
  return r.json();
}

// ---- data sources ---------------------------------------------------------

async function threexplAddress(address) {
  const base = apiKey ? "https://api.3xpl.com" : "https://sandbox-api.3xpl.com";
  const url = `${base}/zcash/address/${address}?data=balances,events&from=all` +
    (apiKey ? `&token=${apiKey}` : "");
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`3xpl ${address}: HTTP ${r.status}`);
    const j = await r.json();
    const bal = j.data?.balances?.["zcash-main"]?.zcash?.balance ?? "0";
    const events = (j.data?.events?.["zcash-main"] ?? [])
      .map((e) => ({ time: Date.parse(e.time), effect: BigInt(e.effect), tx: e.transaction }))
      .sort((a, b) => a.time - b.time);
    return { balance: BigInt(bal), events };
  }
  throw new Error(`3xpl ${address}: still rate-limited`);
}

let zebraId = 0;
async function zebra(method, params) {
  const r = await fetch(zebraUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++zebraId, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}
const blockTime = new Map();
async function zebraAddress(address) {
  const utxos = await zebra("getaddressutxos", [{ addresses: [address] }]);
  const txids = await zebra("getaddresstxids", [{ addresses: [address] }]);
  let balance = 0n;
  const unspent = [];
  for (const u of utxos) {
    balance += BigInt(u.satoshis);
    if (!blockTime.has(u.height)) {
      const b = await zebra("getblock", [String(u.height), 1]);
      blockTime.set(u.height, b.time * 1000);
    }
    unspent.push({ time: blockTime.get(u.height), effect: BigInt(u.satoshis), tx: u.txid });
  }
  // Zebra gives no per-event history cheaply; report used/unused and UTXOs.
  return { balance, events: unspent, used: txids.length > 0 };
}

const lookup = source === "zebra" ? zebraAddress : threexplAddress;

// ---- privacy: where did each forward go? ---------------------------------
// Sapling says it forwards every delivery "as a shielded note". A forward
// whose outputs all land in a shielded pool keeps the payout private; one
// that pays a transparent address (t1…/t3…) does not. 3xpl lists a
// transaction's movements as address/effect events; shielded value shows
// under a pool name rather than an address, and the names seen are reported
// so the classification can be checked.
async function threexplTx(hash) {
  const base = apiKey ? "https://api.3xpl.com" : "https://sandbox-api.3xpl.com";
  const url = `${base}/zcash/transaction/${hash}?data=events` + (apiKey ? `&token=${apiKey}` : "");
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(url);
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`3xpl tx ${hash}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`3xpl tx ${hash}: still rate-limited`);
}


// ---- analysis -------------------------------------------------------------

// Scan at least --count indexes, then keep going until --gap unused in a row.
async function scanAccount(name, pubkey) {
  const rows = [];
  let lastUsed = -1;
  for (let start = 0; ; start += 50) {
    for (const { index, address } of orderAddresses(pubkey, start, 50)) {
      if (index >= count && index > lastUsed + gap) return { rows, lastUsed };
      const info = await lookup(address);
      const used = info.used ?? info.events.length > 0;
      if (used) lastUsed = index;
      rows.push({ account: name, index, address, ...info, used });
      if (!asJson) process.stderr.write(`\r${name}: index ${index}, last used ${lastUsed}   `);
      await sleep(delayMs);
    }
  }
}

function analyse(rows, caps, now) {
  const deliveries = [];
  const timeline = [];
  for (const r of rows) {
    let open = null;
    for (const e of r.events) {
      timeline.push([e.time, e.effect]);
      if (e.effect > 0n) open = { ...r, events: undefined, received: e.effect, at: e.time, tx: e.tx };
      else if (open) {
        deliveries.push({ ...open, forwardedAt: e.time, holdMinutes: (e.time - open.at) / 60000 });
        open = null;
      }
    }
    if (open) deliveries.push({ ...open, forwardedAt: null, holdMinutes: (now - open.at) / 60000 });
  }
  timeline.sort((a, b) => a[0] - b[0]);
  let float = 0n, peak = 0n, peakAt = null;
  for (const [t, eff] of timeline) {
    float += eff;
    if (float > peak) { peak = float; peakAt = t; }
  }
  const current = rows.reduce((a, r) => a + r.balance, 0n);
  const pending = deliveries.filter((d) => d.forwardedAt === null);
  const stuck = pending.filter((d) => d.holdMinutes > stuckMinutes);
  const holds = deliveries.filter((d) => d.forwardedAt !== null).map((d) => d.holdMinutes).sort((a, b) => a - b);
  const pct = (p) => holds.length ? holds[Math.min(holds.length - 1, Math.floor(p * holds.length))] : null;
  const custodyCap = BigInt(caps.custodyZat);
  return {
    currentFloatZec: Number(current) / ZAT,
    custodyCapZec: Number(custodyCap) / ZAT,
    inFlight: pending.length,
    inFlightCap: caps.inFlight,
    withinCaps: current <= custodyCap && pending.length <= caps.inFlight,
    stuck: stuck.map((d) => ({ account: d.account, index: d.index, address: d.address,
      zec: Number(d.received) / ZAT, since: new Date(d.at).toISOString(), minutes: Math.round(d.holdMinutes) })),
    deliveries: deliveries.length,
    deliveredZec: Number(deliveries.reduce((a, d) => a + d.received, 0n)) / ZAT,
    holdMinutes: { median: pct(0.5), p95: pct(0.95), max: holds.at(-1) ?? null },
    peakFloatZec: Number(peak) / ZAT,
    peakAt: peakAt ? new Date(peakAt).toISOString() : null,
  };
}

async function main() {
  const exits = await loadExits();
  const accounts = { "account 0 (sales and sends)": exits.accountPubkey,
    "account 1 (Zcash accounts)": exits.accountsPubkey };
  const rows = [];
  const scanned = {};
  for (const [name, key] of Object.entries(accounts)) {
    if (!key) continue;
    const { rows: r, lastUsed } = await scanAccount(name, key);
    rows.push(...r);
    scanned[name] = { scannedTo: r.at(-1)?.index ?? -1, lastUsedIndex: lastUsed,
      usedAddresses: r.filter((x) => x.used).length };
  }
  if (!asJson) process.stderr.write("\n");
  const report = { checkedAt: new Date().toISOString(), source, scanned,
    ...analyse(rows, exits.caps, Date.now()) };
  if (source === "3xpl" && !args.includes("--no-privacy")) {
    const privacy = { forwards: 0, shielded: 0, transparent: 0, mixed: 0, unknown: 0, poolNames: [], errors: 0, sample: null };
    for (const r of rows) for (const e of r.events) {
      if (e.effect >= 0n || !e.tx) continue;
      try {
        const j = await threexplTx(e.tx);
        const evs = (j.data?.events?.["zcash-main"] ?? []).map((x) => ({ address: x.address, effect: x.effect }));
        privacy.sample ??= { tx: e.tx, events: evs.slice(0, 12) };
        const c = classifyForward(evs, r.address);
        privacy.forwards++; privacy[c.kind]++;
        for (const p of c.pools) if (!privacy.poolNames.includes(p)) privacy.poolNames.push(p);
      } catch { privacy.errors++; }
      await sleep(delayMs);
    }
    report.privacy = privacy;
  }
  if (source === "zebra") {
    delete report.peakFloatZec; delete report.peakAt; delete report.holdMinutes;
    report.note = "zebra source: current float and stuck UTXOs only";
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
  process.exitCode = report.withinCaps && report.stuck.length === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
