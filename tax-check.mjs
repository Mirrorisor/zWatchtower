#!/usr/bin/env node
// zWatchtower: tax check (prototype)
//
// Since 2026-10-29, Sapling also launches Raydium LaunchLab coins. These are
// Token-2022 tokens whose trading tax is a transfer fee built into the token:
// it is charged on every transfer, withheld in the token, and collected by
// Sapling's vault program (WithdrawTax, SellTax) to pay holders and the
// flywheel. For each such coin this checks, on chain:
//
//   - the fee in force equals the rate Sapling advertises (taxBps)
//   - no fee change is scheduled (Token-2022 applies a new fee two epochs
//     after it is set, so a raise is visible about four days ahead)
//   - the fee can only be withdrawn by Sapling's program-controlled address,
//     and only that address (or nobody) can change it
//   - nobody can mint more or freeze accounts, and the token has no extension
//     that lets someone take, block or pause it
//
// Usage:
//   node tax-check.mjs --rpc https://api.mainnet-beta.solana.com
//   node tax-check.mjs --rpc URL --state tax-state.json --json
//
// Read-only. Exit code 1 when there is an alert.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Program-derived addresses (no private key) seen on every LaunchLab coin on
// 2026-10-29; the vault program signs for them in WithdrawTax.
const EXPECTED_WITHDRAW_AUTHORITY = "69nv6e1SZfdo9J6j45uuke4PBdLi6RYAiJpecG6HGLEY";
const EXPECTED_CONFIG_AUTHORITY = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh";
const SAFE_EXTENSIONS = new Set(["transferFeeConfig", "metadataPointer", "tokenMetadata"]);
// Extensions that let someone take, block, freeze or pause holders' tokens
const DANGEROUS = new Set(["permanentDelegate", "transferHook", "pausableConfig", "defaultAccountState",
  "nonTransferable", "mintCloseAuthority", "confidentialTransferMint"]);

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const rpcUrl = opt("--rpc", "https://api.mainnet-beta.solana.com");
const statePath = opt("--state", "tax-state.json");
const apiBase = opt("--api", "https://sapling.cash");
const asJson = args.includes("--json");

async function getJson(url, init) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(url, init);
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }
  throw new Error(`${url}: rate-limited`);
}
const rpc = async (method, params) => {
  const j = await getJson(rpcUrl, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
};

// Every LaunchLab coin Sapling lists, plus any seen on earlier runs (a coin
// that drops off the newest list is still checked).
async function listCoins(known) {
  const list = await getJson(`${apiBase}/api/coins?tab=new&limit=500`);
  const coins = new Map(Object.entries(known));
  for (const c of Array.isArray(list) ? list : [])
    if (c.venue === "launchlab") coins.set(c.mint, { symbol: c.symbol, taxBps: c.taxBps, stage: c.stage ?? null });
  return coins;
}

function checkMint(mint, coin, value, epoch) {
  const problems = [], notes = [];
  if (!value) return { problems: ["mint account not found"], notes };
  if (value.owner !== TOKEN_2022) problems.push(`not a Token-2022 mint (owner ${value.owner})`);
  const info = value.data?.parsed?.info ?? {};
  const exts = info.extensions ?? [];
  const tf = exts.find((e) => e.extension === "transferFeeConfig")?.state;
  if (info.mintAuthority) problems.push(`mint authority is set (${info.mintAuthority}): more can be minted`);
  if (info.freezeAuthority) problems.push(`freeze authority is set (${info.freezeAuthority})`);
  for (const e of exts) {
    if (DANGEROUS.has(e.extension)) problems.push(`has the ${e.extension} extension`);
    else if (!SAFE_EXTENSIONS.has(e.extension)) notes.push(`unrecognised extension ${e.extension}`);
  }
  if (!tf) { problems.push("no transfer fee configured"); return { problems, notes }; }
  const older = tf.olderTransferFee.transferFeeBasisPoints, newer = tf.newerTransferFee.transferFeeBasisPoints;
  const inForce = Number(tf.newerTransferFee.epoch) <= epoch ? newer : older;
  if (inForce !== coin.taxBps) problems.push(`fee in force ${inForce / 100}% but Sapling shows ${coin.taxBps / 100}%`);
  if (newer !== inForce || Number(tf.newerTransferFee.epoch) > epoch)
    problems.push(`fee change scheduled: ${older / 100}% -> ${newer / 100}% from epoch ${tf.newerTransferFee.epoch} (now ${epoch})`);
  if (tf.withdrawWithheldAuthority !== EXPECTED_WITHDRAW_AUTHORITY)
    problems.push(`fee withdraw authority is ${tf.withdrawWithheldAuthority ?? "none"}, not Sapling's program address`);
  const cfg = tf.transferFeeConfigAuthority;
  if (cfg && cfg !== EXPECTED_CONFIG_AUTHORITY) problems.push(`fee can be changed by ${cfg}, not Sapling's program address`);
  return { problems, notes, inForceBps: inForce, canChangeFee: Boolean(cfg),
    withheld: tf.withheldAmount != null ? String(tf.withheldAmount) : null };
}

async function main() {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { coins: {} };
  const coins = await listCoins(state.coins ?? {});
  const epoch = (await rpc("getEpochInfo", [])).epoch;
  const mints = [...coins.keys()];
  const results = [];
  for (let i = 0; i < mints.length; i += 100) {
    const batch = mints.slice(i, i + 100);
    const r = await rpc("getMultipleAccounts", [batch, { encoding: "jsonParsed" }]);
    batch.forEach((m, j) => results.push({ mint: m, symbol: coins.get(m).symbol, advertisedBps: coins.get(m).taxBps,
      stage: coins.get(m).stage, ...checkMint(m, coins.get(m), r.value[j], epoch) }));
  }
  const alerts = results.flatMap((r) => r.problems.map((p) => `tax ${r.symbol} (${r.mint}): ${p}`));
  const report = {
    checkedAt: new Date().toISOString(), epoch, coins: results.length,
    matching: results.filter((r) => r.problems.length === 0).length,
    feeChangeable: results.filter((r) => r.canChangeFee).length,
    feeRenounced: results.filter((r) => r.canChangeFee === false).length,
    advertisedRange: results.length ? [Math.min(...results.map((r) => r.advertisedBps)), Math.max(...results.map((r) => r.advertisedBps))] : null,
    alerts, notes: results.flatMap((r) => r.notes.map((n) => `${r.symbol}: ${n}`)), results,
  };
  writeFileSync(statePath, JSON.stringify({ coins: Object.fromEntries(coins) }, null, 2));
  console.log(asJson ? JSON.stringify(report, null, 2) : report);
  process.exitCode = alerts.length ? 1 : 0;
}

main().catch((e) => { console.error(e.message); process.exitCode = 2; });
