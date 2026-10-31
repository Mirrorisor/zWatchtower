// Offline test for tax-check.mjs: stubs Sapling's coin list and Solana's
// mint accounts (shaped as seen live on 2026-10-29), then tampers with each.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "tax-test-"));
const chainFile = join(dir, "chain.json"), statePath = join(dir, "state.json");
const PDA_W = "69nv6e1SZfdo9J6j45uuke4PBdLi6RYAiJpecG6HGLEY", PDA_C = "WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh";
const OTHER = "5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV";

const mint = ({ bps = 500, newer = bps, newerEpoch = 1070, cfg = PDA_C, withdraw = PDA_W, mintAuth = null, extra = [] } = {}) => ({
  owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  data: { parsed: { info: { decimals: 6, mintAuthority: mintAuth, freezeAuthority: null, extensions: [
    { extension: "metadataPointer", state: {} },
    { extension: "transferFeeConfig", state: {
      olderTransferFee: { epoch: 1069, maximumFee: 18446744073709552000, transferFeeBasisPoints: bps },
      newerTransferFee: { epoch: newerEpoch, maximumFee: 18446744073709552000, transferFeeBasisPoints: newer },
      transferFeeConfigAuthority: cfg, withdrawWithheldAuthority: withdraw, withheldAmount: 1000 } },
    { extension: "tokenMetadata", state: {} }, ...extra] } } },
});

const chain = {
  epoch: 1071,
  list: [
    { mint: "Coin1111111111111111111111111111111111zcash", symbol: "AAA", venue: "launchlab", taxBps: 500, stage: "seed" },
    { mint: "Coin2222222222222222222222222222222222zcash", symbol: "BBB", venue: "launchlab", taxBps: 300, stage: "orchard" },
    { mint: "PumpCoin", symbol: "PUMP", venue: null, taxBps: null },
  ],
  mints: {
    Coin1111111111111111111111111111111111zcash: mint({ bps: 500 }),
    Coin2222222222222222222222222222222222zcash: mint({ bps: 300, cfg: null }),
  },
};

const preload = `
  import { readFileSync } from "node:fs";
  globalThis.fetch = async (url, init) => {
    const c = JSON.parse(readFileSync(process.env.CHAIN_FILE, "utf8"));
    const ok = (b) => ({ ok: true, status: 200, json: async () => b });
    if (String(url).includes("/api/coins")) return ok(c.list);
    const { method, params } = JSON.parse(init.body);
    if (method === "getEpochInfo") return ok({ result: { epoch: c.epoch } });
    if (method === "getMultipleAccounts") return ok({ result: { value: params[0].map((m) => c.mints[m] ?? null) } });
    throw new Error("unexpected " + method);
  };`;

function run() {
  writeFileSync(chainFile, JSON.stringify(chain));
  const r = spawnSync(process.execPath, ["--import", "data:text/javascript," + encodeURIComponent(preload),
    join(here, "../tax-check.mjs"), "--rpc", "http://stub", "--state", statePath, "--json"],
    { encoding: "utf8", env: { ...process.env, CHAIN_FILE: chainFile } });
  if (!r.stdout) throw new Error(r.stderr);
  return { code: r.status, ...JSON.parse(r.stdout) };
}
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
const A = "Coin1111111111111111111111111111111111zcash", B = "Coin2222222222222222222222222222222222zcash";

let r = run();
check("matching coins give no alerts", r.alerts.length === 0 && r.code === 0 && r.coins === 2, r.alerts.join("; "));
check("pump.fun coins are skipped", !r.results.some((x) => x.symbol === "PUMP"));
check("counts renounced and changeable fees", r.feeChangeable === 1 && r.feeRenounced === 1);

chain.mints[A] = mint({ bps: 500, newer: 9900, newerEpoch: 1073 });
r = run();
check("scheduled fee raise is alerted before it applies", r.alerts.some((a) => /fee change scheduled: 5% -> 99% from epoch 1073/.test(a)), r.alerts[0]);

chain.mints[A] = mint({ bps: 500, newer: 9900, newerEpoch: 1071 });
r = run();
check("raise now in force is alerted against the advertised rate", r.alerts.some((a) => /fee in force 99% but Sapling shows 5%/.test(a)), r.alerts[0]);

chain.mints[A] = mint({ bps: 500, withdraw: OTHER });
r = run();
check("fees withdrawable by an ordinary wallet are alerted", r.alerts.some((a) => /fee withdraw authority is 5H1gfd/.test(a)));

chain.mints[A] = mint({ bps: 500, cfg: OTHER });
r = run();
check("fee changeable by another key is alerted", r.alerts.some((a) => /fee can be changed by 5H1gfd/.test(a)));

chain.mints[A] = mint({ bps: 500, mintAuth: OTHER, extra: [{ extension: "permanentDelegate", state: {} }] });
r = run();
check("mint authority and permanent delegate are alerted",
  r.alerts.some((a) => /more can be minted/.test(a)) && r.alerts.some((a) => /permanentDelegate/.test(a)));

chain.mints[A] = mint({ bps: 500 });
chain.list = chain.list.filter((c) => c.mint !== B);
chain.mints[B] = mint({ bps: 300, newer: 600, newerEpoch: 1073, cfg: null });
r = run();
check("a coin no longer listed is still checked", r.coins === 2 && r.alerts.some((a) => a.includes("BBB")), r.alerts.join("; "));

rmSync(dir, { recursive: true, force: true });
process.exitCode = failures ? 1 : 0;
