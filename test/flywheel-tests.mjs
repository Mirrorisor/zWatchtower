// Flywheel check tests: three real buybacks (Raydium CPMM, pump AMM, Raydium
// LaunchLab) captured 2026-10-29, tampered copies that must be caught, and an
// end-to-end run of flywheel-check.mjs against a fake RPC and Sapling API.
import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rf } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { checkBurn, classifyPotTx, GROVE_ACCOUNT, GROVE_OWNER, ZEC_MINT, VAULT } from "../lib/flywheel.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = JSON.parse(readFileSync(join(here, "fixtures/flywheel-burns-2026-10-29.json"), "utf8"));
const clone = (o) => JSON.parse(JSON.stringify(o));
const [cpmm, pump, launchlab] = fx.claims;
const txOf = (c) => clone(fx.txs[c.signature]);

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};
const has = (r, re) => r.problems.some((p) => re.test(p));

// real buybacks
for (const [c, venue] of [[cpmm, "raydium cpmm"], [pump, "pump amm"], [launchlab, "raydium launchlab"]]) {
  const r = checkBurn(txOf(c), c);
  check(`real ${venue} buyback passes`, r.problems.length === 0 && r.venue === venue, r.problems.join("; ") || r.venue);
}

// tampered claims or transactions
let r = checkBurn(txOf(cpmm), { ...cpmm, zat: "300000" });
check("overstated ZEC spent is caught", has(r, /pot paid 247421 zat, Sapling lists 300000/), r.problems.join("; "));

r = checkBurn(txOf(pump), { ...pump, burned: "1900000000000" });
check("overstated burn is caught", has(r, /burned 1827837354053, Sapling lists/), r.problems.join("; "));

r = checkBurn(txOf(cpmm), { ...cpmm, mint: "3sKZuSZF7onqPYFrWu3bH4Lh141duydt9MAmSd46jaLJ" });
check("burn of a different coin is caught", has(r, /no burn of 3sKZ/), r.problems.join("; "));

let t = txOf(cpmm);
t.meta.postTokenBalances.find((b) => b.accountIndex === 4).uiTokenAmount.amount = "1000000";
r = checkBurn(t, cpmm);
check("buyback wallet keeping coins is caught", has(r, /kept 1000000 of the coin/), r.problems.join("; "));

t = txOf(cpmm);
t.meta.postTokenBalances.find((b) => b.accountIndex === 17).uiTokenAmount.amount = "2499";
r = checkBurn(t, cpmm);
check("buyback wallet keeping ZEC is caught", has(r, /kept 2499 zat/), r.problems.join("; "));

t = txOf(launchlab);
t.transaction.message.instructions.splice(4, 0, { programId: "Evi1Program1111111111111111111111111111111" });
r = checkBurn(t, launchlab);
check("unexpected program is caught", has(r, /unexpected program in buyback: Evi1/), r.problems.join("; "));

t = txOf(pump);
t.meta.err = { InstructionError: [3, { Custom: 6001 }] };
r = checkBurn(t, pump);
check("failed transaction is caught", has(r, /failed on chain/), r.problems.join("; "));

r = checkBurn(null, pump);
check("missing transaction is caught", has(r, /not found on chain/));

t = txOf(cpmm);
t.meta.logMessages = t.meta.logMessages.map((l) => l.replace("Instruction: CloseGrove", "Instruction: SweepGrove"));
r = checkBurn(t, cpmm);
check("buyback not closed by CloseGrove is caught", has(r, /expected DrawGrove … CloseGrove/), r.problems.join("; "));

// pot classification
let c = classifyPotTx(txOf(pump));
check("buyback moves the pot by the listed amount", c.kind === "buyback" && c.delta === "-62273983", `${c.kind} ${c.delta}`);

// synthetic pot transactions built from the real one's account layout
function potTx({ names, delta, signers = ["7yJnPdEDFS7KZbKvPsK8QgHqC61hoE2H5W8EpmNAuMCC"], sig = "SyntheticPotTx1111" }) {
  return {
    blockTime: 1793300000,
    meta: { err: null,
      logMessages: names.flatMap((n) => [`Program ${VAULT} invoke [1]`, `Program log: Instruction: ${n}`, `Program ${VAULT} success`]),
      preTokenBalances: [{ accountIndex: 1, mint: ZEC_MINT, owner: GROVE_OWNER, uiTokenAmount: { amount: "1000000" } }],
      postTokenBalances: [{ accountIndex: 1, mint: ZEC_MINT, owner: GROVE_OWNER, uiTokenAmount: { amount: String(1000000 + delta) } }] },
    transaction: { signatures: [sig], message: {
      accountKeys: [...signers.map((p) => ({ pubkey: p, signer: true })), { pubkey: GROVE_ACCOUNT, signer: false }],
      instructions: [{ programId: VAULT }] } },
  };
}
// potTx puts the grove account after the signers; fix the index for multi-signer cases
const fixIdx = (tx) => { const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === GROVE_ACCOUNT);
  for (const b of [...tx.meta.preTokenBalances, ...tx.meta.postTokenBalances]) b.accountIndex = i; return tx; };

c = classifyPotTx(fixIdx(potTx({ names: ["SettleTax"], delta: 5000 })));
check("tax settlement is an inflow", c.kind === "inflow" && c.delta === "5000" && c.problems.length === 0, JSON.stringify(c));
c = classifyPotTx(fixIdx(potTx({ names: ["SettleTax"], delta: -5000 })));
check("a SettleTax that takes money out is caught", c.problems.some((p) => /SettleTax took 5000/.test(p)));
c = classifyPotTx(fixIdx(potTx({ names: ["WithdrawGrove"], delta: -900000 })));
check("any other way out of the pot is caught", c.kind === "other" && c.problems.some((p) => /pot changed by -900000/.test(p)), c.problems.join("; "));

// end to end: flywheel-check.mjs against a fake RPC and API
const dir = mkdtempSync(join(tmpdir(), "fw-test-"));
const statePath = join(dir, "state.json");
const world = {
  burns: fx.claims.map((x) => ({ ...x, symbol: "T", at: "2026-10-29T00:00:00Z" })),
  potTxs: {}, // signature -> tx, newest last
  balance: 0n,
};
const inflow1 = fixIdx(potTx({ names: ["SettleTax"], delta: 70000000, sig: "Inflow1" }));
world.potTxs.Inflow1 = inflow1;
for (const cl of [launchlab, pump, cpmm]) world.potTxs[cl.signature] = txOf(cl);
world.balance = 70000000n - 3555461n - 62273983n - 247421n;

const server = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const send = (x) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(x)); };
    if (req.url.startsWith("/api/flywheel/live")) {
      const zat = world.burns.reduce((a, b) => a + BigInt(b.zat), 0n);
      return send({ hero: { zat: String(zat), burns: world.burns.length }, burns: world.burns, pot: { zat: String(world.balance) } });
    }
    const { method, params } = JSON.parse(body);
    if (method === "getTransaction") {
      if (world.blank?.has(params[0])) return send({ result: null });
      return send({ result: world.potTxs[params[0]] ?? fx.txs[params[0]] ?? null });
    }
    if (method === "getTokenAccountBalance") return send({ result: { value: { amount: String(world.balance) } } });
    if (method === "getSignaturesForAddress") {
      const all = Object.keys(world.potTxs).reverse(); // newest first
      const until = params[1].until; const cut = until ? all.indexOf(until) : -1;
      return send({ result: (cut >= 0 ? all.slice(0, cut) : all).map((signature) => ({ signature, err: null })) });
    }
    send({ error: { message: `unexpected ${method}` } });
  });
});
await new Promise((ok) => server.listen(0, ok));
const base = `http://127.0.0.1:${server.address().port}`;
const run = (extra = [], state = statePath) => new Promise((done) => {
  const p = spawn(process.execPath, [join(here, "../flywheel-check.mjs"), "--json", "--rpc", base, "--api", base,
    "--state", state, "--pause", "0", ...extra]);
  let out = "", err = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => { let report = null; try { report = JSON.parse(out); } catch {} done({ code, report, err }); });
});

try {
  let x = await run();
  check("end to end: clean run exits 0 and verifies all burns",
    x.code === 0 && x.report.burnsVerified === 3 && x.report.pot.reconciled === true, x.err || JSON.stringify(x.report?.alerts));
  check("end to end: totals add up", x.report?.pot.inflowZat === "70000000" &&
    x.report?.pot.buybackZat === String(3555461 + 62273983 + 247421) && x.report?.boughtBackZat === String(3555461 + 62273983 + 247421));

  // someone withdraws from the pot outside the buyback flow
  world.potTxs.Drain = fixIdx(potTx({ names: ["WithdrawGrove"], delta: -1000, sig: "Drain",
    signers: ["5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV"] }));
  world.balance -= 1000n;
  x = await run();
  check("end to end: unexpected withdrawal raises an alert", x.code === 1 &&
    x.report.alerts.some((a) => /pot Drain: pot changed by -1000/.test(a)), JSON.stringify(x.report?.alerts));

  // a new key signs a buyback
  const newKey = clone(txOf(cpmm));
  newKey.transaction.signatures[0] = "NewKeyBuyback";
  newKey.transaction.message.accountKeys[1].pubkey = "NewHotKey11111111111111111111111111111111111";
  world.potTxs.NewKeyBuyback = newKey;
  world.balance -= 247421n;
  x = await run();
  check("end to end: a new signing key raises an alert",
    x.report.alerts.some((a) => /new signing key NewHotKey/.test(a)), JSON.stringify(x.report?.alerts));
  check("end to end: an unlisted buyback is noted", x.report.notes.some((n) => /NewKeyBuyback drew 247421 zat but is not in Sapling's burn list/.test(n)),
    JSON.stringify(x.report?.notes));

  // the balance stops matching what was seen
  world.balance -= 5n;
  x = await run();
  check("end to end: pot balance mismatch raises an alert",
    x.report.alerts.some((a) => /pot holds .* but the movements seen add up to/.test(a)), JSON.stringify(x.report?.alerts));
  // a public RPC returning nothing is never Sapling's problem: the work waits
  const st2 = join(dir, "state2.json");
  world.blank = new Set(["Inflow1", cpmm.signature]);
  x = await run([], st2);
  check("end to end: blank RPC answers raise no alert and don't crash", x.code === 0 && x.report.alerts.length === 0 &&
    x.report.notes.some((n) => /paused at Inflow1/.test(n)) && x.report.pot.caughtUp === false, x.err || JSON.stringify(x.report?.notes));
  world.blank = new Set([cpmm.signature]);
  x = await run([], st2);
  check("end to end: a listed burn missing twice is still not an alert", !x.report.alerts.some((a) => /not found/.test(a)), JSON.stringify(x.report?.alerts));
  x = await run([], st2);
  check("end to end: missing on a third run, it is", x.report.alerts.some((a) => new RegExp(cpmm.signature + ": transaction not found").test(a)), JSON.stringify(x.report?.alerts));
  world.blank = new Set();

  // a small budget reads the pot history over several runs, then reconciles
  const st3 = join(dir, "state3.json");
  let runs = 0;
  do { x = await run(["--max-tx", "2"], st3); runs++; } while (!x.report?.pot.caughtUp && runs < 10);
  check("end to end: a capped run resumes until caught up", runs > 1 && x.report.pot.caughtUp && x.report.burnsVerified === 3, `${runs} runs`);
} finally {
  server.close();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
