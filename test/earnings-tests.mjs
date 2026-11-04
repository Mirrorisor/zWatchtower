// The rewards explorer's per-coin numbers.
import { runFacts, aggregate } from "../lib/earnings.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };

const now = Date.parse("2026-11-04T12:00:00Z");
// a basket run: holders listed at half their formula share (half paid in ZEC)
const api = (id, mint, at, paid, half = true) => ({
  run: { id, mint, symbol: "ZDOG", status: "done", startedAt: at, pot: "2000000", paid: String(paid), paidCount: 2 },
  snapshot: { holders: [["A", "3000000000"], ["B", "1000000000"]] },   // 4,000 tokens
  eligibility: { zecPerToken: "0.0005", zecUsd: "1200" },             // holdings worth 2 ZEC
  payouts: [{ owner: "A", share: half ? "750000" : "1500000" }, { owner: "B", share: half ? "250000" : "500000" }],
});
const f = runFacts(api(1, "M", "2026-11-03T00:00:00Z", 2000000));
check("a run paid half in ZEC says so", f.zecFraction === 0.5, JSON.stringify(f));
check("eligible holdings valued at the run's price", Math.abs(f.eligibleZec - 2) < 1e-9, String(f.eligibleZec));
check("an all-ZEC run", runFacts(api(2, "N", "2026-11-03T00:00:00Z", 2000000, false)).zecFraction === 1);

const runs = { 1: f, 2: runFacts(api(2, "M", "2026-10-20T00:00:00Z", 1000000)), 3: runFacts(api(3, "N", "2026-11-04T00:00:00Z", 4000000, false)),
  4: { mint: "M", status: "failed", at: "2026-11-04T00:00:00Z", paid: "0" } };
const out = aggregate(runs, { baskets: { M: { tokens: ["ZEC", "$SAPLING", "CYPH", "hSOL"] } }, now });
const m = out.find((c) => c.mint === "M"), n = out.find((c) => c.mint === "N");
check("totals every done run, the week only recent ones; failed runs skipped", m.runs === 2 && m.paidZec === 0.03 && m.paid7dZec === 0.02 && m.runs7d === 1, JSON.stringify(m));
check("tokens from the rewards check's basket", m.tokens.join() === "ZEC,$SAPLING,CYPH,hSOL");
check("an all-ZEC coin pays ZEC", n.tokens.join() === "ZEC");
check("$1,000 held earned: week's payout over eligible holdings", m.per1kWeekUsd === 10, String(m.per1kWeekUsd));   // 0.02 ZEC / 2 ZEC * 1000
check("week's payout in dollars at the run's ZEC price", m.paid7dUsd === 24);
check("biggest weekly payer first", out[0].mint === "N");
process.exitCode = failures ? 1 : 0;
