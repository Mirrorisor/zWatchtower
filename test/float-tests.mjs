// Offline test for float-check.mjs: stubs the exits file and 3xpl with data
// captured on 2026-10-28, then a variant with one payout left unforwarded.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));

// Runs float-check.mjs in a child process with fetch stubbed by a preload.
function run(extra, mutate) {
  const events = JSON.parse(readFileSync(join(here, "fixtures/order-addresses-2026-10-28.json"), "utf8"));
  delete events._note;
  if (mutate) mutate(events);
  const exits = {
    accountPubkey: "e67862fdeb3f6321b3a0632f62997d416e04e02ef91e7947e528b82bab7d692202761be0a902f7e9f582e70f4fbc0a653b0d90940c6a5edd5c8e7381b94dd8757f",
    accountsPubkey: "29768824dfc70b2055cdc455003be2ac4b7e54a7a76f0fb4b4817f8aa58fb47103e4042b70f0991afcd9efff5240e55c23035c3343b7fbe04f718e2e3fa82dac60",
    caps: { custodyZat: "20000000000", inFlight: 50 },
  };
  const preload = `globalThis.__transparentTx = ${JSON.stringify(globalThis.transparentTx ?? null)};
    const events = ${JSON.stringify(events)};
    const exits = ${JSON.stringify(exits)};
    globalThis.fetch = async (url) => {
      url = String(url);
      const ok = (b) => ({ ok: true, status: 200, json: async () => b });
      if (url.includes("sapling-exits.json")) return ok(exits);
      const m = url.match(/zcash\\/address\\/([^?]+)/);
      if (m) {
        const ev = events[m[1]] || [];
        const bal = ev.reduce((a, e) => a + BigInt(e[1]), 0n);
        return ok({ data: { balances: { "zcash-main": { zcash: { balance: String(bal) } } },
          events: { "zcash-main": ev.map(([time, effect, transaction]) => ({ time, effect, transaction })) } } });
      }
      const t = url.match(/zcash\\/transaction\\/([^?]+)/);
      if (t) {
        // every forward goes to the Orchard pool, except one sent to a t-address
        const to = t[1] === globalThis.__transparentTx ? "t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU" : "zcash-orchard-pool";
        return ok({ data: { events: { "zcash-main": [
          { address: "t1FromOrderAddressXXXXXXXXXXXXXXXXX", effect: "-100000" },
          { address: to, effect: "99000" }, { address: "the-void", effect: "1000" }] } } });
      }
      throw new Error("unexpected fetch " + url);
    };`;
  const r = spawnSync(process.execPath,
    ["--import", "data:text/javascript," + encodeURIComponent(preload),
     join(here, "../float-check.mjs"), "--count", "60", "--gap", "20", "--delay-ms", "0", "--json", ...extra],
    { encoding: "utf8" });
  if (r.stderr.trim()) process.stderr.write(r.stderr);
  return { code: r.status, report: JSON.parse(r.stdout) };
}

let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ": " + detail : ""}`);
};

const a = run([]);
check("finds all 14 deliveries", a.report.deliveries === 14, String(a.report.deliveries));
check("delivered total matches Rings (2.2957 ZEC after 14 x 0.00015 fee)",
  Math.abs(a.report.deliveredZec - 14 * 0.00015 - 2.2957) < 0.00005, String(a.report.deliveredZec));
check("float is zero and within caps", a.report.currentFloatZec === 0 && a.report.withinCaps && a.code === 0);
check("nothing stuck", a.report.stuck.length === 0);
// Largest moment: the single 0.5716808 ZEC payout on 2 Oct, which beats the
// two payouts that overlapped on 7 Oct (0.23971459 + 0.22044238).
check("peak float is the 2 Oct payout", a.report.peakFloatZec === 0.5716808 &&
  a.report.peakAt === "2026-10-02T23:13:00.000Z", `${a.report.peakFloatZec} at ${a.report.peakAt}`);

// Leave the 18th order address's payout unforwarded.
const b = run(["--stuck-minutes", "60"], (ev) => {
  ev["t1auBszcWwx8MCYKDkGNxEcD4WZgK81E34s"] = ev["t1auBszcWwx8MCYKDkGNxEcD4WZgK81E34s"].filter((e) => e[1].startsWith("+"));
});
check("unforwarded payout is flagged as stuck", b.report.stuck.length === 1 && b.report.stuck[0].index === 18,
  JSON.stringify(b.report.stuck[0]));
check("exit code 1 when something is stuck", b.code === 1);

// privacy: where each forward went
check("every forward is classified, fee left out", a.report.privacy?.forwards === 14 &&
  a.report.privacy.shielded === a.report.privacy.forwards && a.report.privacy.poolNames.join() === "zcash-orchard-pool", JSON.stringify(a.report.privacy));
const fx = JSON.parse(readFileSync(join(here, "fixtures/order-addresses-2026-10-28.json"), "utf8"));
const firstForward = Object.entries(fx).filter(([k]) => k !== "_note").flatMap(([, ev]) => ev).find(([, eff]) => BigInt(eff) < 0n)?.[2];
globalThis.transparentTx = firstForward;
const t = run([]);
check("a forward to a t-address is counted as transparent and listed", t.report.privacy.transparent === 1 && t.report.privacy.public.length === 1 &&
  t.report.privacy.shielded === t.report.privacy.forwards - 1, JSON.stringify(t.report.privacy));
check("--no-privacy skips it", run(["--no-privacy"]).report.privacy === undefined);

process.exitCode = failures ? 1 : 0;
