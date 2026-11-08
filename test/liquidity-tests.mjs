// Protocol-owned liquidity: the $SAPLING/ZEC pool's LP tokens stay burned.
import { parsePool, judgeLiquidity, POOL, LP_MINT, TREASURY, PUMP_AMM } from "../lib/liquidity.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
// the real pool account, read 2026-11-08
const DATA = "8ZptBBGxbbz8AAAtR5JNt3vu5zB2ToA/4JVyCmImNmT3FI+H0M8ya87SmZzX5YNdDpx9/botWxibWSeTxB1/S5ZBeN0rC9ggjrsPh2nTr1mD30RsTr8lhACv2hJdccE/EsYUfPvKMTye8hMu4rxCcqHGuFZAezDD8vEySJ5oLo+xBvxaUSNjXhKYHRNEOB6Gf+jQ/+r701y8zVdujckaMhi9TWLNbyFHQI4Vt+71Vrosdm7bb7E6chXE3feB4Am+25Pk1kVSK0AbCwPN8zPOngAAANiy8dJ/dejpfgtbHHT0/0gAArZHCkK04J/28GrvoCeVAAA8a1AQAAAAAAAAAAAAAAAAyAAAAAAAAAAAAKwQAAAAAAAA/i4FAAAAAAAAAAAAAAAAAAAAAAAAAA==";
const pool = parsePool(Buffer.from(DATA, "base64"));
check("reads the real pool", pool.baseMint === "BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W" && pool.quoteMint === "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS" && pool.lpMint === LP_MINT
  && pool.lpSupply === "682064344013" && pool.coinCreator === TREASURY && pool.quoteAccount === "DNzwnsYpT3hFTVALyzDGtsZqVdqBQ2bQ9btxVCRMw2Qz", JSON.stringify(pool));
const ok = { owner: PUMP_AMM, pool, lp: { supply: "0", mintAuthority: POOL, freezeAuthority: null }, baseUi: 518180, quoteUi: 141.34, lockedZec: 105.55 };
let r = judgeLiquidity(ok);
check("today: every LP token burned, nothing to say", !r.alerts.length && r.summary.burned && r.summary.lpShares === 682.064344013 && r.summary.creatorFeeToTreasury, JSON.stringify(r));
r = judgeLiquidity({ ...ok, lp: { ...ok.lp, supply: "5000000000" } });
check("LP tokens that exist: alert, with the amount", r.alerts.some((a) => /docs say .* burned .* but 5 LP tokens exist: whoever holds them can withdraw/.test(a)), JSON.stringify(r.alerts));
r = judgeLiquidity({ ...ok, lp: { ...ok.lp, mintAuthority: "X" } });
check("someone else can create LP tokens: alert", r.alerts.some((a) => /can now be created by X/.test(a)));
r = judgeLiquidity({ ...ok, lp: { ...ok.lp, freezeAuthority: "F" } });
check("a freeze authority: alert", r.alerts.some((a) => /freeze authority \(F\)/.test(a)));
r = judgeLiquidity({ ...ok, owner: "Other" });
check("not a PumpSwap pool any more: alert", r.alerts.some((a) => /no longer a PumpSwap pool/.test(a)));
r = judgeLiquidity({ ...ok, pool: { ...pool, lpMint: "NEW" } });
check("a different LP token: alert", r.alerts.some((a) => /LP token changed/.test(a)));
r = judgeLiquidity({ ...ok, pool: { ...pool, coinCreator: "W" } }, { pool });
check("creator fee redirected: news, not an alert", !r.alerts.length && r.events.some((e) => /now goes to W \(it went to FauK/.test(e)) && r.summary.creatorFeeToTreasury === false);
console.log(failures ? `\n${failures} failed` : "\nall liquidity tests passed");
process.exitCode = failures ? 1 : 0;
