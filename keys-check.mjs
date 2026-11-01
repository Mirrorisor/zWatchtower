#!/usr/bin/env node
// zWatchtower: keys check (prototype)
//
// Watches the privileged parts of Sapling on Solana and alerts when they move:
//   1. Upgrades: the vault program's upgrade authority must be the published
//      2-of-3 Squads multisig vault, and its last-deployed slot must not change
//      without warning.
//   2. Config: any change to the vault's on-chain Config account (fee split,
//      treasury, rewards or buyback wallets, pauses). Reports which known
//      wallets appeared or disappeared from it.
//   3. Instructions: recent vault-program transactions, sorted by Anchor
//      instruction name into routine (keeper work), privileged (multisig or
//      admin actions named in Sapling's docs) and unrecognised.
//   4. Multisig (with --squads-multisig): recent Squads proposals, approvals
//      and executions, so an upgrade is visible before it lands.
//
// State is kept in a JSON file between runs; the first run records a baseline.
//
// Usage:
//   node keys-check.mjs --rpc https://api.mainnet-beta.solana.com
//   node keys-check.mjs --rpc URL --state keys-state.json --webhook https://...
//   node keys-check.mjs --rpc URL --squads-multisig <multisig account> --json
//
// Read-only. Exit code 1 when there is an alert.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { decode as b58decode, encode as b58encode } from "./lib/base58.mjs";

// Published by Sapling (sapling.cash/docs, DefiLlama PR #10285)
const VAULT_PROGRAM = "A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF";
const VAULT_CONFIG = "8z2Rv1dKQgA5pqT8kiNmkAmAUDRVHwXhuxrhEoa6QyRy";
const EXPECTED_UPGRADE_AUTHORITY = "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf";
const KNOWN_WALLETS = {
  treasury: "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr",
  rewards: "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL",
  buyback: "3G6yQGLssh4VTNDaGpLn9CgARSZkXk2xRvfeu4f4SLA9",
  lpWallet: "9JdwzM9QWj9BZhF7u3RoofwhRW4nohha7Sf5jqeyu1gN",
  lpPot: "H8kjBKSsiD5qjth7bDaGupLBG4U9f2ka3YpvkXaGt73z",
  upgradeAuthority: EXPECTED_UPGRADE_AUTHORITY,
  // Found in the config on the first live run (2026-10-29), at offsets 8 and 169
  admin: "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV",
  recovery: "Dpyf8nA6xPSTnjaX7K3hgq3uPJncJSJRtYjudPHoCwuv",
};
const UPGRADEABLE_LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SQUADS_V4 = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
// The Squads multisig whose vault (3eCXkz…) is the upgrade authority. Found
// from the 2026-10-29 upgrade's VaultTransactionExecute.
const DEFAULT_MULTISIG = "7f4YokHyJYqTEcsCs1YVqyr4MdbJifjMhYRCCNFXPX59";

// Instruction names from Sapling's docs. Anchor's discriminator for an
// instruction is sha256("global:<name>")[0..8].
// observe_sapling, release_rewards, close_rewards_run: seen run by the keeper
// (78Az2c…) on 2026-10-29. The rest arrived with Raydium LaunchLab coins in
// the 2026-10-29 04:28 UTC upgrade: collecting the coins' transfer-fee tax,
// selling it for ZEC, collecting LP and creator fees, and flywheel buybacks.
const VAULT_ROUTINE = ["settle", "roots_to_pot", "draw_lp", "draw_donation", "draw_zec_payee", "redeem",
  "observe_sapling", "release_rewards", "close_rewards_run",
  "withdraw_tax", "sell_tax", "settle_tax", "collect_creator_fee", "collect_pool_fees", "draw_grove", "close_grove"];
const VAULT_PRIVILEGED = ["retire_roots", "set_lp", "init_donation", "set_donation",
  "pause_donations", "set_zec_payees", "pause_zec_payees"];
const SQUADS = ["multisig_create_v2", "config_transaction_create", "config_transaction_execute",
  "vault_transaction_create", "transaction_buffer_create", "vault_transaction_create_from_buffer",
  "proposal_create", "proposal_activate", "proposal_approve", "proposal_reject", "proposal_cancel",
  "vault_transaction_execute", "batch_create", "batch_add_transaction", "batch_execute_transaction",
  "spending_limit_use", "config_transaction_accounts_close", "vault_transaction_accounts_close"];
const SQUADS_ALERT = new Set(["config_transaction_create", "config_transaction_execute",
  "vault_transaction_create", "vault_transaction_create_from_buffer", "proposal_create",
  "proposal_activate", "proposal_approve", "vault_transaction_execute", "batch_execute_transaction"]);

const disc = (name) => createHash("sha256").update("global:" + name).digest().subarray(0, 8).toString("hex");
const byDisc = (names, kind) => Object.fromEntries(names.map((n) => [disc(n), { name: n, kind }]));
const VAULT_IX = { ...byDisc(VAULT_ROUTINE, "routine"), ...byDisc(VAULT_PRIVILEGED, "privileged") };
const SQUADS_IX = byDisc(SQUADS, "squads");

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "keys-state.json");
const webhook = opt("--webhook", null);
const multisig = args.includes("--no-squads") ? null : opt("--squads-multisig", DEFAULT_MULTISIG);
const txLimit = Number(opt("--limit", 100));
const asJson = args.includes("--json");

let rpcId = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
    return j.result;
  }
  throw new Error(`${method}: rate-limited`);
}
const accountData = async (address, slice) => {
  const r = await rpc("getAccountInfo", [address, { encoding: "base64", ...(slice ? { dataSlice: slice } : {}) }]);
  return r?.value ? { owner: r.value.owner, data: Buffer.from(r.value.data[0], "base64") } : null;
};

// 1. Upgrade authority and last deploy slot
async function checkProgram() {
  const prog = await accountData(VAULT_PROGRAM);
  if (!prog || prog.owner !== UPGRADEABLE_LOADER) return { error: "vault program is not an upgradeable program" };
  // UpgradeableLoaderState::Program { programdata_address } = u32 tag 2, then 32 bytes
  const programData = b58encode(prog.data.subarray(4, 36));
  // ProgramData { slot: u64, upgrade_authority: Option<Pubkey> } = u32 tag 3, u64, u8, 32 bytes
  const pd = await accountData(programData, { offset: 0, length: 45 });
  const slot = Number(pd.data.readBigUInt64LE(4));
  const authority = pd.data[12] === 1 ? b58encode(pd.data.subarray(13, 45)) : null;
  return { programData, lastDeploySlot: slot, upgradeAuthority: authority };
}

// 2. Config account fingerprint and the known wallets it contains
async function checkConfig() {
  const acc = await accountData(VAULT_CONFIG);
  if (!acc) return { error: "config account not found" };
  const present = {};
  for (const [label, addr] of Object.entries(KNOWN_WALLETS)) {
    const i = acc.data.indexOf(b58decode(addr));
    if (i >= 0) present[label] = i;
  }
  return { owner: acc.owner, size: acc.data.length,
    sha256: createHash("sha256").update(acc.data).digest("hex"), dataHex: acc.data.toString("hex"), present };
}

// Squads v4 Multisig account: who can approve, and how many must.
// Layout: disc 8, create_key 32, config_authority 32, threshold u16,
// time_lock u32, transaction_index u64, stale_transaction_index u64,
// rent_collector Option<Pubkey>, bump u8, members Vec<{ key 32, permissions u8 }>
async function checkMultisig(address) {
  const acc = await accountData(address);
  if (!acc) return { error: "multisig account not found" };
  if (acc.owner !== SQUADS_V4) return { error: `multisig account owner is ${acc.owner}, not Squads` };
  const d = acc.data;
  if (d.subarray(0, 8).toString("hex") !== createHash("sha256").update("account:Multisig").digest().subarray(0, 8).toString("hex"))
    return { error: "account is not a Squads Multisig" };
  let p = 8 + 32;
  const configAuthority = b58encode(d.subarray(p, p + 32)); p += 32;
  const threshold = d.readUInt16LE(p); p += 2;
  const timeLockSeconds = d.readUInt32LE(p); p += 4;
  const transactionIndex = Number(d.readBigUInt64LE(p)); p += 8;
  const staleTransactionIndex = Number(d.readBigUInt64LE(p)); p += 8;
  p += d[p] === 1 ? 33 : 1;
  p += 1;
  const n = d.readUInt32LE(p); p += 4;
  const members = [];
  for (let i = 0; i < n; i++, p += 33) members.push({ key: b58encode(d.subarray(p, p + 32)), permissions: d[p + 32] });
  return { threshold, memberCount: members.length, members, timeLockSeconds,
    configAuthority: configAuthority === "11111111111111111111111111111111" ? null : configAuthority,
    transactionIndex, staleTransactionIndex };
}

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
// Walks the invoke stack in the logs; returns each instruction the program ran,
// and which program called it (null = called directly by the transaction).
function logInstructions(logs, programId) {
  const stack = [], out = [];
  for (const line of logs) {
    let m;
    if ((m = line.match(/^Program (\w+) invoke \[\d+\]/))) stack.push(m[1]);
    else if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    else if ((m = line.match(/^Program log: Instruction: (\w+)/)) && stack.at(-1) === programId)
      out.push({ name: snake(m[1]), caller: stack.length > 1 ? stack.at(-2) : null });
  }
  return out;
}
// Routine = keeper work named in Sapling's docs. Anything run through the
// Squads multisig, signed by the admin, or named as privileged in the docs is
// privileged. Everything else is listed as unrecognised.
function classify(table, name, caller, signers) {
  const known = Object.values(table).find((x) => x.name === name);
  if (known?.kind === "privileged") return "privileged";
  if (caller === SQUADS_V4 || signers.includes(KNOWN_WALLETS.admin)) return "privileged";
  return known?.kind ?? "unrecognised";
}

// 3 and 4. Recent instructions, named from logs or by Anchor discriminator
async function recentInstructions(address, programId, table, sinceSig) {
  const sigs = await rpc("getSignaturesForAddress", [address, { limit: txLimit, ...(sinceSig ? { until: sinceSig } : {}) }]);
  const out = [];
  for (const s of sigs.filter((x) => !x.err)) {
    const tx = await rpc("getTransaction", [s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]);
    if (!tx) continue;
    const ixs = [...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
    // Anchor logs "Instruction: <Name>" for each instruction it runs; read the
    // names from the logs (with who called the program), falling back to the
    // discriminator table when logs are missing or truncated.
    const fromLogs = logInstructions(tx.meta?.logMessages ?? [], programId);
    const signers = tx.transaction.message.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
    const base = { signature: s.signature, slot: s.slot,
      time: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null, signers };
    if (fromLogs.length) {
      for (const { name, caller } of fromLogs) out.push({ ...base, name, caller, kind: classify(table, name, caller, signers) });
      continue;
    }
    for (const ix of ixs) {
      if (ix.programId !== programId || !ix.data) continue;
      const d = b58decode(ix.data).subarray(0, 8).toString("hex");
      const known = table[d];
      out.push({ ...base, name: known?.name ?? `unrecognised:${d}`, kind: known?.kind ?? "unrecognised" });
    }
  }
  return { newest: sigs[0]?.signature ?? sinceSig ?? null, instructions: out };
}

// Bytes the program rewrites on its own during normal operation: an i64 Unix
// timestamp at 342 (seen moving 30-31 Oct 2026 with no admin action). A change
// that only touches these is not reported.
// Also bytes 137-168: a coin mint the program writes in and clears again within
// the hour during buybacks (ZILLIONS and $0 seen 31 Oct - 1 Nov 2026).
const VOLATILE_CONFIG_BYTES = [[137, 168], [342, 349]];
const volatile = ([x, y]) => VOLATILE_CONFIG_BYTES.some(([a, b]) => x >= a && y <= b);

function diffConfig(before, after) {
  const changes = [];
  for (const label of new Set([...Object.keys(before.present), ...Object.keys(after.present)])) {
    if (!(label in after.present)) changes.push(`${label} wallet no longer in config`);
    else if (!(label in before.present)) changes.push(`${label} wallet now in config`);
  }
  const a = Buffer.from(before.dataHex, "hex"), b = Buffer.from(after.dataHex, "hex");
  const ranges = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue;
    const last = ranges.at(-1);
    if (last && last[1] === i - 1) last[1] = i; else ranges.push([i, i]);
  }
  const real = ranges.filter((r) => !volatile(r));
  if (real.length) changes.push(`bytes changed at ${real.map(([x, y]) => x === y ? x : `${x}-${y}`).join(", ")}` +
    ` (${real.map(([x, y]) => `${a.subarray(x, y + 1).toString("hex")} -> ${b.subarray(x, y + 1).toString("hex")}`).join(", ")})`);
  return changes;
}

async function main() {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  const alerts = [];
  const program = await checkProgram();
  const config = await checkConfig();
  const vault = await recentInstructions(VAULT_PROGRAM, VAULT_PROGRAM, VAULT_IX, state?.vaultNewest);
  const squads = multisig ? await recentInstructions(multisig, SQUADS_V4, SQUADS_IX, state?.squadsNewest) : null;
  const ms = multisig ? await checkMultisig(multisig) : null;
  if (ms?.error) alerts.push(ms.error);
  else if (ms && state?.multisig && !state.multisig.error) {
    const before = state.multisig;
    if (ms.threshold !== before.threshold) alerts.push(`multisig threshold ${before.threshold} -> ${ms.threshold}`);
    if (ms.timeLockSeconds !== before.timeLockSeconds) alerts.push(`multisig time lock ${before.timeLockSeconds}s -> ${ms.timeLockSeconds}s`);
    if (ms.configAuthority !== before.configAuthority) alerts.push(`multisig config authority ${before.configAuthority} -> ${ms.configAuthority}`);
    const was = new Set(before.members.map((m) => m.key)), now = new Set(ms.members.map((m) => m.key));
    for (const k of now) if (!was.has(k)) alerts.push(`multisig member added: ${k}`);
    for (const k of was) if (!now.has(k)) alerts.push(`multisig member removed: ${k}`);
  }

  if (program.error) alerts.push(program.error);
  else {
    if (program.upgradeAuthority !== EXPECTED_UPGRADE_AUTHORITY)
      alerts.push(`upgrade authority is ${program.upgradeAuthority ?? "none (frozen)"}, not the published multisig`);
    if (state && program.lastDeploySlot !== state.program.lastDeploySlot)
      alerts.push(`vault program upgraded: last deploy slot ${state.program.lastDeploySlot} -> ${program.lastDeploySlot}`);
  }
  if (config.error) alerts.push(config.error);
  else if (config.owner !== VAULT_PROGRAM) alerts.push(`config account owner is ${config.owner}, not the vault program`);
  else if (state && config.sha256 !== state.config.sha256) {
    const changes = diffConfig(state.config, config);
    if (changes.length) alerts.push(`vault config changed: ${changes.join("; ")}`); // only the timestamp moved: nothing to report
  }

  for (const ix of vault.instructions.filter((x) => x.kind === "privileged"))
    alerts.push(`privileged vault instruction ${ix.name}${ix.caller === SQUADS_V4 ? " via multisig" : ""} at ${ix.time} (${ix.signature})`);
  for (const ix of (squads?.instructions ?? []).filter((x) => SQUADS_ALERT.has(x.name)))
    alerts.push(`multisig ${ix.name} at ${ix.time} (${ix.signature})`);

  const counts = (list) => list.reduce((m, x) => ((m[x.name] = (m[x.name] ?? 0) + 1), m), {});
  const report = {
    checkedAt: new Date().toISOString(),
    baseline: !state,
    program,
    config: config.error ? config : { size: config.size, sha256: config.sha256, walletsPresent: Object.keys(config.present) },
    vaultInstructions: counts(vault.instructions),
    unrecognised: vault.instructions.filter((x) => x.kind === "unrecognised").map((x) => ({ name: x.name, signature: x.signature })),
    multisig: ms ? (ms.error ? ms : { address: multisig, threshold: ms.threshold, members: ms.memberCount,
      timeLockSeconds: ms.timeLockSeconds, transactionIndex: ms.transactionIndex }) : "not watched",
    multisigInstructions: squads ? counts(squads.instructions) : "not watched",
    alerts,
  };

  writeFileSync(statePath, JSON.stringify({ program, config, multisig: ms, vaultNewest: vault.newest,
    squadsNewest: squads?.newest ?? state?.squadsNewest ?? null }, null, 2));

  if (alerts.length && webhook) {
    await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `zWatchtower keys check:\n- ${alerts.join("\n- ")}` }) });
  }
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
  process.exitCode = alerts.length ? 1 : 0;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
