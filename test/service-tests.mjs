// Offline test for watchtower.mjs: scripted check results, a local webhook
// listener, and a short-lived server for the API and dashboard.
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "svc-test-"));
const scenarioPath = join(dir, "scenario.json"), argsLog = join(dir, "args.log");
const dataDir = join(dir, "data");

// webhook listener
const posts = [];
const hook = createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => { posts.push(JSON.parse(b).text); res.end("ok"); });
});
await new Promise((r) => hook.listen(0, r));
const hookUrl = `http://127.0.0.1:${hook.address().port}/`;

const fake = (name) => [process.execPath, join(here, "fake-check.mjs"), name];
const config = (extra = {}) => {
  const p = join(dir, "config.json");
  writeFileSync(p, JSON.stringify({ dataDir, webhook: hookUrl,
    commands: { keys: fake("keys"), rewards: fake("rewards"), float: fake("float"), tax: fake("tax"), flywheel: fake("flywheel") }, ...extra }));
  return p;
};

const keysReport = (alerts = []) => ({ baseline: false, alerts,
  program: { upgradeAuthority: "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf", lastDeploySlot: 400000000 },
  config: { sha256: "ab".repeat(32), walletsPresent: ["treasury", "rewards"] },
  vaultInstructions: { settle: 12 }, unrecognised: [] });
const rewardsReport = (ids, problems = {}) => ({
  summary: { runs: ids.length, passed: ids.length - Object.keys(problems).length,
    flagged: Object.keys(problems).length, zecPaidInDoneRuns: "1.00000000", onChainChecks: true },
  flagged: Object.entries(problems).map(([id, p]) => ({ id: Number(id), coin: "TEST", problems: [p] })),
  results: ids.map((id) => ({ id, problems: problems[id] ? [problems[id]] : [] })),
});
const floatReport = (stuck = []) => ({ currentFloatZec: 0, custodyCapZec: 200, inFlight: stuck.length,
  inFlightCap: 50, withinCaps: true, stuck, deliveries: 14, deliveredZec: 2.29777685,
  holdMinutes: { median: 20.6, p95: 25.2, max: 25.2 }, peakFloatZec: 0.5716808, peakAt: "2026-10-02T23:13:00.000Z" });

async function once(scenario, extraEnv = {}) {
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const before = posts.length;
  // async, so this process's webhook listener can answer while the service runs
  const r = await new Promise((done) => {
    const c = spawn(process.execPath, [join(here, "../watchtower.mjs"), "--once", "--config", config()],
      { env: { ...process.env, SCENARIO: scenarioPath, ARGS_LOG: argsLog, ...extraEnv } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => done({ status, stdout, stderr }));
  });
  const state = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8"));
  return { code: r.status, out: r.stdout, err: r.stderr, state, newPosts: posts.slice(before) };
}
const rewardsArgs = () => readFileSync(argsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l))
  .filter((x) => x.name === "rewards").map((x) => x.args.join(" "));

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

// 1. all clear
let r = await once({ keys: keysReport(), rewards: rewardsReport([1, 2, 3, 100]), float: floatReport() });
check("all checks clear: exit 0, no webhook", r.code === 0 && r.newPosts.length === 0, r.err.trim());
check("latest results stored for all three", ["keys", "rewards", "float"].every((k) => r.state.latest[k]?.ok === true));
check("first rewards pass starts at run 1", rewardsArgs()[0].endsWith("--from 1"), rewardsArgs()[0]);

// 2. a keys alert appears
const A = "vault config changed: rewards wallet no longer in config; bytes changed at 40-71";
r = await once({ keys: keysReport([A]), rewards: rewardsReport([96, 97, 98, 99, 100]), float: floatReport() });
check("new alert is posted once", r.newPosts.length === 1 && r.newPosts[0].includes(`NEW: ${A}`), r.newPosts[0]);
check("exit 1 while an alert is open", r.code === 1);
check("next rewards pass is incremental", rewardsArgs()[1].endsWith("--from 95"), rewardsArgs()[1]);

// 3. same alert again: no repeat
r = await once({ keys: keysReport([A]), rewards: rewardsReport([96, 97, 98, 99, 100]), float: floatReport() });
check("repeated alert is not posted again", r.newPosts.length === 0);

// 4. float check crashes: recorded as a check error, alerts untouched
r = await once({ keys: keysReport([A]), rewards: rewardsReport([96, 97, 98, 99, 100]), float: "crash" });
check("crashed check is stored as an error", r.state.latest.float.status === "error" &&
  r.state.latest.float.error.includes("simulated RPC outage"), r.state.latest.float.error);
check("a crash posts nothing", r.newPosts.length === 0);

// 5. alert clears
r = await once({ keys: keysReport(), rewards: rewardsReport([96, 97, 98, 99, 100, 101]), float: floatReport() });
check("cleared alert is posted as resolved", r.newPosts.length === 1 && r.newPosts[0].includes(`RESOLVED: ${A}`), r.newPosts[0]);

// 6. a rewards failure in the re-checked window, then a pass that no longer covers it
r = await once({ keys: keysReport(), rewards: rewardsReport([96, 97, 98, 99, 100, 101], { 97: "snapshot hash mismatch" }), float: floatReport() });
check("rewards failure is raised", r.newPosts.some((p) => p.includes("NEW: reward run 97")), r.newPosts.join(" | "));
// next pass starts at 96, so it re-checks 97 (still failing), and finds new runs up to 115
const upTo115 = Array.from({ length: 20 }, (_, i) => 96 + i);
r = await once({ keys: keysReport(), rewards: rewardsReport(upTo115, { 97: "snapshot hash mismatch" }), float: floatReport() });
check("still-failing run is not posted twice", !r.newPosts.some((p) => p.includes("reward run 97")));
// the pass after that starts at 110 and no longer covers 97
r = await once({ keys: keysReport(), rewards: rewardsReport([110, 111, 112, 113, 114, 115]), float: floatReport() });
check("run 97 stays open once later passes no longer re-check it",
  rewardsArgs().at(-1).endsWith("--from 110") &&
  Object.keys(r.state.openAlerts.rewards).some((a) => a.startsWith("reward run 97")) &&
  !r.newPosts.some((p) => p.includes("RESOLVED: reward run 97")), rewardsArgs().at(-1));

// 7. a stuck payout
r = await once({ keys: keysReport(), rewards: rewardsReport([115]), float: floatReport([
  { index: 19, address: "t1Rhb49CvegUVNtbLV8baoReeD6W7XDwxs4", zec: 0.25, minutes: 95 }]) });
check("stuck payout is raised", r.newPosts.some((p) => p.includes("NEW: payout stuck at order address 19")), r.newPosts.join(" | "));

// 8. --due skips checks that ran recently; --export writes a static site
const runArgs = (extra) => new Promise((done) => {
  const c = spawn(process.execPath, [join(here, "../watchtower.mjs"), "--once", ...extra, "--config", config()],
    { env: { ...process.env, SCENARIO: scenarioPath, ARGS_LOG: argsLog } });
  c.on("close", (status) => done(status));
});
const before = readFileSync(argsLog, "utf8").trim().split("\n").length;
const site = join(dir, "site");
await runArgs(["--due", "--export", site]);
const ranNow = readFileSync(argsLog, "utf8").trim().split("\n").length - before;
check("--due runs nothing that ran moments ago", ranNow === 0, `${ranNow} ran`);
const exported = ["index.html", "api/status.json", "api/alerts.json", "api/history.json"].every((f) => existsSync(join(site, f)));
const st = exported ? JSON.parse(readFileSync(join(site, "api/status.json"), "utf8")) : {};
check("--export writes the dashboard and its data", exported && st.checks?.keys && st.schedule?.flywheel);

// 9. alerts that were really our own failed lookups are withdrawn, not left open
const statePathS = join(dataDir, "state.json");
const sst = JSON.parse(readFileSync(statePathS, "utf8"));
sst.openAlerts.rewards = { ...sst.openAlerts.rewards, "reward run 5 : error: HTTP error for https://api.mainnet-beta.solana.com": "x" };
writeFileSync(statePathS, JSON.stringify(sst));
r = await once({ keys: keysReport(), rewards: rewardsReport([115]), float: floatReport() });
check("own failed lookups are withdrawn quietly", !Object.keys(r.state.openAlerts.rewards).some((a) => /HTTP error/.test(a)) &&
  !r.newPosts.some((p) => /HTTP error/.test(p)));

// 10. X posts: previewed without keys, posted with them, and capped
const xLog = () => existsSync(join(dataDir, "x-posts.jsonl"))
  ? readFileSync(join(dataDir, "x-posts.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const upgradeAlerts = (slot) => [`vault program upgraded: last deploy slot ${slot} -> ${slot + 1}`,
  "multisig vault_transaction_execute at 2026-10-31T23:24:37.000Z (54Toh)", "multisig proposal_approve at 2026-10-31T23:22:48.000Z (3cDV)"];
r = await once({ keys: keysReport(upgradeAlerts(1)), rewards: rewardsReport([115]), float: floatReport() });
let xs = xLog();
check("without X keys, posts are only previewed", xs.length >= 1 && xs.every((x) => x.status === "preview") &&
  /Sapling just upgraded its vault program at 23:24 UTC, through its Squads multisig/.test(xs.at(-1).text), JSON.stringify(xs.at(-1)));

const xPosts = [];
const xServer = createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => { xPosts.push({ auth: req.headers.authorization, body: JSON.parse(b) });
    res.writeHead(201, { "content-type": "application/json" }); res.end(JSON.stringify({ data: { id: String(xPosts.length) } })); });
});
await new Promise((ok) => xServer.listen(0, ok));
const xEnv = { X_API_KEY: "k", X_API_SECRET: "s", X_ACCESS_TOKEN: "t", X_ACCESS_SECRET: "u",
  X_POST_URL: `http://127.0.0.1:${xServer.address().port}/2/tweets`, X_MAX_PER_RUN: "2" };
r = await once({ keys: keysReport([...upgradeAlerts(5),
  "privileged vault instruction set_gas via multisig at 2026-10-29T20:23:48.000Z (3MUt)",
  "privileged vault instruction set_stock_quote via multisig at 2026-10-31T20:52:47.000Z (2Gau)"]),
  rewards: rewardsReport([115]), float: floatReport() }, xEnv);
xs = xLog();
check("with keys, posts go to X signed with OAuth", xPosts.length === 2 && xPosts.every((p) => /^OAuth .*oauth_signature="/.test(p.auth)),
  `${xPosts.length} posted`);
check("over the per-run cap, the last post says how many more", /2 more keys alerts this run/.test(xPosts.at(-1)?.body.text ?? ""),
  xPosts.at(-1)?.body.text);
check("every post is logged with its X id", xs.filter((x) => x.status === "posted").length === 2 && xs.at(-1).id === "2");
check("an old event doesn't claim a fast catch", !/Flagged \d+ minutes/.test(xPosts[0]?.body.text ?? ""), xPosts[0]?.body.text);
xServer.close();

// 11. the server: API and dashboard
writeFileSync(scenarioPath, JSON.stringify({ keys: keysReport(), rewards: rewardsReport([115]), float: floatReport() }));
const port = 18000 + Math.floor(Math.random() * 1000);
const srv = spawn(process.execPath, [join(here, "../watchtower.mjs"), "--config",
  config({ checks: { keys: { everyMinutes: 60 }, rewards: { everyMinutes: 60 }, float: { everyMinutes: 60 }, tax: { everyMinutes: 60 }, flywheel: { everyMinutes: 60 } } }),
  "--port", String(port)], { env: { ...process.env, SCENARIO: scenarioPath, ARGS_LOG: argsLog } });
await new Promise((s) => setTimeout(s, 1500));
try {
  const status = await fetch(`http://127.0.0.1:${port}/api/status.json`).then((x) => x.json());
  check("/api/status serves all five checks", ["keys", "rewards", "float", "tax", "flywheel"].every((k) => status.checks[k]));
  const alerts = await fetch(`http://127.0.0.1:${port}/api/alerts`).then((x) => x.json());
  check("/api/alerts lists raised and resolved events, newest first",
    alerts.length >= 4 && alerts[0].at >= alerts.at(-1).at, `${alerts.length} events`);
  const hist = await fetch(`http://127.0.0.1:${port}/api/history?check=keys&limit=3`).then((x) => x.json());
  check("/api/history filters and limits", hist.length === 3 && hist.every((h) => h.check === "keys"));
  const page = await fetch(`http://127.0.0.1:${port}/`).then((x) => x.text());
  check("dashboard page is served", page.includes("<title>zWatchtower</title>"));
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  check("/healthz answers 200", health.status === 200);
} finally {
  srv.kill();
  hook.close();
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
