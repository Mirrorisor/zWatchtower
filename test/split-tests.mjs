// The "90% back" claim: Sapling's breakdown, its own share, and the lines we measure.
import { findLegs, judgeSplit, splitFindings, flatten, parseStatsPage } from "../lib/split.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
const zat = (zec) => String(Math.round(zec * 1e8));

// sapling.cash/stats on 2026-11-06 (amounts in ZEC); field names are a guess at Sapling's style
const stats = {
  volumeZec: zat(35532.57), coins: 503, holders: 10313, rewardsPaidZec: zat(175.34), donatedZec: zat(7.9),
  revenue: { totalZec: zat(508.66), last7dZec: zat(60) },
  split: { liquidityZec: zat(103.96), saplingBuybackZec: zat(111.63), flywheelZec: zat(15.55), holdersZec: zat(175.34),
    payeesZec: zat(46.89), donatedZec: zat(7.9), saplingZec: zat(52.59), waitingZec: zat(0.62) },
  buyback7dZec: zat(16.94),
};
check("flatten keeps numbers by path and drops arrays", flatten({ a: { b: "5" }, c: [1, 2], d: true, e: "x" })["a.b"] === 5 && Object.keys(flatten({ c: [1], d: true })).length === 0);

let f = findLegs(stats);
// holders and donated each match a top-level field (rewardsPaidZec, donatedZec): the shortest path wins
check("finds every line", ["liquidity", "saplingBuyback", "flywheel", "holders", "payees", "donated", "sapling", "waiting"].every((l) => f.legs[l] != null), JSON.stringify(f.from));
check("time windows are never the all-time figure", !Object.values(f.from).some((p) => /7d/.test(p)), JSON.stringify(f.from));
check("a flywheel field isn't Sapling's buyback", f.from.flywheel === "split.flywheelZec" && f.from.saplingBuyback === "split.saplingBuybackZec");
check("amounts are read as zat", Math.abs(f.legs.sapling - 52.59) < 1e-9);
check("overrides win", findLegs(stats, { holders: "split.holdersZec" }).from.holders === "split.holdersZec");
check("two equally good fields: left out, not guessed", findLegs({ a: { lpZec: "1" }, b: { liquidityZec: "2" } }).ambiguous.liquidity?.length === 2);

let j = judgeSplit(f.legs, { holders: 175.333, donated: 7.896, flywheel: 15.55125887, payees: 13.72 });
check("Sapling's share by its own numbers: 52.59 of 513.86 settled = 10.23%", j.saplingSharePct === 10.23 && j.backPct === 89.77, `${j.saplingSharePct} / ${j.backPct}`);
check("the claim holds", j.claim === "holds");
check("every measured line matches", j.checks.length === 4 && j.checks.every((c) => c.matches), JSON.stringify(j.checks));
check("payees is only a lower bound", j.checks.find((c) => c.leg === "payees").lowerBound === true);
let s = splitFindings(j);
check("nothing to say when it holds", !s.alerts.length && !s.notes.length);

// Sapling keeps more than it says
j = judgeSplit({ ...f.legs, sapling: 80 }, {});
check("a 14% share does not hold", j.claim === "does not hold" && splitFindings(j).notes.some((n) => /14\.\d+% of settled fees, not 10%/.test(n)), JSON.stringify(splitFindings(j)));
check("10.7% is close", judgeSplit({ ...f.legs, sapling: 55 }).claim === "close");
// a line that doesn't match what we measure
j = judgeSplit(f.legs, { holders: 150 });
s = splitFindings(j);
check("holders paid differs: alert", s.alerts.some((a) => /stats say 175\.34 ZEC was paid to holders; we count 150 ZEC/.test(a)), JSON.stringify(s.alerts));
check("first run: a difference is a note, not an alert", splitFindings(j, { baseline: true }).alerts.length === 0);
s = splitFindings(judgeSplit(f.legs, { payees: 60 }));
check("payees more than Sapling's whole line: alert", s.alerts.some((a) => /coin records alone show 60 ZEC/.test(a)));
check("payees under Sapling's line: fine (deployers can be paid directly)", judgeSplit(f.legs, { payees: 1 }).checks[0].matches);
check("a missing line: not checked", judgeSplit({ ...f.legs, liquidity: undefined }).claim === "not checked");

// Sapling's real /api/stats fields (2026-11-08): only some lines are there
const real = { totalVaultZec: "100", saplingBurned: "225980000", coinsLaunched: 510, volume24hZec: "900", volumeTotalZec: "3600000000000",
  rewardsPaidZec: zat(181.58), donatedZec: zat(7.896), lpZecTotal: zat(300), lpLockedZec: zat(105.55),
  usdAtTime: { volumeTotal: 46e6, rewardsPaid: 2e5, lpTotal: 1e5, boughtBack: 1.5e5 }, zecUsd: 1300, solUsd: 160, saplingBoughtBackZec: zat(113.2) };
f = findLegs(real);
check("real fields: holders, donations, liquidity, $SAPLING buyback", f.from.holders === "rewardsPaidZec" && f.from.donated === "donatedZec" && f.from.liquidity === "lpLockedZec" && f.from.saplingBuyback === "saplingBoughtBackZec", JSON.stringify(f.from));
check("real fields: a 24h volume and USD totals are never a line", !Object.values(f.from).some((p) => /24h|usd/i.test(p)));

// the stats page's table (server-rendered)
const html = `<html><script>var x="Paid to holders 1%"</script><h2>Protocol revenue</h2><p>Paid to holders (dashboard) $1</p>
<h2>Where the fees went</h2><table>
<tr><td>Added to $SAPLING/ZEC liquidity</td><td>$134.1K</td><td>20.2%</td><td>105.55 ZEC</td></tr>
<tr><td>Spent buying back $SAPLING</td><td>$136.0K</td><td>20.5%</td><td>113.20 ZEC</td></tr>
<tr><td>Bought back and burned by coins&#x27; flywheels</td><td>$21.2K</td><td>3.2%</td><td>16.70 ZEC</td></tr>
<tr><td>Paid to holders</td><td>$230.9K</td><td>34.8%</td><td>181.58 ZEC</td></tr>
<tr><td>Paid to deployers and payees</td><td>$61.0K</td><td>9.2%</td><td>48.01 ZEC</td></tr>
<tr><td>Received by the Zcash Foundation</td><td>$10.0K</td><td>1.5%</td><td>7.90 ZEC</td></tr>
<tr><td>Kept by Sapling</td><td>$69.0K</td><td>10.4%</td><td>54.32 ZEC</td></tr>
<tr><td>Still waiting in the pots</td><td>$0.3K</td><td>0.1%</td><td>0.40 ZEC</td></tr></table>
<h2>Volume</h2><p>Paid to holders (dashboard): $230.9K (181.58 ZEC)</p></html>`;
const pg = parseStatsPage(html);
check("page: every line, with its share and ZEC", pg.found.length === 8 && pg.pct.sapling === 10.4 && pg.zec.sapling === 54.32 && pg.zec.flywheel === 16.7 && pg.zec.holders === 181.58, JSON.stringify(pg));
check("page: only the breakdown section is read (not scripts or the revenue box)", pg.pct.holders === 34.8);
j = judgeSplit(pg.zec, { holders: 181.5718, donated: 7.8962, flywheel: 16.7 });
check("page amounts: Sapling keeps 10.3%, the claim holds", j.saplingSharePct === 10.3 && j.claim === "holds" && j.checks.every((c) => c.matches), `${j.saplingSharePct} ${JSON.stringify(j.checks)}`);
j = judgeSplit({}, {}, { shares: pg.pct });
check("page shares alone give the same answer", j.fromShares && j.saplingSharePct === 10.42 && j.claim === "holds", String(j.saplingSharePct));
check("no breakdown section: nothing found", parseStatsPage("<p>hello</p>").found.length === 0);

console.log(failures ? `\n${failures} failed` : "\nall split tests passed");
process.exitCode = failures ? 1 : 0;
