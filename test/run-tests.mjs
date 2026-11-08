// Offline test: stubs fetch with real runs captured from sapling.cash on
// 2026-10-28, plus tampered copies that each check must catch.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const load = (id) => JSON.parse(readFileSync(join(here, "fixtures", `${id}.json`), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));

const runs = new Map();
for (const id of [1028, 1032, 1044]) runs.set(id, load(id));

// 2001: a share inflated by 1 zatoshi
const badShare = clone(runs.get(1044)); badShare.run.id = 2001;
badShare.payouts[1].share = String(BigInt(badShare.payouts[1].share) + 1n);
runs.set(2001, badShare);
// 2002: a holder's balance edited after hashing
const badHash = clone(runs.get(1028)); badHash.run.id = 2002;
badHash.snapshot.holders[0][1] = "10328511014250";
runs.set(2002, badHash);
// 2003: a holder below the $20 minimum (price cut 100x)
const badMin = clone(runs.get(1028)); badMin.run.id = 2003;
badMin.eligibility.zecUsd = "13.07";
runs.set(2003, badMin);
// 2004: paid more than the pot
const badPot = clone(runs.get(1032)); badPot.run.id = 2004;
badPot.run.paid = "2002234";
runs.set(2004, badPot);
// 2005: failed run whose release signature is not on chain (like run 845)
runs.set(2005, { run: { id: 2005, symbol: "ZDOG", status: "failed", pot: null, paid: "0",
  releaseSignature: "MISSING", snapshotHash: "00" }, snapshot: null, payouts: [] });
// 2006: a run still being paid: its ZEC is already released on chain (like runs 1696, 1705, 1707)
runs.set(2006, { run: { id: 2006, symbol: "MOOH", status: "paying", pot: "4000", paid: "0",
  releaseSignature: "REL2006", snapshotHash: "00" }, snapshot: null, payouts: [] });

const REWARDS = "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL";
const ZEC = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const fakeTx = (run, amount) => ({
  meta: {
    err: null,
    preTokenBalances: [{ accountIndex: 2, owner: REWARDS, mint: ZEC, uiTokenAmount: { amount: "5" } }],
    postTokenBalances: [{ accountIndex: 2, owner: REWARDS, mint: ZEC,
      uiTokenAmount: { amount: String(5n + BigInt(amount)) } }],
    logMessages: ["Program data: " + Buffer.concat([Buffer.alloc(8),
      Buffer.from(run.snapshotHash, "hex")]).toString("base64")],
  },
});

globalThis.fetch = async (url, init) => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (String(url).startsWith("https://sapling.cash/api/rewards/")) {
    const id = Number(String(url).split("/").pop());
    return runs.has(id) ? ok(runs.get(id)) : { ok: false, status: 404 };
  }
  if (url === "https://rpc.test") {
    const sig = JSON.parse(init.body).params[0];
    const run = [...runs.values()].find((r) => r.run.releaseSignature === sig)?.run;
    if (!run || sig === "MISSING") return ok({ result: null });
    return ok({ result: fakeTx(run, run.id === 1028 ? 1n : run.pot) }); // 1028: wrong amount
  }
  throw new Error("unexpected fetch " + url);
};

const logs = [];
console.log = (...a) => logs.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" "));
process.stderr.write = () => true;

process.argv = [process.argv[0], "rewards-check.mjs", "--from", "1028", "--to", "2006",
  "--rpc", "https://rpc.test", "--json"];
await import("../rewards-check.mjs");
await new Promise((r) => setTimeout(r, 200));

const report = JSON.parse(logs.join("\n"));
const byId = Object.fromEntries(report.results.filter((r) => !r.notFound).map((r) => [r.id, r]));
const expect = {
  1028: /release: amount-mismatch/,
  1032: null,
  1044: null,
  2001: /shares not floor/,
  2002: /snapshot hash mismatch/,
  2003: /below the \$20 minimum/,
  2004: /pot != paid/,
  2005: /signature-not-on-chain|status "failed"/,
};
let failures = 0;
for (const [id, pattern] of Object.entries(expect)) {
  const r = byId[id];
  const text = [r.note, r.release, ...(r.problems || [])].filter(Boolean).join("; ");
  const pass = pattern ? pattern.test(text) : r.problems.length === 0 && !r.note;
  if (!pass) failures++;
  process.stdout.write(`${pass ? "PASS" : "FAIL"} run ${id}: ${text || "clean"}\n`);
}
{
  const r = byId[2006];
  const pass = r.inProgress === true && r.problems.length === 0 && report.summary.inProgressIds?.includes(2006) && !report.summary.checkedIds.includes(2006)
    && !report.flagged.some((f) => f.id === 2006);
  if (!pass) failures++;
  process.stdout.write(`${pass ? "PASS" : "FAIL"} run 2006: a run still being paid isn't a problem; it's checked again later (${JSON.stringify(r)})\n`);
}
process.stdout.write(`summary: ${JSON.stringify(report.summary)}\n`);
process.exitCode = failures ? 1 : 0;
