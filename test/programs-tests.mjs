// Sapling's programs: found in Sapling's wallets' transactions, watched when
// Sapling can upgrade them.
import { programsInTx, programAlerts, LOADER_UPGRADEABLE, JUPITER } from "../lib/programs.mjs";
import { encode } from "../lib/base58.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

const addr = (n) => encode(Buffer.alloc(32, n));
const SQUADS_VAULT = "3eCXkzzn85PLe9zWmzPRAhxioNZRzaHcarL5yz57sMtf";
const GUARD = addr(7), OTHER = addr(8), NEWP = addr(9);

// ---- reading a transaction
const swapTx = { transaction: { message: { instructions: [
  { programId: "ComputeBudget111111111111111111111111111111" },
  { programId: GUARD },
] } }, meta: { innerInstructions: [{ instructions: [{ programId: JUPITER }, { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" }] }] } };
let r = programsInTx(swapTx);
check("a program's inner calls count (Jupiter under the guard)", r.invoked.has(GUARD) && r.invoked.has(JUPITER));
const upgradeTx = { transaction: { message: { instructions: [{ programId: "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf" }] } },
  meta: { innerInstructions: [{ instructions: [{ programId: LOADER_UPGRADEABLE, parsed: { type: "upgrade", info: { programAccount: NEWP } } }] }] } };
r = programsInTx(upgradeTx);
check("a multisig upgrade names the upgraded program", r.touched.has(NEWP) && !r.invoked.has(NEWP));

// ---- comparing runs
const prev = { [GUARD]: { authority: SQUADS_VAULT, slot: 100, sapling: true }, [OTHER]: { authority: addr(1), slot: 5, sapling: false } };
check("nothing changed, nothing raised", programAlerts(prev, prev, false).length === 0);
check("an upgrade is raised", programAlerts(prev, { ...prev, [GUARD]: { ...prev[GUARD], slot: 200 } }, false)
  .some((a) => a === `program ${GUARD} upgraded: last deploy slot 100 -> 200`));
check("an authority change is raised", programAlerts(prev, { ...prev, [GUARD]: { authority: addr(3), slot: 100, sapling: false } }, false)
  .some((a) => a.startsWith(`program ${GUARD} upgrade authority is ${addr(3)}`)));
check("made immutable is raised too", programAlerts(prev, { ...prev, [GUARD]: { authority: null, slot: 100, sapling: false } }, false)
  .some((a) => /made immutable/.test(a)));
check("other people's programs are not watched", programAlerts(prev, { ...prev, [OTHER]: { authority: addr(2), slot: 6, sapling: false } }, false).length === 0);
const withNew = { ...prev, [NEWP]: { authority: SQUADS_VAULT, slot: 300, sapling: true } };
check("a new Sapling program is raised", programAlerts(prev, withNew, false).some((a) => a.startsWith(`new program controlled by Sapling: ${NEWP}`)));
check("but not on the first run", programAlerts({}, withNew, true).length === 0);

// ---- end to end against a fake RPC
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "programs-test-"));
const st = join(dir, "state.json");
const chain = {
  sigs: { [SQUADS_VAULT]: [], FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr: [{ signature: "swap1" }] },
  txs: { swap1: swapTx, upg1: upgradeTx },
  programs: { [GUARD]: { authority: SQUADS_VAULT, slot: 100 }, [JUPITER]: { authority: addr(4), slot: 50 }, [NEWP]: { authority: SQUADS_VAULT, slot: 300 } },
};
const pdOf = (id) => addr(100 + Object.keys(chain.programs).indexOf(id));
const b64 = (buf) => [buf.toString("base64"), "base64"];
const server = createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d));
  req.on("end", () => {
    const { method, params } = JSON.parse(body);
    const send = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result })); };
    if (method === "getSignaturesForAddress") {
      const all = chain.sigs[params[0]] ?? [];
      const until = params[1]?.until;
      const i = until ? all.findIndex((s) => s.signature === until) : -1;
      return send(i >= 0 ? all.slice(0, i) : all);
    }
    if (method === "getTransaction") return send(chain.txs[params[0]] ?? null);
    if (method === "getAccountInfo") {
      const a = params[0];
      if (chain.programs[a]) {
        const d = Buffer.alloc(36); d.writeUInt32LE(2, 0); Buffer.from(Buffer.from(pdOfBytes(a))).copy(d, 4);
        return send({ value: { owner: LOADER_UPGRADEABLE, executable: true, data: b64(d) } });
      }
      const id = Object.keys(chain.programs).find((p) => pdOf(p) === a);
      if (id) {
        const p = chain.programs[id], d = Buffer.alloc(45);
        d.writeUInt32LE(3, 0); d.writeBigUInt64LE(BigInt(p.slot), 4);
        if (p.authority) { d[12] = 1; Buffer.from(decodeAddr(p.authority)).copy(d, 13); }
        return send({ value: { owner: LOADER_UPGRADEABLE, executable: false, data: b64(d) } });
      }
      return send({ value: null });
    }
    send(null);
  });
});
import { decode as decodeAddr } from "../lib/base58.mjs";
const pdOfBytes = (id) => decodeAddr(pdOf(id));
await new Promise((ok) => server.listen(0, ok));
const rpcUrl = `http://127.0.0.1:${server.address().port}`;
const run = () => new Promise((done) => {
  const p = spawn(process.execPath, [join(here, "../programs-check.mjs"), "--json", "--rpc", rpcUrl, "--state", st, "--pause", "0"]);
  let o = "", e = ""; p.stdout.on("data", (d) => (o += d)); p.stderr.on("data", (d) => (e += d));
  p.on("close", (code) => { let report = null; try { report = JSON.parse(o); } catch {} done({ code, report, err: e }); });
});
try {
  let x = await run();
  const g = x.report?.saplingPrograms?.find((p) => p.id === GUARD);
  check("end to end: the guard is found and marked by its Jupiter trades", x.code === 0 && g?.authority === SQUADS_VAULT &&
    g.lastDeploySlot === 100 && /Terminal guard/.test(g.role), x.err || JSON.stringify(x.report));
  check("end to end: Jupiter is seen but not Sapling's", x.report.otherPrograms.some((p) => p.id === JUPITER) && x.report.alerts.length === 0);

  chain.programs[GUARD].slot = 150;
  x = await run();
  check("end to end: an upgrade of the guard is an alert", x.report.alerts.some((a) => /upgraded: last deploy slot 100 -> 150/.test(a)), JSON.stringify(x.report.alerts));

  chain.sigs[SQUADS_VAULT] = [{ signature: "upg1" }];
  x = await run();
  check("end to end: a new program the multisig deploys is an alert", x.report.alerts.some((a) => a.startsWith(`new program controlled by Sapling: ${NEWP}`)), JSON.stringify(x.report.alerts));
  x = await run();
  check("end to end: and only once", x.report.alerts.length === 0, JSON.stringify(x.report.alerts));
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
