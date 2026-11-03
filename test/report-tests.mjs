// The weekly report: built from the service's own logs.
import { buildReport, composeWeekly } from "../lib/report.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

const to = Date.parse("2026-11-09T00:00:00Z");
const at = (d) => `2026-11-0${d}T12:00:00.000Z`;
const alerts = [
  { check: "keys", type: "raised", at: at(3), text: "vault program upgraded: last deploy slot 1 -> 2" },
  { check: "programs", type: "raised", at: at(4), text: "program GzMQ upgraded: last deploy slot 5 -> 6" },
  { check: "keys", type: "raised", at: at(4), text: "privileged vault instruction set_gas via multisig at x (sig)" },
  { check: "rewards", type: "raised", at: at(5), text: "reward run 1486 ZDOG: 79 shares not floor(pot*balance/sum)" },
  { check: "rewards", type: "raised", at: at(5), text: "reward run 9 : error: HTTP error for https://rpc" },        // our own lookup failure
  { check: "flywheel", type: "raised", at: at(6), text: "flywheel burn X: unexpected program" },
  { check: "flywheel", type: "resolved", at: at(7), text: "flywheel burn X: unexpected program" },
  { check: "keys", type: "raised", at: "2026-10-20T00:00:00.000Z", text: "vault program upgraded: last deploy slot 0 -> 1" }, // before the week
];
const history = [{ check: "keys", status: "ran", finishedAt: at(3) }, { check: "coins", status: "ran", finishedAt: at(4) },
  { check: "keys", status: "error", finishedAt: at(4) }];
const latest = {
  float: { ok: true, summary: { currentFloatZec: 0, privacy: { forwards: 14, shielded: 14 } } },
  flywheel: { ok: true, summary: { burns: 152, burnsVerified: 152, pot: { reconciled: true } } },
  tax: { ok: true, summary: { coins: 94, matching: 94 } },
  rewards: { ok: false, summary: { runs: 6, passed: 5, zecPaidInDoneRuns: "1.0" } },
  programs: { ok: true, summary: { saplingPrograms: [{}, {}], terminal: { tokensChecked: 2, breakingRules: [] } } },
};
const coins = { cards: [{ flagCount: 1 }, { flagCount: 0 }], launchesKnown: 120, serialCreators: [{ soldOut: 4 }, { soldOut: 1 }],
  events: [{ at: at(5), text: "New coin $crime (GVxB…) was launched by a creator who sold out of 4 of their 4 other Sapling coins checked." },
    { at: at(6), text: "$ZDOG ($30.5k): the creator has now sold everything they bought." }] };
const openAlerts = { rewards: { "reward run 1486 ZDOG: 79 shares not floor(pot*balance/sum)": at(5) } };
const r = buildReport({ latest, alerts, history, coins, openAlerts, to });

check("only the week's runs that ran are counted", r.checksRun === 2);
check("upgrades of every Sapling program this week, not before", r.code.upgrades.length === 2, JSON.stringify(r.code.upgrades));
check("admin actions counted", r.code.adminActions === 1);
check("a failed lookup is not a problem with Sapling", !r.problems.some((p) => /HTTP error/.test(p.text)), JSON.stringify(r.problems));
check("open and resolved problems told apart", r.problems.filter((p) => p.open).length === 1 && r.problems.length === 2);
check("coin warnings and changes split", r.coins.warnings.length === 1 && r.coins.changes.length === 1 && r.coins.serialCreators === 1);
const post = composeWeekly(r);
check("weekly post fits and reads right", [...post].length <= 280 &&
  post === "zWatchtower weekly on Sapling: 2 checks run. 2 code upgrades, all by the same multisig. 14 of 14 payouts shielded. 152 of 152 buybacks verified. 1 of 2 coins over $10k flagged; 1 new-coin warning. 1 open problem under review.", post);
const changed = buildReport({ latest, history, coins, openAlerts, to,
  alerts: [...alerts, { check: "programs", type: "raised", at: at(6), text: "program GzMQ upgrade authority is X (was Y)" }] });
check("a change of control is called out, and the multisig line dropped", changed.code.controlChanges.length === 1 &&
  /change\(s\) of control/.test(composeWeekly(changed)) && !/same multisig/.test(composeWeekly(changed)), composeWeekly(changed));

process.exitCode = failures ? 1 : 0;
