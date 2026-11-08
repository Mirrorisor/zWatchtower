// Sapling's "90% back" claim. sapling.llc says "Ninety percent of every fee
// goes back to the people who use Sapling, paid in ZEC. Always." and
// sapling.cash/stats breaks the fees down by destination, with "Sapling's 10%"
// as one line. This takes that breakdown and:
//   1. works out Sapling's own share and what goes back, from Sapling's numbers
//   2. checks each destination we can measure ourselves against Sapling's figure
//      (holder rewards, Zcash Foundation donations and coin flywheel buybacks
//      from our own checks; payees as a lower bound, since deployers can be paid
//      outside the coin records)
// Pure; split-check.mjs does the fetching.

// What each line of the breakdown is called in Sapling's stats, matched on the
// last part of the field name (ZEC amounts in Sapling's API are in zat).
export const LEGS = {
  liquidity: /liquid|^lp/,
  saplingBuyback: /buyback|boughtback|rootstock|saplingburn|burnsapling/,
  flywheel: /flywheel|grove/,
  holders: /holder|rewardspaid/,
  payees: /payee|deployer/,
  donated: /donat|foundation/,
  sapling: /treasury|operator|kept|saplingshare|saplingcut|protocolshare|^saplings?(zec|zat)$/,
  waiting: /waiting|pending|unsettled/,
  revenue: /revenue/,
};
// lines that "go back to the people who use Sapling"
export const BACK = ["liquidity", "saplingBuyback", "flywheel", "holders", "payees", "donated"];
const PERIOD = /7d|week|day|month|today|24h|last|recent|usd/;

/** Every number in an object, by path ("a.b.c"); arrays are skipped. */
export function flatten(o, pre = "", out = {}) {
  if (o && typeof o === "object" && !Array.isArray(o))
    for (const [k, v] of Object.entries(o)) {
      const p = pre ? `${pre}.${k}` : k;
      if (v && typeof v === "object") flatten(v, p, out);
      else if (v != null && v !== "" && Number.isFinite(Number(v)) && typeof v !== "boolean") out[p] = Number(v);
    }
  return out;
}

/**
 * Find the breakdown's lines in Sapling's stats. A field counts when its name
 * ends in Zec/Zat, isn't a time window, and matches exactly one line; when
 * several fields match a line, the shortest path wins, and a tie leaves it
 * unmapped (we'd rather say "not found" than guess). `fields` overrides.
 * @returns { legs: { leg: zec }, from: { leg: path }, unmapped: [leg], ambiguous: { leg: [paths] } }
 */
export function findLegs(stats, fields = {}) {
  const flat = flatten(stats);
  const legs = {}, from = {}, ambiguous = {};
  for (const leg of Object.keys(LEGS)) {
    if (fields[leg] && flat[fields[leg]] != null) { legs[leg] = flat[fields[leg]] / 1e8; from[leg] = fields[leg]; continue; }
    const hits = Object.keys(flat).filter((p) => {
      const last = p.split(".").at(-1).toLowerCase();
      if (!/(zec|zat)$/.test(last) || PERIOD.test(p.toLowerCase())) return false;
      const name = last.replace(/(zec|zat)$/, "");
      const matching = Object.entries(LEGS).filter(([, re]) => re.test(name) || re.test(last)).map(([l]) => l);
      // "saplingBuyback" also matches /buyback/ alone; a flywheel field is the flywheel's
      return matching.includes(leg) && !(leg === "saplingBuyback" && matching.includes("flywheel"));
    });
    if (!hits.length) continue;
    const depth = (p) => p.split(".").length;
    const best = Math.min(...hits.map(depth)), top = hits.filter((p) => depth(p) === best);
    if (top.length > 1) { ambiguous[leg] = top; continue; }
    legs[leg] = flat[top[0]] / 1e8; from[leg] = top[0];
  }
  return { legs, from, ambiguous, unmapped: Object.keys(LEGS).filter((l) => legs[l] == null) };
}

// The breakdown as sapling.cash/stats shows it ("Where the fees went"): the
// page is rendered on Sapling's server and its API doesn't carry every line.
export const PAGE_LABELS = {
  liquidity: /Added to \$SAPLING\/ZEC liquidity/i,
  saplingBuyback: /Spent buying back \$SAPLING/i,
  flywheel: /Bought back and burned by coins['’]? flywheels/i,
  holders: /Paid to holders/i,
  payees: /Paid to deployers and payees/i,
  donated: /Received by the Zcash Foundation/i,
  sapling: /Kept by Sapling|Sapling['’]s (?:share|10%|cut)/i,
  waiting: /Still waiting in the pots/i,
};
const decode = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;|&#160;/g, " ").replace(/&#x27;|&#39;|&rsquo;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

// the page tags each number: data-stat="went.<line>.<zec|pct|usd>" (seen 2026-11-08)
const STAT_LEG = { liquidity: "liquidity", buyback: "saplingBuyback", flywheel: "flywheel", holders: "holders", payees: "payees", zf: "donated", sapling: "sapling", waiting: "waiting" };

/**
 * Each line's ZEC and share from the stats page: from the page's data-stat
 * tags when it has them, otherwise from the text after each line's label.
 * A line whose numbers can't be read is left out.
 * @returns { zec: { leg: n }, pct: { leg: n }, found: [leg], revenueZec, via }
 */
export function parseStatsPage(html) {
  const out = { zec: {}, pct: {}, found: [], revenueZec: null, via: null };
  const num = (t) => { const m = /(\d[\d,]*(?:\.\d+)?)/.exec(t); return m ? Number(m[1].replace(/,/g, "")) : null; };
  for (const m of html.matchAll(/data-stat="(went\.([a-z]+)\.(zec|pct)|revenue\.zec)"[^>]*>([^<]*)</gi)) {
    if (m[1] === "revenue.zec") { out.revenueZec = num(m[4]); continue; }
    const leg = STAT_LEG[m[2]];
    const v = num(m[4]);
    if (!leg || v == null) continue;
    out[m[3]][leg] = v;
    if (!out.found.includes(leg)) out.found.push(leg);
  }
  if (out.found.length) { out.via = "data-stat"; return out; }
  // no tags: read the text after each label
  // from the breakdown's heading when there is one (the page repeats some labels elsewhere)
  const text = decode(html), at = text.search(/Where (?:the fees|it) went/i);
  const sec = at >= 0 ? text.slice(at, at + 6000) : text;
  const starts = Object.entries(PAGE_LABELS).map(([leg, re]) => { const m = re.exec(sec); return m ? { leg, i: m.index, end: m.index + m[0].length } : null; }).filter(Boolean);
  for (const s of starts) {
    const next = Math.min(...starts.filter((o) => o.i > s.i).map((o) => o.i), s.end + 200);
    const seg = sec.slice(s.end, next);
    const pct = /(\d+(?:\.\d+)?)\s*%/.exec(seg), zec = /(\d[\d,]*(?:\.\d+)?)\s*(?:ZEC|\u24e9)/i.exec(seg);
    if (pct) out.pct[s.leg] = Number(pct[1]);
    if (zec) out.zec[s.leg] = Number(zec[1].replace(/,/g, ""));
    if (pct || zec) out.found.push(s.leg);
  }
  if (out.found.length) out.via = "labels";
  return out;
}

/**
 * @param legs   Sapling's breakdown, ZEC: { liquidity, saplingBuyback, flywheel, holders, payees, donated, sapling, waiting, revenue }
 * @param ours   what we measured, ZEC: { holders, donated, flywheel, payees } (any may be missing)
 */
export function judgeSplit(legs, ours = {}, { shares = null } = {}) {
  const r = { legs, ours, checks: [], saplingSharePct: null, backPct: null, claim: "not checked" };
  // the claim, by Sapling's own numbers
  const known = [...BACK, "sapling"].filter((l) => legs[l] != null);
  if (legs.sapling != null && known.length === BACK.length + 1) {
    const settled = known.reduce((a, l) => a + legs[l], 0);   // what has reached a destination
    if (settled > 0) {
      r.settledZec = round(settled, 4);
      r.saplingSharePct = round((legs.sapling / settled) * 100, 2);
      r.backPct = round(100 - r.saplingSharePct, 2);
      // "ninety percent": holds when Sapling's share rounds to 10% or less
      r.claim = r.saplingSharePct < 10.5 ? "holds" : r.saplingSharePct < 11 ? "close" : "does not hold";
    }
  }
  // without every amount, the page's own percentages say the same thing
  if (r.saplingSharePct == null && shares && shares.sapling != null && BACK.every((l) => shares[l] != null)) {
    const total = [...BACK, "sapling"].reduce((a, l) => a + shares[l], 0);
    r.saplingSharePct = round((shares.sapling / total) * 100, 2);
    r.backPct = round(100 - r.saplingSharePct, 2);
    r.fromShares = true;
    r.claim = r.saplingSharePct < 10.5 ? "holds" : r.saplingSharePct < 11 ? "close" : "does not hold";
  }
  // each line we can measure ourselves
  const near = (a, b) => Math.abs(a - b) <= Math.max(0.01, b * 0.02);
  for (const [leg, label] of [["holders", "paid to holders"], ["donated", "received by the Zcash Foundation"], ["flywheel", "bought back and burned by coins' flywheels"]]) {
    if (legs[leg] == null || ours[leg] == null) continue;
    r.checks.push({ leg, label, sapling: round(legs[leg], 4), ours: round(ours[leg], 4), matches: near(ours[leg], legs[leg]) });
  }
  // payees: the coin records only show what went to a coin's payee; deployers paid directly add to Sapling's line
  if (legs.payees != null && ours.payees != null)
    r.checks.push({ leg: "payees", label: "paid to deployers and payees", sapling: round(legs.payees, 4), ours: round(ours.payees, 4),
      lowerBound: true, matches: ours.payees <= legs.payees * 1.02 + 0.01 });
  return r;
}
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;

/** Alerts and notes from a judgement. */
export function splitFindings(j, { baseline = false } = {}) {
  const alerts = [], notes = [];
  for (const c of j.checks)
    if (!c.matches) {
      const msg = c.lowerBound
        ? `Sapling's stats say ${c.sapling} ZEC was ${c.label}, but the coin records alone show ${c.ours} ZEC paid to payees, more than that total`
        : `Sapling's stats say ${c.sapling} ZEC was ${c.label}; we count ${c.ours} ZEC`;
      (baseline ? notes : alerts).push(msg);
    }
  if (j.claim === "does not hold")
    notes.push(`By Sapling's own breakdown its share is ${j.saplingSharePct}% of settled fees, not 10%`);
  return { alerts, notes };
}
