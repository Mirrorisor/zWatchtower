// Stand-in for a check script in service tests: prints the report the test
// scenario holds for this check, and records the arguments it was given.
import { readFileSync, appendFileSync } from "node:fs";
const [name, ...rest] = process.argv.slice(2);
const scen = JSON.parse(readFileSync(process.env.SCENARIO, "utf8"));
appendFileSync(process.env.ARGS_LOG, JSON.stringify({ name, args: rest }) + "\n");
if (scen[name] === "crash") { console.error("simulated RPC outage"); process.exit(2); }
const defaults = { tax: { alerts: [], notes: [], coins: 16, matching: 16, feeChangeable: 15, feeRenounced: 1, advertisedRange: [200, 500], epoch: 1071, results: [] },
  flywheel: { alerts: [], notes: [], burns: 20, burnsVerified: 20, boughtBackZat: "76974978",
    venues: { "pump amm": 14, "raydium cpmm": 5, "raydium launchlab": 1 }, perCoin: {},
    pot: { balanceZat: "2258", shownZat: "2258", inflowZat: "76977236", buybackZat: "76974978", movements: {}, reconciled: true },
    signers: [] },
  coins: { coins: 2, carded: 2, refreshed: 2, flagged: 1, flagCounts: {}, notes: [], alerts: [] },
  programs: { saplingPrograms: [], otherPrograms: [], programsSeen: 0, txsRead: 0, notes: [], alerts: [] } };
console.log(JSON.stringify(scen[name] ?? defaults[name]));
