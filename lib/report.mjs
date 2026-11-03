// The weekly report: what zWatchtower checked about Sapling in a period, and
// what it found. Built from the service's own logs, so every line traces back
// to a check result or an alert anyone can read in the raw data.

const within = (iso, from, to) => { const t = Date.parse(iso); return t >= from && t < to; };

/**
 * @param latest   store.state.latest (each check's last result)
 * @param alerts   alerts.jsonl rows, any order
 * @param history  history.jsonl rows, any order
 * @param coins    coins.json (or null)
 * @param to       end of the period (ms); the period is the 7 days before it
 */
export function buildReport({ latest = {}, alerts = [], history = [], coins = null, openAlerts = {}, to = Date.now(), days = 7 }) {
  const from = to - days * 86400000;
  const inPeriod = (a) => within(a.at, from, to);
  const raised = alerts.filter((a) => a.type === "raised" && inPeriod(a));
  const resolved = alerts.filter((a) => a.type === "resolved" && inPeriod(a));
  const withdrawn = alerts.filter((a) => a.type === "withdrawn" && inPeriod(a));
  const runs = history.filter((h) => h.status === "ran" && within(h.finishedAt, from, to));
  const runsBy = (n) => runs.filter((h) => h.check === n).length;

  const upgrades = raised.filter((a) => /^(vault )?program .*upgraded|^vault program upgraded/.test(a.text))
    .map((a) => ({ at: a.at, check: a.check, text: a.text }));
  const adminActions = raised.filter((a) => a.check === "keys" && /^privileged vault instruction/.test(a.text)).length;
  const controlChanges = raised.filter((a) => /upgrade authority is|config account owner is|new program controlled by Sapling/.test(a.text))
    .map((a) => ({ at: a.at, text: a.text }));
  // a withdrawn alert was zWatchtower's own mistake (a lookup that failed), not a problem with Sapling
  const withdrawnTexts = new Set(alerts.filter((a) => a.type === "withdrawn").map((a) => a.text));
  const openNow = (check, text) => Boolean(openAlerts[check] && text in openAlerts[check]);
  // as are failed lookups ("error: HTTP error…", rate limits), however they were closed
  const ownFailure = (t) => withdrawnTexts.has(t) || /\berror: |HTTP error|HTTP \d{3}|rate-limited|not (read|checked)/i.test(t);
  const problems = raised.filter((a) => ["rewards", "tax", "flywheel", "float"].includes(a.check) && !ownFailure(a.text))
    .map((a) => ({ at: a.at, check: a.check, text: a.text, open: openNow(a.check, a.text) }));

  const L = (n) => latest[n]?.summary ?? {};
  const fl = L("float").privacy ?? null;
  const term = L("programs").terminal ?? null;
  const events = (coins?.events ?? []).filter((e) => within(e.at, from, to));
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    checksRun: runs.length,
    runsByCheck: Object.fromEntries(["keys", "rewards", "float", "tax", "flywheel", "coins", "programs"].map((n) => [n, runsBy(n)])),
    code: { upgrades, controlChanges, adminActions, saplingPrograms: (L("programs").saplingPrograms ?? []).length },
    rewards: { runsChecked: L("rewards").runs ?? null, passed: L("rewards").passed ?? null, zecPaid: L("rewards").zecPaidInDoneRuns ?? null },
    payouts: { forwards: fl?.forwards ?? null, shielded: fl?.shielded ?? null, deliveredZec: L("float").deliveredZec ?? null, floatZec: L("float").currentFloatZec ?? null },
    buybacks: { burns: L("flywheel").burns ?? null, verified: L("flywheel").burnsVerified ?? null, potReconciled: L("flywheel").pot?.reconciled ?? null },
    taxes: { coins: L("tax").coins ?? null, matching: L("tax").matching ?? null },
    terminal: term ? { tokensChecked: term.tokensChecked, breakingRules: term.breakingRules?.length ?? 0 } : null,
    coins: coins ? {
      carded: coins.cards?.length ?? 0, flagged: (coins.cards ?? []).filter((c) => c.flagCount).length,
      launchesRead: coins.launchesKnown ?? null,
      warnings: events.filter((e) => /^New coin/.test(e.text)).map((e) => e.text),
      changes: events.filter((e) => !/^New coin/.test(e.text)).map((e) => e.text),
      serialCreators: (coins.serialCreators ?? []).filter((x) => x.soldOut >= 2).length,
    } : null,
    problems,
    openAlerts: Object.entries(latest).filter(([, v]) => v?.ok === false).map(([k]) => k),
    withdrawn: withdrawn.length,
  };
}

/** One post, under 280 characters, from a report. */
export function composeWeekly(r) {
  const parts = [`zWatchtower weekly on Sapling: ${r.checksRun} checks run.`];
  const up = r.code.upgrades.length;
  parts.push(up ? `${up} code upgrade${up === 1 ? "" : "s"}${r.code.controlChanges.length ? "" : ", all by the same multisig"}.` : "No code upgrades.");
  if (r.code.controlChanges.length) parts.push(`${r.code.controlChanges.length} change(s) of control: see the report.`);
  if (r.payouts.forwards) parts.push(`${r.payouts.shielded} of ${r.payouts.forwards} payouts shielded.`);
  if (r.buybacks.burns) parts.push(`${r.buybacks.verified} of ${r.buybacks.burns} buybacks verified.`);
  if (r.coins) parts.push(`${r.coins.flagged} of ${r.coins.carded} coins over $10k flagged; ${r.coins.warnings.length} new-coin warning${r.coins.warnings.length === 1 ? "" : "s"}.`);
  const open = r.problems.filter((p) => p.open).length;
  parts.push(open ? `${open} open problem${open === 1 ? "" : "s"} under review.` : "No open problems.");
  let text = parts.join(" ");
  while ([...text].length > 280 && parts.length > 2) { parts.splice(parts.length - 2, 1); text = parts.join(" "); }
  return text;
}
