// Offline test for keys-check.mjs. Simulates the Solana accounts and
// transactions it reads, then walks through runs where nothing changes and
// runs where each watched thing changes. Account layouts follow the
// upgradeable BPF loader and Anchor conventions; the config bytes are made up.
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { decode, encode } from "../lib/base58.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "keys-test-"));
const chainFile = join(dir, "chain.json"), statePath = join(dir, "state.json");

const VAULT = "A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF";
const CONFIG = "8z2Rv1dKQgA5pqT8kiNmkAmAUDRVHwXhuxrhEoa6QyRy";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const SQUADS = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";
const MULTISIG_VAULT = "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf";
const MULTISIG = "11111111111111111111111111111112";
const TREASURY = "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr";
const REWARDS = "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL";
const ATTACKER = "So11111111111111111111111111111111111111112";
const PROGRAM_DATA = encode(createHash("sha256").update("programdata").digest());

const disc = (n) => createHash("sha256").update("global:" + n).digest().subarray(0, 8);
const ixData = (n) => encode(Buffer.concat([disc(n), Buffer.alloc(8)]));

function programAccount() {
  const b = Buffer.alloc(36); b.writeUInt32LE(2, 0); decode(PROGRAM_DATA).copy(b, 4); return b;
}
function programData(slot, authority) {
  const b = Buffer.alloc(45); b.writeUInt32LE(3, 0); b.writeBigUInt64LE(BigInt(slot), 4);
  if (authority) { b[12] = 1; decode(authority).copy(b, 13); } return b;
}
function configAccount(rewards, liquidityBps) {
  const b = Buffer.alloc(8 + 32 + 32 + 2);
  Buffer.from("cfgdisc1").copy(b, 0); decode(TREASURY).copy(b, 8); decode(rewards).copy(b, 40);
  b.writeUInt16LE(liquidityBps, 72); return b;
}

// Squads v4 Multisig account in the layout keys-check decodes
function multisigAccount(threshold, members, timeLock = 0) {
  const parts = [createHash("sha256").update("account:Multisig").digest().subarray(0, 8),
    Buffer.alloc(32), Buffer.alloc(32)];
  const fixed = Buffer.alloc(2 + 4 + 8 + 8); fixed.writeUInt16LE(threshold, 0); fixed.writeUInt32LE(timeLock, 2);
  fixed.writeBigUInt64LE(50n, 6); fixed.writeBigUInt64LE(25n, 14);
  const rent = Buffer.concat([Buffer.from([1]), decode(MULTISIG_VAULT)]);
  const len = Buffer.alloc(4); len.writeUInt32LE(members.length);
  const mem = members.map((m) => Buffer.concat([decode(m), Buffer.from([7])]));
  return Buffer.concat([...parts, fixed, rent, Buffer.from([255]), len, ...mem, Buffer.alloc(64)]);
}
const MEMBERS = ["5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV", "7Ahf3YH8CfMWgUw17gdtB2j6GvSRDY26HwyFhHbC8LnG",
  "EaAJA8G9P2zNGCwPRuDq1JZUbBQPq1wsFcEb8XTqTnep", "Ecwtj8nsJtAegxb1e2AycXT7atgCLUNo4oDwi6cvCvoL"];

let sigN = 0;
const tx = (programId, name) => ({ signature: `sig${++sigN}`, slot: 1000 + sigN, blockTime: 1793000000 + sigN,
  programId, data: ixData(name) });

// chain state the stub serves
const chain = {
  slot: 400000000, authority: MULTISIG_VAULT, owner: VAULT,
  config: configAccount(REWARDS, 2500).toString("base64"),
  vaultTxs: [tx(VAULT, "settle"), tx(VAULT, "draw_lp"), tx(VAULT, "roots_to_pot")],
  squadsTxs: [],
  threshold: 2, members: MEMBERS, timeLock: 0,
};

const preload = `
  import { readFileSync } from "node:fs";
  globalThis.fetch = async (url, init) => {
    const c = JSON.parse(readFileSync(process.env.CHAIN_FILE, "utf8"));
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });
    const acct = (b64, owner) => ok({ value: { owner, data: [b64, "base64"] } });
    if (method === "getAccountInfo") {
      if (params[0] === "${VAULT}") return acct(c.programB64, "${LOADER}");
      if (params[0] === "${PROGRAM_DATA}") return acct(c.programDataB64, "${LOADER}");
      if (params[0] === "${CONFIG}") return acct(c.config, c.owner);
      if (params[0] === "${MULTISIG}") return acct(c.multisigB64, "${SQUADS}");
      return ok({ value: null });
    }
    const list = params[0] === "${VAULT}" ? c.vaultTxs : c.squadsTxs;
    if (method === "getSignaturesForAddress") {
      const until = params[1].until; const out = [];
      for (const t of [...list].reverse()) { if (t.signature === until) break; out.push(t); }
      return ok(out.map((t) => ({ signature: t.signature, slot: t.slot, blockTime: t.blockTime, err: null })));
    }
    if (method === "getTransaction") {
      const t = [...c.vaultTxs, ...c.squadsTxs].find((x) => x.signature === params[0]);
      return ok({ meta: { innerInstructions: [], logMessages: t.logs }, transaction: { message: {
        accountKeys: [{ pubkey: "Keeper1111111111111111111111111111111111111", signer: true }],
        instructions: [{ programId: t.programId, data: t.data, accounts: [] }] } } });
    }
    throw new Error("unexpected " + method);
  };`;

function run() {
  writeFileSync(chainFile, JSON.stringify({ ...chain,
    programB64: programAccount().toString("base64"),
    programDataB64: programData(chain.slot, chain.authority).toString("base64"),
    multisigB64: multisigAccount(chain.threshold, chain.members, chain.timeLock).toString("base64") }));
  const r = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
    join(here, "../keys-check.mjs"), "--rpc", "http://stub", "--state", statePath,
    "--squads-multisig", MULTISIG, "--json"], { encoding: "utf8", env: { ...process.env, CHAIN_FILE: chainFile } });
  if (r.status === 2 || !r.stdout) throw new Error(r.stderr);
  return { code: r.status, ...JSON.parse(r.stdout) };
}

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

let r = run();
check("baseline run is clean", r.baseline && r.alerts.length === 0 && r.code === 0, r.alerts.join("; "));
check("routine keeper work is recognised", r.vaultInstructions.settle === 1 && r.vaultInstructions.draw_lp === 1);
check("reads the upgrade authority", r.program.upgradeAuthority === MULTISIG_VAULT);
check("finds treasury and rewards wallets in config",
  r.config.walletsPresent.includes("treasury") && r.config.walletsPresent.includes("rewards"));

check("decodes the multisig: 2 of 4, no time lock",
  r.multisig.threshold === 2 && r.multisig.members === 4 && r.multisig.timeLockSeconds === 0, JSON.stringify(r.multisig));

r = run();
check("unchanged chain gives no alerts", r.alerts.length === 0 && !r.baseline);

chain.members = [...MEMBERS, ATTACKER]; chain.threshold = 1;
r = run();
check("multisig member added and threshold lowered are alerted",
  r.alerts.some((a) => a === `multisig member added: ${ATTACKER}`) && r.alerts.some((a) => a === "multisig threshold 2 -> 1"),
  r.alerts.join("; "));
chain.members = MEMBERS; chain.threshold = 2;
r = run();

chain.vaultTxs.push(tx(VAULT, "settle"), tx(VAULT, "claim_something_new"));
r = run();
check("only new transactions are read", r.vaultInstructions.settle === 1 && !r.vaultInstructions.draw_lp);
check("unrecognised instruction is listed but not alerted",
  r.unrecognised.length === 1 && r.alerts.length === 0);

chain.config = configAccount(ATTACKER, 2500).toString("base64");
r = run();
check("rewards wallet swap in config is alerted", r.alerts.some((a) => /rewards wallet no longer in config/.test(a)), r.alerts[0]);

chain.config = configAccount(ATTACKER, 2000).toString("base64");
r = run();
check("fee split change is alerted with the changed bytes", r.alerts.some((a) => /bytes changed at 72/.test(a)), r.alerts[0]);

chain.vaultTxs.push(tx(VAULT, "set_lp"));
r = run();
check("privileged instruction is alerted", r.alerts.some((a) => /privileged vault instruction set_lp/.test(a)), r.alerts[0]);

// an admin action the docs don't name, run through the multisig (seen live: SetStockQuote)
chain.vaultTxs.push({ ...tx(SQUADS, "batch_execute_transaction"), logs: [
  `Program ${SQUADS} invoke [1]`, "Program log: Instruction: BatchExecuteTransaction",
  `Program ${VAULT} invoke [2]`, "Program log: Instruction: SetStockQuote", `Program ${VAULT} success`,
  `Program ${SQUADS} success`] });
// keeper work named only in the logs
chain.vaultTxs.push({ ...tx(VAULT, "settle"), logs: [
  `Program ${VAULT} invoke [1]`, "Program log: Instruction: ObserveSapling", `Program ${VAULT} success`] });
r = run();
check("undocumented instruction via multisig is alerted by name",
  r.alerts.some((a) => /privileged vault instruction set_stock_quote via multisig/.test(a)), r.alerts.join("; "));
check("keeper's observe_sapling is routine", r.vaultInstructions.observe_sapling === 1 && r.alerts.length === 1);

chain.squadsTxs.push(tx(SQUADS, "proposal_create"), tx(SQUADS, "proposal_approve"));
r = run();
check("multisig proposal and approval are alerted", r.alerts.filter((a) => /^multisig proposal_/.test(a)).length === 2);

chain.slot = 400100000;
r = run();
check("program upgrade is alerted", r.alerts.some((a) => /vault program upgraded/.test(a)), r.alerts[0]);

chain.authority = ATTACKER;
r = run();
check("upgrade authority change is alerted", r.alerts.some((a) => /upgrade authority is So111/.test(a)) && r.code === 1);

chain.authority = null;
r = run();
check("frozen program is reported", r.alerts.some((a) => /none \(frozen\)/.test(a)));

chain.authority = MULTISIG_VAULT; chain.owner = ATTACKER;
r = run();
check("config owned by another program is alerted", r.alerts.some((a) => /config account owner/.test(a)));

rmSync(dir, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
