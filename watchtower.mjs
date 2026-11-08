#!/usr/bin/env node
// zWatchtower service
//
// Runs the checks on their own schedules, keeps their latest result and
// history on disk, posts each new alert once to a webhook, and serves a JSON
// API plus the public dashboard (public/index.html).
//
//   node watchtower.mjs                         # uses watchtower.config.json if present
//   node watchtower.mjs --config my.json
//   node watchtower.mjs --once                  # run every check once, then exit
//   node watchtower.mjs --once --due            # only the checks whose interval has passed
//   node watchtower.mjs --export site           # write the dashboard + API as static files
//
// WATCHTOWER_WEBHOOK in the environment overrides the config's webhook.
//
// Endpoints:
//   GET /                      dashboard
//   GET /api/status            latest result of every check
//   GET /api/history?check=X   past results (newest first, ?limit=N)
//   GET /api/alerts            alerts raised, newest first
//   GET /healthz               200 while the scheduler is alive
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composePosts, composeSummary, fit, postToX } from "./lib/xpost.mjs";
import { badgeSvg } from "./lib/badge.mjs";
import { buildReport, composeWeekly } from "./lib/report.mjs";
import { redact } from "./lib/redact.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const DEFAULTS = {
  port: 8787,
  dataDir: "./data",
  solanaRpc: "https://api.mainnet-beta.solana.com",
  webhook: null,
  threexplKey: null,
  squadsMultisig: null,
  zebra: null,
  checks: {
    keys: { everyMinutes: 5 },
    rewards: { everyMinutes: 30, recheckLast: 5, onChain: true },
    float: { everyMinutes: 60, stuckMinutes: 60 },
    tax: { everyMinutes: 15 },
    flywheel: { everyMinutes: 15 },
    coins: { everyMinutes: 30, maxCoins: 40 },
    programs: { everyMinutes: 30 },
    earnings: { everyMinutes: 60 },
    zec: { everyMinutes: 15 },
    payees: { everyMinutes: 60 },
    liquidity: { everyMinutes: 15 },
    split: { everyMinutes: 60 },   // last: it reads what payees and flywheel just wrote
  },
  timeoutMinutes: 30,
  // Override the command for a check (tests use this): { keys: ["node", "fake.mjs"] }
  commands: {},
};

function loadConfig() {
  const path = opt("--config", existsSync("watchtower.config.json") ? "watchtower.config.json" : null);
  const user = path ? JSON.parse(readFileSync(path, "utf8")) : {};
  const cfg = { ...DEFAULTS, ...user, checks: { ...DEFAULTS.checks } };
  for (const k of Object.keys(DEFAULTS.checks)) cfg.checks[k] = { ...DEFAULTS.checks[k], ...(user.checks?.[k] ?? {}) };
  if (opt("--port")) cfg.port = Number(opt("--port"));
  cfg.dataDir = resolve(cfg.dataDir);
  if (process.env.WATCHTOWER_WEBHOOK) cfg.webhook = process.env.WATCHTOWER_WEBHOOK.trim();
  if (cfg.webhook && !/^https?:\/\//.test(cfg.webhook)) { console.error("webhook ignored: it isn't an http(s) URL"); cfg.webhook = null; }
  if (process.env.WATCHTOWER_SOLANA_RPC) cfg.solanaRpc = process.env.WATCHTOWER_SOLANA_RPC.trim();
  // Posting to X: with all four keys set it posts; without them it only
  // records what it would have posted (x-posts.jsonl, status "preview").
  const env = process.env;
  cfg.x = {
    creds: env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_SECRET
      ? { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET }
      : null,
    link: env.X_INCLUDE_LINKS === "1" ? (cfg.publicUrl ?? "zwatchtower.lovable.app") : null, // links cost more per post
    perRun: Number(env.X_MAX_PER_RUN ?? 3),
    perDay: Number(env.X_MAX_PER_DAY ?? 10),
    dailySummary: env.X_DAILY_SUMMARY === "1",
    postUrl: env.X_POST_URL, // tests point this at a local server
    ...(user.x ?? {}),
  };
  return cfg;
}

// ---- persistence ----------------------------------------------------------

// Alerts that were really the watchtower's own lookups failing (an earlier
// version raised these). They are withdrawn, not reported as resolved.
const OWN_FAILURE = /HTTP error for |rate-limited|fetch failed|ETIMEDOUT|ECONNRESET/;
function withdrawOwnFailures(store) {
  for (const [check, open] of Object.entries(store.state.openAlerts ?? {})) {
    const bad = Object.keys(open).filter((a) => OWN_FAILURE.test(a));
    for (const a of bad) delete open[a];
    if (bad.length) store.append("alerts.jsonl", { check, at: new Date().toISOString(), type: "withdrawn",
      text: `${bad.length} alert(s) withdrawn: they were the watchtower's own failed lookups, not findings` });
  }
}

class Store {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.statePath = join(dir, "state.json");
    // scrub any secret an older version wrote (an RPC key inside an error message)
    for (const f of readdirSync(dir).filter((f) => /\.jsonl?$/.test(f))) {
      const raw = readFileSync(join(dir, f), "utf8"), clean = redact(raw);
      if (clean !== raw) writeFileSync(join(dir, f), clean);
    }
    this.state = existsSync(this.statePath)
      ? JSON.parse(readFileSync(this.statePath, "utf8"))
      : { latest: {}, openAlerts: {}, rewardsMaxRun: 0 };
  }
  save() { writeFileSync(this.statePath, redact(JSON.stringify(this.state, null, 2))); }
  append(file, obj) { appendFileSync(join(this.dir, file), redact(JSON.stringify(obj)) + "\n"); }
  read(file, filter, limit) {
    const p = join(this.dir, file);
    if (!existsSync(p)) return [];
    const rows = readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return rows.filter(filter).reverse().slice(0, limit);
  }
}

// ---- running a check --------------------------------------------------------

function commandFor(name, cfg, store) {
  if (cfg.commands[name]) {
    if (name !== "rewards") return cfg.commands[name];
    const from = Math.max(1, (store.state.rewardsMaxRun || 0) - cfg.checks.rewards.recheckLast);
    store.state.rewardsFrom = from;
    return [...cfg.commands[name], "--from", String(from), ...rewardsRecheck(store, from)];
  }
  const node = process.execPath;
  if (name === "keys") return [node, join(here, "keys-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "keys-state.json"),
    ...(cfg.squadsMultisig ? ["--squads-multisig", cfg.squadsMultisig] : [])];
  if (name === "rewards") {
    const from = Math.max(1, (store.state.rewardsMaxRun || 0) - cfg.checks.rewards.recheckLast);
    store.state.rewardsFrom = from;
    return [node, join(here, "rewards-check.mjs"), "--json", "--from", String(from), ...rewardsRecheck(store, from),
      ...(cfg.checks.rewards.onChain ? ["--rpc", cfg.solanaRpc] : [])];
  }
  if (name === "tax") return [node, join(here, "tax-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "tax-state.json")];
  if (name === "flywheel") return [node, join(here, "flywheel-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "flywheel-state.json")];
  if (name === "coins") return [node, join(here, "coins-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "coins-state.json"), "--out", join(cfg.dataDir, "coins.json"),
    "--max-coins", String(cfg.checks.coins.maxCoins)];
  if (name === "programs") return [node, join(here, "programs-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "programs-state.json")];
  if (name === "payees") return [node, join(here, "payees-check.mjs"), "--json",
    "--state", join(cfg.dataDir, "payees-state.json"), "--out", join(cfg.dataDir, "payees.json")];
  if (name === "liquidity") return [node, join(here, "liquidity-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "liquidity-state.json")];
  if (name === "split") return [node, join(here, "split-check.mjs"), "--json",
    "--payees", join(cfg.dataDir, "payees-state.json"), "--watchtower", join(cfg.dataDir, "state.json"),
    "--out", join(cfg.dataDir, "split.json"), ...(cfg.checks.split.fields ? ["--fields", JSON.stringify(cfg.checks.split.fields)] : [])];
  if (name === "zec") return [node, join(here, "zec-check.mjs"), "--json", "--rpc", cfg.solanaRpc,
    "--state", join(cfg.dataDir, "zec-state.json"), "--out", join(cfg.dataDir, "zec.json")];
  if (name === "earnings") return [node, join(here, "rewards-explorer.mjs"), "--json",
    "--state", join(cfg.dataDir, "rewards-index.json"), "--out", join(cfg.dataDir, "rewards.json"),
    "--coins", join(cfg.dataDir, "coins.json"), "--creators", join(cfg.dataDir, "creators.json"),
    "--baskets", join(cfg.dataDir, "state.json")];
  if (name === "float") return [node, join(here, "float-check.mjs"), "--json",
    "--stuck-minutes", String(cfg.checks.float.stuckMinutes),
    ...(cfg.zebra ? ["--source", "zebra", "--zebra", cfg.zebra] : []),
    ...(cfg.threexplKey ? ["--api-key", cfg.threexplKey] : [])];
  throw new Error("unknown check " + name);
}

function runCommand(cmd, timeoutMs) {
  return new Promise((done) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code, signal) => { clearTimeout(timer); done({ code, signal, out, err }); });
  });
}

// Turn each check's own report into one shape: { ok, alerts, summary }
function normalise(name, report) {
  if (name === "keys") return {
    ok: report.alerts.length === 0,
    alerts: report.alerts,
    summary: {
      upgradeAuthority: report.program?.upgradeAuthority ?? null,
      lastDeploySlot: report.program?.lastDeploySlot ?? null,
      configSha256: report.config?.sha256 ?? null,
      walletsInConfig: report.config?.walletsPresent ?? [],
      vaultInstructions: report.vaultInstructions,
      unrecognised: report.unrecognised?.length ?? 0,
      baseline: report.baseline,
      multisig: report.multisig ?? null,
    },
  };
  if (name === "rewards") {
    const failing = report.flagged.filter((r) => r.problems?.length);
    return {
      ok: failing.length === 0,
      alerts: failing.map((r) => `reward run ${r.id} ${r.coin ?? ""}: ${r.problems.join("; ")}`),
      summary: { ...report.summary,
        notes: report.flagged.filter((r) => !r.problems?.length && r.note).map((r) => `run ${r.id}: ${r.note}`),
        diagnoses: failing.filter((r) => r.diagnosis).map((r) => ({ id: r.id, coin: r.coin, ...r.diagnosis })),
        followTheMoney: report.summary.followTheMoney ?? null,
        batchGroups: report.summary.batchGroups ?? null, distinctReleases: report.summary.distinctReleases ?? null,
        runsWithRelease: report.summary.runsWithRelease ?? null,
        maxRunId: Math.max(0, ...report.results.filter((r) => !r.notFound && !r.unchecked).map((r) => r.id)) },
    };
  }
  if (name === "tax") return {
    ok: report.alerts.length === 0,
    alerts: report.alerts,
    summary: { coins: report.coins, matching: report.matching, feeChangeable: report.feeChangeable,
      feeRenounced: report.feeRenounced, advertisedRange: report.advertisedRange, epoch: report.epoch, notes: report.notes },
  };
  if (name === "coins") return {
    ok: true, alerts: [], // informational: flags are facts about coins, not faults in Sapling
    events: report.events ?? [], // posted once each, never "open"
    summary: { coins: report.coins, carded: report.carded, refreshed: report.refreshed, flagged: report.flagged,
      flagCounts: report.flagCounts, notes: report.notes },
  };
  if (name === "earnings") return { ok: true, alerts: [], summary: report.summary ?? {} };
  if (name === "payees") return { ok: report.alerts.length === 0, alerts: report.alerts, events: report.events ?? [],
    summary: { ...report.summary, notes: report.notes ?? [] } };
  if (name === "liquidity") return { ok: report.alerts.length === 0, alerts: report.alerts, events: report.events ?? [],
    summary: { ...report.summary, notes: report.notes ?? [] } };
  if (name === "split") return { ok: report.alerts.length === 0, alerts: report.alerts, events: report.events ?? [],
    summary: { ...report.summary, notes: report.notes ?? [] } };
  if (name === "zec") return { ok: report.alerts.length === 0, alerts: report.alerts, events: report.events ?? [],
    summary: { ...report.summary, notes: report.notes ?? [] } };
  if (name === "programs") return {
    ok: report.alerts.length === 0,
    alerts: report.alerts,
    summary: { saplingPrograms: report.saplingPrograms, otherPrograms: report.otherPrograms, terminal: report.terminal ?? null,
      programsSeen: report.programsSeen, txsRead: report.txsRead, notes: report.notes },
  };
  if (name === "flywheel") return {
    ok: report.alerts.length === 0,
    alerts: report.alerts,
    summary: { headline: report.headline ?? null, saplingBurn: report.saplingBurn ?? null, burns: report.burns, burnsVerified: report.burnsVerified, boughtBackZat: report.boughtBackZat,
      venues: report.venues, perCoin: report.perCoin, pot: report.pot, signers: report.signers, notes: report.notes },
  };
  if (name === "float") {
    const alerts = [];
    if (!report.withinCaps) alerts.push(`float ${report.currentFloatZec} ZEC / ${report.inFlight} in flight exceeds the published caps`);
    for (const s of report.stuck) alerts.push(`payout stuck at order address ${s.index} (${s.address}): ${s.zec} ZEC for ${s.minutes} min`);
    // Sapling says every forward is a shielded note; checked on live data 2 Nov 2026 (14 of 14 to the shielded pool)
    for (const f of report.privacy?.public ?? []) alerts.push(`forward from order address ${f.from} at ${f.at} went to a public (transparent) address, not a shielded note (${f.tx})`);
    return { ok: alerts.length === 0, alerts, summary: {
      currentFloatZec: report.currentFloatZec, custodyCapZec: report.custodyCapZec,
      inFlight: report.inFlight, inFlightCap: report.inFlightCap, deliveries: report.deliveries,
      deliveredZec: report.deliveredZec, holdMinutes: report.holdMinutes,
      peakFloatZec: report.peakFloatZec, peakAt: report.peakAt, scanned: report.scanned, privacy: report.privacy ?? null } };
  }
}

async function postWebhook(url, text) {
  try {
    await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: redact(text) }) });
  } catch (e) { console.error(`webhook failed: ${e.message}`); }
}

const running = new Set();
async function runCheck(name, cfg, store) {
  if (running.has(name)) return;
  running.add(name);
  if (!args.includes("--once") && store.state.x) store.state.x.thisRun = 0; // long-running service: cap per check run
  const started = new Date().toISOString();
  try {
    const res = await runCommand(commandFor(name, cfg, store), cfg.timeoutMinutes * 60000);
    let entry;
    try {
      const report = JSON.parse(redact(res.out));
      entry = { check: name, startedAt: started, finishedAt: new Date().toISOString(), status: "ran", ...normalise(name, report) };
    } catch {
      // exit code 2 or garbage output = the check itself failed, not Sapling
      entry = { check: name, startedAt: started, finishedAt: new Date().toISOString(), status: "error",
        ok: null, alerts: [], error: redact((res.err || res.signal || `exit ${res.code}`).toString().trim().slice(-500)) };
    }
    await handleAlerts(name, entry, cfg, store);
    if (entry.events?.length) {
      for (const text of entry.events) store.append("coin-events.jsonl", { at: entry.finishedAt, text });
      await publishToX(name, [], [], cfg, store, entry.events);
      if (cfg.webhook) await postWebhook(cfg.webhook, `zWatchtower (${name === "coins" ? "coin report cards" : name + " check"})\n${entry.events.join("\n")}`);
    }
    // what each basket coin pays, for the rewards explorer
    if (name === "rewards") for (const b of entry.summary?.baskets ?? [])
      if (b.mint) (store.state.rewardBaskets ??= {})[b.mint] = { tokens: b.tokens, run: b.id };
    // runs waiting for a re-check leave the list once one reads them
    if (name === "rewards" && entry.summary?.checkedIds && store.state.rewardsPending?.length)
      store.state.rewardsPending = store.state.rewardsPending.filter((id) => !entry.summary.checkedIds.includes(id));
    if (name === "rewards" && entry.summary?.maxRunId) {
      store.state.rewardsMaxRun = Math.max(store.state.rewardsMaxRun, entry.summary.maxRunId);
      // runs we could not check are re-checked next time
      if (entry.summary.firstUnchecked)
        store.state.rewardsMaxRun = Math.min(store.state.rewardsMaxRun, entry.summary.firstUnchecked + cfg.checks.rewards.recheckLast - 1);
    }
    store.state.latest[name] = entry;
    store.append("history.jsonl", entry);
    store.save();
    console.log(`${entry.finishedAt} ${name}: ${entry.status === "error" ? "ERROR " + entry.error : entry.ok ? "ok" : entry.alerts.length + " alert(s)"}`);
  } finally {
    running.delete(name);
  }
}

// Each distinct alert text is posted once, when it first appears, and again
// as "resolved" when it goes away. A check that errors leaves alerts as they were.
async function handleAlerts(name, entry, cfg, store) {
  if (entry.status === "error") return;
  const open = store.state.openAlerts[name] ?? {};
  const now = new Set(entry.alerts);
  const raised = entry.alerts.filter((a) => !(a in open));
  // a reward run that wasn't checked this time (a failed lookup) keeps its alert:
  // not being able to look is not the same as the problem going away
  const unchecked = new Set((entry.summary?.notes ?? []).map((n) => n.match(/^run (\d+): (?:not checked|release not checked)/)?.[1]).filter(Boolean));
  const runOf = (a) => a.match(/^reward run (\d+)/)?.[1];
  const keepOpen = name === "rewards" ? (a) => !now.has(a) && (reRunIdBelow(a, store) || unchecked.has(runOf(a))) : () => false;
  let resolved = Object.keys(open).filter((a) => !now.has(a) && !keepOpen(a));
  // reward alerts that went away because the run turned out to be paid as a
  // basket of tokens were zWatchtower's misreading: withdrawn, with one correction post
  const basketRuns = new Set((entry.summary?.notes ?? []).map((n) => n.match(/^run (\d+): paid as a basket/)?.[1]).filter(Boolean));
  const misread = name === "rewards" ? resolved.filter((a) => basketRuns.has(runOf(a)) && /shares not floor/.test(a)) : [];
  if (misread.length) {
    resolved = resolved.filter((a) => !misread.includes(a));
    for (const a of misread) {
      delete open[a];
      store.append("alerts.jsonl", { check: name, at: entry.finishedAt, type: "withdrawn", text: a,
        reason: "the run pays holders in several tokens; zWatchtower counted only the ZEC. Every holder got every token in proportion (see CORRECTIONS.md)" });
    }
    const coins = [...new Set(misread.map((a) => a.match(/^reward run \d+ ([^:\s]+)\s*:/)?.[1]).filter(Boolean))];
    await publishToX(name, [], [], cfg, store, [`Correction: we withdraw ${misread.length} holder-reward alert${misread.length === 1 ? "" : "s"}${coins.length ? ` (${coins.map((c) => "$" + c).join(", ")})` : ""}. Those runs pay holders in several tokens and we counted only the ZEC. On chain, every holder got every token in proportion. Our mistake, logged in CORRECTIONS.md.`]);
    if (cfg.webhook) await postWebhook(cfg.webhook, `zWatchtower (${name} check)\n${misread.map((a) => `WITHDRAWN (our misreading): ${a}`).join("\n")}`);
  }
  for (const a of raised) {
    open[a] = entry.finishedAt;
    store.append("alerts.jsonl", { check: name, at: entry.finishedAt, type: "raised", text: a });
  }
  for (const a of resolved) {
    delete open[a];
    store.append("alerts.jsonl", { check: name, at: entry.finishedAt, type: "resolved", text: a });
  }
  store.state.openAlerts[name] = open;
  await publishToX(name, raised, resolved, cfg, store);
  if (cfg.webhook && (raised.length || resolved.length)) {
    const lines = [...raised.map((a) => `NEW: ${a}`), ...resolved.map((a) => `RESOLVED: ${a}`)];
    await postWebhook(cfg.webhook, `zWatchtower (${name} check)\n${lines.join("\n")}`);
  }
}
// Posts at most perRun this run and perDay per UTC day; anything over the cap
// becomes one "and N more" line. Every post (or preview) is logged.
async function publishToX(name, raised, resolved, cfg, store, override) {
  const texts = override ?? composePosts(name, raised, resolved);
  if (!texts.length) return;
  const day = new Date().toISOString().slice(0, 10);
  const x = (store.state.x ??= {});
  if (x.day !== day) { x.day = day; x.today = 0; }
  x.thisRun ??= 0;
  const room = Math.max(0, Math.min(cfg.x.perRun - x.thisRun, cfg.x.perDay - x.today));
  let send = texts.slice(0, room);
  if (texts.length > room && room > 0) {
    send = texts.slice(0, room - 1);
    send.push(`${texts.length - send.length} more ${name} alerts this run. Full list on the zWatchtower dashboard.`);
  }
  for (const t of send) {
    const text = fit(cfg.x.link ? `${t}\n${cfg.x.link}` : t);
    const row = { at: new Date().toISOString(), check: name, text };
    // autopost off (watchtower.ci.json "x": { "autopost": false }): written down, and mirrored to Telegram, but not sent to X
    if (!cfg.x.creds || cfg.x.autopost === false) row.status = "preview";
    else {
      try { row.id = await postToX(text, cfg.x.creds, cfg.x.postUrl); row.status = "posted"; }
      catch (e) { row.status = "error"; row.error = e.message; }
    }
    if (row.status !== "error") { x.today++; x.thisRun++; }
    store.append("x-posts.jsonl", row);
  }
}

// Incremental rewards passes start at state.rewardsFrom; an alert about an
// earlier run stays open unless that run was checked again this pass.
function reRunIdBelow(alert, store) {
  const m = alert.match(/^reward run (\d+)/);
  return Boolean(m) && Number(m[1]) < (store.state.rewardsFrom ?? 1) && !(store.state.rewardsRechecked ?? []).includes(Number(m[1]));
}
// Older runs with alerts still open are checked again on every pass (at most
// 20, oldest first), so an alert closes as soon as the run checks out.
function rewardsRecheck(store, from) {
  const ids = [...new Set([...Object.keys(store.state.openAlerts?.rewards ?? {})
    .map((a) => Number(a.match(/^reward run (\d+)/)?.[1])), ...(store.state.rewardsPending ?? [])]
    .filter((n) => n && n < from))].sort((a, b) => a - b).slice(0, 20);
  store.state.rewardsRechecked = ids;
  return ids.length ? ["--runs", ids.join(",")] : [];
}

// ---- HTTP -------------------------------------------------------------------

const statusBody = (cfg, store) => ({
  apiVersion: 1, // see docs/API.md: fields are only added within a version, never renamed or removed
  generatedAt: new Date().toISOString(),
  schedule: Object.fromEntries(Object.entries(cfg.checks).map(([k, v]) => [k, v.everyMinutes])),
  checks: store.state.latest,
  openAlerts: store.state.openAlerts,
});

// Static copy of the dashboard and its API, for hosting without a server
// (GitHub Pages). The page reads api/status.json and api/alerts.json.
function weeklyReport(cfg, store, to = Date.now()) {
  const coinsPath = join(cfg.dataDir, "coins.json");
  return { apiVersion: 1, ...buildReport({ latest: store.state.latest, openAlerts: store.state.openAlerts, alerts: store.read("alerts.jsonl", () => true, 5000),
    history: store.read("history.jsonl", () => true, 5000),
    coins: existsSync(coinsPath) ? JSON.parse(readFileSync(coinsPath, "utf8")) : null, to }) };
}

function exportSite(cfg, store, dir) {
  mkdirSync(join(dir, "api"), { recursive: true });
  for (const f of ["index.html", "logo.svg", "logo.png"])
    if (existsSync(join(here, "public", f))) copyFileSync(join(here, "public", f), join(dir, f));
  writeFileSync(join(dir, "api", "status.json"), JSON.stringify(statusBody(cfg, store)));
  writeFileSync(join(dir, "api", "alerts.json"), JSON.stringify(store.read("alerts.jsonl", () => true, 500)));
  writeFileSync(join(dir, "api", "history.json"), JSON.stringify(store.read("history.jsonl", () => true, 500)));
  writeFileSync(join(dir, "api", "x-posts.json"), JSON.stringify(store.read("x-posts.jsonl", () => true, 200)));
  const coins = join(cfg.dataDir, "coins.json");
  const creators = join(cfg.dataDir, "creators.json");
  if (existsSync(creators)) copyFileSync(creators, join(dir, "api", "creators.json"));
  const payeesOut = join(cfg.dataDir, "payees.json");
  if (existsSync(payeesOut)) copyFileSync(payeesOut, join(dir, "api", "payees.json"));
  const splitOut = join(cfg.dataDir, "split.json");
  if (existsSync(splitOut)) copyFileSync(splitOut, join(dir, "api", "split.json"));
  const zecOut = join(cfg.dataDir, "zec.json");
  if (existsSync(zecOut)) copyFileSync(zecOut, join(dir, "api", "zec.json"));
  const earnings = join(cfg.dataDir, "rewards.json");
  if (existsSync(earnings)) copyFileSync(earnings, join(dir, "api", "rewards.json"));
  if (existsSync(coins)) {
    copyFileSync(coins, join(dir, "api", "coins.json"));
    // a badge per carded coin: badges/<mint>.svg
    mkdirSync(join(dir, "badges"), { recursive: true });
    try {
      for (const card of JSON.parse(readFileSync(coins, "utf8")).cards ?? [])
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(card.mint)) writeFileSync(join(dir, "badges", `${card.mint}.svg`), badgeSvg(card));
    } catch (e) { console.error(`badges not written: ${e.message}`); }
  }
  writeFileSync(join(dir, "api", "report.json"), JSON.stringify(weeklyReport(cfg, store)));
  for (const f of ["coins.html", "posts.html", "report.html", "creators.html", "rewards.html", "holding.html", "zec.html"])
    if (existsSync(join(here, "public", f))) copyFileSync(join(here, "public", f), join(dir, f));
  writeFileSync(join(dir, ".nojekyll"), "");
}

function serve(cfg, store) {
  const page = () => readFileSync(join(here, "public", "index.html"));
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, code = 200) => {
      res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store",
        "access-control-allow-origin": "*" });
      res.end(JSON.stringify(body));
    };
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100));
    if (url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page()); }
    if (url.pathname === "/creators.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(here, "public", "creators.html"))); }
    if (url.pathname === "/api/creators.json") {
      const f = join(cfg.dataDir, "creators.json");
      res.writeHead(existsSync(f) ? 200 : 404, { "content-type": "application/json" });
      return res.end(existsSync(f) ? readFileSync(f) : "{}");
    }
    if (url.pathname === "/report.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(here, "public", "report.html"))); }
    if (url.pathname === "/api/report.json") return json(weeklyReport(cfg, store));
    if (url.pathname === "/posts.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(here, "public", "posts.html"))); }
    if (url.pathname === "/coins.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(readFileSync(join(here, "public", "coins.html"))); }
    if (url.pathname === "/api/coins.json") {
      const f = join(cfg.dataDir, "coins.json");
      res.writeHead(existsSync(f) ? 200 : 404, { "content-type": "application/json" });
      return res.end(existsSync(f) ? readFileSync(f) : "{}");
    }
    const logo = { "/logo.svg": "image/svg+xml", "/logo.png": "image/png" }[url.pathname];
    if (logo) { res.writeHead(200, { "content-type": logo }); return res.end(readFileSync(join(here, "public", url.pathname.slice(1)))); }
    if (url.pathname === "/healthz") return json({ ok: true });
    const path = url.pathname.replace(/\.json$/, "");
    if (path === "/api/status") return json(statusBody(cfg, store));
    if (path === "/api/history") {
      const check = url.searchParams.get("check");
      return json(store.read("history.jsonl", (r) => !check || r.check === check, limit));
    }
    if (path === "/api/alerts") return json(store.read("alerts.jsonl", () => true, limit));
    json({ error: "not found" }, 404);
  });
  server.listen(cfg.port, () => console.log(`watchtower listening on http://localhost:${cfg.port}`));
  return server;
}

// The first basket check (4 Nov 01:53 UTC) read each run over too wide a
// window and mixed in other coins' payouts, raising 3 wrong alerts. Withdraw
// them once, with a correction, and keep checking those runs until they're read.
async function withdrawFaultyBasketAlerts(cfg, store) {
  const st = store.state;
  if (st.withdrawnBasketV1) return;
  st.withdrawnBasketV1 = new Date().toISOString();
  const open = st.openAlerts?.rewards ?? {};
  const bad = Object.keys(open).filter((a) => /basket payout doesn't add up/.test(a));
  if (!bad.length) { store.save(); return; }
  const ids = [], coins = new Set();
  for (const a of bad) {
    delete open[a];
    const m = a.match(/^reward run (\d+) ([^:\s]+)/);
    if (m) { ids.push(Number(m[1])); coins.add(m[2]); }
    store.append("alerts.jsonl", { check: "rewards", at: st.withdrawnBasketV1, type: "withdrawn", text: a,
      reason: "raised by the first version of the basket check, which read too wide a window and mixed in other runs' payouts (see CORRECTIONS.md)" });
  }
  st.rewardsPending = [...new Set([...(st.rewardsPending ?? []), ...ids])].sort((a, b) => a - b);
  store.save();
  await publishToX("rewards", [], [], cfg, store, [`Correction: we withdraw ${bad.length} holder-reward alert${bad.length === 1 ? "" : "s"} (${[...coins].map((c) => "$" + c).join(", ")}) posted at 01:53 UTC. A bug in our new check mixed in other runs' payouts. Those runs are being checked again. Our mistake, logged in CORRECTIONS.md.`]);
  if (cfg.webhook) await postWebhook(cfg.webhook, `zWatchtower (rewards check)\n${bad.map((a) => `WITHDRAWN (our bug): ${a.slice(0, 120)}`).join("\n")}`);
  store.save();
}

// ---- main -------------------------------------------------------------------

async function main() {
  const cfg = loadConfig();
  const store = new Store(cfg.dataDir);
  withdrawOwnFailures(store);
  await withdrawFaultyBasketAlerts(cfg, store);
  const names = Object.keys(cfg.checks).filter((n) => cfg.checks[n].everyMinutes > 0);
  if (opt("--export") && !args.includes("--once")) return exportSite(cfg, store, resolve(opt("--export")));
  if (args.includes("--once")) {
    // --due: skip a check that ran less than its interval ago (2 min slack, so a
    // 15-minute cron that starts a little early still runs a 15-minute check)
    const due = (n) => {
      const last = Date.parse(store.state.latest[n]?.finishedAt ?? 0);
      return !args.includes("--due") || !last || Date.now() - last >= cfg.checks[n].everyMinutes * 60000 - 120000;
    };
    if (store.state.x) store.state.x.thisRun = 0;
    for (const n of names.filter(due)) await runCheck(n, cfg, store);
    // one summary post a day, on the first run after 00:00 UTC; without X keys
    // it is always written as a preview, ready to copy from the posts page
    const day = new Date().toISOString().slice(0, 10);
    if ((cfg.x.dailySummary || !cfg.x.creds) && store.state.xSummaryDay !== day && Object.keys(store.state.latest).length) {
      store.state.xSummaryDay = day;
      await publishToX("summary", [], [], cfg, store, [composeSummary(store.state.latest)]);
      store.save();
    }
    // the weekly report post, on the first run of each Monday (UTC)
    const week = day; // the Monday's date
    if (new Date().getUTCDay() === 1 && store.state.xWeekly !== week && Object.keys(store.state.latest).length) {
      store.state.xWeekly = week;
      await publishToX("weekly", [], [], cfg, store, [composeWeekly(weeklyReport(cfg, store))]);
      store.save();
    }
    if (opt("--export")) exportSite(cfg, store, resolve(opt("--export")));
    const failing = names.filter((n) => store.state.latest[n]?.ok === false);
    process.exitCode = failing.length ? 1 : 0;
    return;
  }
  serve(cfg, store);
  for (const n of names) {
    runCheck(n, cfg, store);
    setInterval(() => runCheck(n, cfg, store), cfg.checks[n].everyMinutes * 60000);
  }
}

main();
