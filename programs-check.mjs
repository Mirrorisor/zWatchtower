#!/usr/bin/env node
// zWatchtower: Sapling's programs
//
// Sapling publishes one program address, its vault (watched by keys-check).
// Its Terminal holds users' tokens through another, the `sapling_accounts`
// guard, whose address isn't published. This check finds every program that
// runs in the transactions of Sapling's own wallets, reads who can upgrade
// each, and watches the ones Sapling controls (upgrade authority = Sapling's
// multisig vault or admin): any upgrade, any change of authority, and any
// new one appearing. Programs that run alongside Jupiter are marked, since
// the Terminal trades through Jupiter.
//
// Usage:
//   node programs-check.mjs --rpc URL --state programs-state.json --json
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { encode as b58encode } from "./lib/base58.mjs";
import { programsInTx, programAlerts, tokensHandled, mintRuleBreaks, COMMON, LOADER_UPGRADEABLE, JUPITER } from "./lib/programs.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "programs-state.json");
const perSeed = Number(opt("--per-seed", "50"));
const pauseMs = Number(opt("--pause", "120"));
const asJson = args.includes("--json");
const guardTxs = Number(opt("--guard-txs", "100"));
const pinnedGuard = opt("--guard", null);

const VAULT_PROGRAM = "A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF";
// Whoever holds these can upgrade a program: Sapling's Squads vault, its admin
const SAPLING_AUTHORITIES = new Set([
  "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf",
  "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV",
]);
// Sapling's own wallets and accounts, whose transactions are read
const SEEDS = {
  upgradeAuthority: "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf",
  admin: "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV",
  treasury: "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr",
  rewards: "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL",
  buyback: "3G6yQGLssh4VTNDaGpLn9CgARSZkXk2xRvfeu4f4SLA9",
  buybackSigner: "7fAC78BcLjvh8M5GAPRbJQtVPi7QWzeW4ohxvTtf9Pdu",
  lpWallet: "9JdwzM9QWj9BZhF7u3RoofwhRW4nohha7Sf5jqeyu1gN",
  lpPot: "H8kjBKSsiD5qjth7bDaGupLBG4U9f2ka3YpvkXaGt73z",
  flywheelPot: "Eqg9vQ1tFeJ2viwTNaexrcEgUcZ7DSd6agoU5yvn5kkF",
  ...JSON.parse(opt("--extra-seeds", "{}")),
};

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) {
      if (j.error.code === 429 || /rate/i.test(j.error.message ?? "")) { await sleep(1500 * (attempt + 1)); continue; }
      throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    }
    return j.result;
  }
  throw new Error(`${method}: rate-limited`);
}

// upgrade authority and last deploy slot; immutable programs have neither.
// Read raw with a data slice: a program's data account holds the whole binary.
async function account(address, slice) {
  const r = await rpc("getAccountInfo", [address, { encoding: "base64", ...(slice ? { dataSlice: slice } : {}) }]);
  const v = r?.value;
  return v ? { owner: v.owner, executable: v.executable, data: Buffer.from(v.data[0], "base64") } : null;
}
async function readProgram(id) {
  const v = await account(id, { offset: 0, length: 36 });
  if (!v) return { exists: false, executable: false };
  if (!v.executable || v.owner !== LOADER_UPGRADEABLE || v.data.length < 36 || v.data.readUInt32LE(0) !== 2)
    return { exists: true, executable: v.executable, authority: null, slot: null, loader: v.owner };
  // UpgradeableLoaderState::Program { programdata_address } = u32 tag 2, then 32 bytes
  const pd = await account(b58encode(v.data.subarray(4, 36)), { offset: 0, length: 45 });
  if (!pd || pd.data.length < 13) return { exists: true, executable: true, authority: null, slot: null, loader: v.owner };
  // ProgramData { slot: u64, upgrade_authority: Option<Pubkey> } = u32 tag 3, u64, u8, 32 bytes
  return { exists: true, executable: true, loader: v.owner, slot: Number(pd.data.readBigUInt64LE(4)),
    authority: pd.data[12] === 1 ? b58encode(pd.data.subarray(13, 45)) : null };
}

async function main() {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8"))
    : { lastSig: {}, programs: {}, seen: {}, baselineDone: false };
  const notes = [];
  const seen = state.seen;  // id -> { txs, withJupiter, seeds: [] }
  let txsRead = 0;

  for (const [name, addr] of Object.entries(SEEDS)) {
    let sigs;
    try {
      sigs = await rpc("getSignaturesForAddress", [addr, { limit: perSeed, ...(state.lastSig[name] ? { until: state.lastSig[name] } : {}) }]);
    } catch (e) { notes.push(`${name}: signatures not read (${e.message.slice(0, 80)})`); continue; }
    if (sigs?.length) state.lastSig[name] = sigs[0].signature;
    for (const s of sigs ?? []) {
      if (s.err) continue;
      let tx;
      try { tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); }
      catch (e) { notes.push(`tx ${s.signature.slice(0, 8)}… not read`); continue; }
      txsRead++;
      const { invoked, touched } = programsInTx(tx);
      const withJup = invoked.has(JUPITER);
      for (const id of new Set([...invoked, ...touched])) {
        if (COMMON.has(id)) continue;
        const e = (seen[id] ??= { txs: 0, withJupiter: 0, seeds: [], upgradedIn: 0 });
        e.txs++;
        if (withJup && id !== JUPITER) e.withJupiter++;
        if (touched.has(id)) e.upgradedIn++;
        if (!e.seeds.includes(name)) e.seeds.push(name);
      }
      await sleep(pauseMs);
    }
  }

  // read every program seen (cheap: two accounts each)
  const now = {};
  for (const id of Object.keys(seen)) {
    try {
      const p = await readProgram(id);
      if (!p.executable) continue;              // an account the loader touched that isn't a program
      now[id] = { authority: p.authority, slot: p.slot, loader: p.loader,
        sapling: id === VAULT_PROGRAM || SAPLING_AUTHORITIES.has(p.authority) };
    } catch (e) {
      notes.push(`program ${id.slice(0, 8)}… not read (${e.message.slice(0, 60)})`);
      if (state.programs[id]) now[id] = state.programs[id]; // keep what we knew
    }
    await sleep(pauseMs);
  }
  // a program Sapling controlled that we failed to read keeps its last state
  for (const [id, p] of Object.entries(state.programs)) if (!(id in now) && p.sapling) now[id] = p;

  // the vault's own upgrades are keys-check's alerts; don't repeat them here
  const prevNoVault = { ...state.programs }; delete prevNoVault[VAULT_PROGRAM];
  const nowNoVault = { ...now }; delete nowNoVault[VAULT_PROGRAM];
  const alerts = programAlerts(prevNoVault, nowNoVault, !state.baselineDone);
  if (!state.baselineDone) notes.push("first run: every program found is the baseline, so none is reported as new");
  state.baselineDone = true;
  state.programs = now;
  writeFileSync(statePath, JSON.stringify(state));

  // ---- the Terminal guard's token rules ----------------------------------
  // Which tokens did Terminal trades buy or sell, and does each obey the rules
  // Sapling's docs say the guard enforces? Reported, not alerted, until the
  // way tokens are picked out of a trade has been checked on live data.
  const guards = pinnedGuard ? [pinnedGuard] : Object.entries(now)
    .filter(([id, p]) => p.sapling && id !== VAULT_PROGRAM && (seen[id]?.withJupiter ?? 0) > 0).map(([id]) => id);
  state.terminal ??= { lastSig: {}, tokens: {} };
  const tokens = state.terminal.tokens; // mint -> { bought, sold, firstTx, breaks }
  let guardTxsRead = 0;
  for (const g of guards) {
    let sigs = [];
    try { sigs = await rpc("getSignaturesForAddress", [g, { limit: guardTxs, ...(state.terminal.lastSig[g] ? { until: state.terminal.lastSig[g] } : {}) }]); }
    catch (e) { notes.push(`guard ${g.slice(0, 8)}…: signatures not read`); continue; }
    if (sigs.length) state.terminal.lastSig[g] = sigs[0].signature;
    for (const s of sigs) {
      if (s.err) continue;
      let tx;
      try { tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]); }
      catch { continue; }
      guardTxsRead++;
      const { bought, sold } = tokensHandled(tx);
      for (const m of bought) { (tokens[m] ??= { bought: 0, sold: 0, firstTx: s.signature, breaks: null }).bought++; }
      for (const m of sold) { (tokens[m] ??= { bought: 0, sold: 0, firstTx: s.signature, breaks: null }).sold++; }
      await sleep(pauseMs);
    }
  }
  const unread = Object.keys(tokens).filter((m) => tokens[m].breaks === null);
  for (let i = 0; i < unread.length; i += 100) {
    const batch = unread.slice(i, i + 100);
    try {
      const res = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
      batch.forEach((m, j) => {
        const info = res?.value?.[j]?.data?.parsed?.info;
        if (info) tokens[m].breaks = mintRuleBreaks(info);
      });
    } catch { notes.push("Terminal token mints not read this run"); }
  }
  const breaking = Object.entries(tokens).filter(([, t]) => t.breaks?.length)
    .map(([mint, t]) => ({ mint, breaks: t.breaks, bought: t.bought, sold: t.sold, firstTx: t.firstTx }));
  const terminal = { guards, txsRead: guardTxsRead, tokensSeen: Object.keys(tokens).length,
    tokensChecked: Object.values(tokens).filter((t) => t.breaks !== null).length, breakingRules: breaking };
  writeFileSync(statePath, JSON.stringify(state));

  const sapling = Object.entries(now).filter(([, p]) => p.sapling).map(([id, p]) => ({
    id, authority: p.authority, lastDeploySlot: p.slot,
    seenInTxs: seen[id]?.txs ?? 0, withJupiter: seen[id]?.withJupiter ?? 0, seeds: seen[id]?.seeds ?? [],
    role: id === VAULT_PROGRAM ? "vault (sapling_vault)" : (seen[id]?.withJupiter ? "trades through Jupiter: likely the Terminal guard (sapling_accounts)" : "unknown"),
  }));
  const others = Object.entries(now).filter(([, p]) => !p.sapling)
    .map(([id, p]) => ({ id, authority: p.authority, seenInTxs: seen[id]?.txs ?? 0 }))
    .sort((a, b) => b.seenInTxs - a.seenInTxs).slice(0, 15);
  const report = { checkedAt: new Date().toISOString(), txsRead, saplingPrograms: sapling, otherPrograms: others, terminal,
    programsSeen: Object.keys(now).length, notes, alerts };
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
