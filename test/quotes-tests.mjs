// Pairing tokens: Sapling's list, and the controls each token's issuer holds.
import { tokenControls, compareQuotes, quotesSummary } from "../lib/quotes.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
// the real TSLAx mint, read 2026-11-08
const tsla = { decimals: 8, freezeAuthority: "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs", mintAuthority: "7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj", extensions: [
  { extension: "permanentDelegate", state: { delegate: "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq" } },
  { extension: "defaultAccountState", state: { accountState: "initialized" } },
  { extension: "scaledUiAmountConfig", state: { authority: "S7vY", multiplier: "1", newMultiplier: "1", newMultiplierEffectiveTimestamp: 0 } },
  { extension: "pausableConfig", state: { authority: "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs", paused: false } },
  { extension: "transferHook", state: { authority: "5aMN", programId: null } },
  { extension: "tokenMetadata", state: { name: "Tesla xStock", symbol: "TSLAx" } }] };
const t = tokenControls(tsla);
check("reads an xStock's issuer controls", t.symbol === "TSLAx" && t.paused === false && t.permanentDelegate === "5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq" && t.freezeAuthority === "JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs" && t.defaultFrozen === false && t.transferHook === null && t.nextMultiplier === null, JSON.stringify(t));
check("a plain token has no controls", JSON.stringify(tokenControls({ mintAuthority: null, freezeAuthority: null })) === JSON.stringify({ symbol: null, name: null, mintAuthority: null, freezeAuthority: null, permanentDelegate: null, paused: null, pauseAuthority: null, defaultFrozen: null, transferHook: null, multiplier: null, nextMultiplier: null }));
const base = { C1: { mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", hash: "aa", ...t } };
check("first run: recorded, nothing said", compareQuotes(null, base).events.length === 0);
check("nothing changed: nothing said", compareQuotes(base, structuredClone(base)).events.length === 0);
let r = compareQuotes(base, { ...base, C2: { mint: "M2", hash: "bb", ...tokenControls({ extensions: [{ extension: "tokenMetadata", state: { symbol: "NVDAx", name: "NVIDIA xStock" } }] }) } });
check("a token added is news", r.events.some((e) => /added \$NVDAx \(NVIDIA xStock\)/.test(e)), JSON.stringify(r.events));
r = compareQuotes(base, {});
check("a token removed is news", r.events.some((e) => /removed \$TSLAx/.test(e)));
r = compareQuotes(base, { C1: { ...base.C1, hash: "zz" } });
check("its settings changed is news", r.events.some((e) => /changed the pairing settings for \$TSLAx\./.test(e)));

r = compareQuotes(base, { C1: { ...base.C1, paused: true } });
check("paused by its issuer is news", r.events.some((e) => /\$TSLAx has been paused by its issuer/.test(e)) && !r.alerts.length);
r = compareQuotes(base, { C1: { ...base.C1, permanentDelegate: "NEW" } });
check("a new permanent delegate is news", r.events.some((e) => /move tokens out of any account changed from 5aMN.* to NEW/.test(e)));
const split = tokenControls({ ...tsla, extensions: tsla.extensions.map((e) => e.extension === "scaledUiAmountConfig" ? { ...e, state: { ...e.state, newMultiplier: "3", newMultiplierEffectiveTimestamp: 1794700800 } } : e) });
r = compareQuotes(base, { C1: { ...base.C1, ...split } });
check("a scheduled split is news", r.events.some((e) => /scheduled balances to be shown ×3 from 2026-11-15/.test(e)), JSON.stringify(r.events));
const s = quotesSummary({ ...base, C2: { mint: "M2", ...split, symbol: "X", paused: true } });
check("summary", s.tokens === 2 && s.paused.length === 1 && s.withPermanentDelegate === 2 && s.scheduledMultiplier.length === 1, JSON.stringify(s));
// the real NVDAx conversion of 2026-10-28 (4NAXcV…): 0.5112449 NVDAx → 111.48164 USDC → 0.0857895 ZEC
import { parseConversion, judgeConversion, conversionFindings } from "../lib/quotes.mjs";
import { encode as b58e } from "../lib/base58.mjs";
const NV = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh", USDCm = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", ZECm = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const bal = (i, mint, ui, dec) => ({ accountIndex: i, mint, uiTokenAmount: { uiAmount: ui, decimals: dec } });
const tx = { blockTime: 1793149604, transaction: { signatures: ["4NAXcV"] }, meta: { err: null,
  logMessages: ["Program A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF invoke [1]", "Program log: Instruction: ConvertStockEnd",
    "Program data: UIh6vUnRHCd8Tf1IlvlFaW3efnTIoQWikbiVm6yGXTNp8EYSSPCMAwfopQ4UD9pXkfRWapV/064/hz5qNGb/wT15EZ36mrUKChkMAwAAAACG54IAAAAAABGYgQAAAAAA2Bh9AAAAAAA+A5/NH2LRBQEAAAAAAAAA3AUBRAs66QAAAAAAAAAAAAAAChkMAwAAAAAB"],
  preTokenBalances: [bal(1, NV, 0.5112449, 8), bal(3, USDCm, 200, 6), bal(4, USDCm, 50, 6), bal(5, ZECm, 0, 8)],
  postTokenBalances: [bal(1, NV, 0, 8), bal(3, USDCm, 88.51836, 6), bal(4, USDCm, 161.48164, 6), bal(5, ZECm, 0.0857895, 8)] } };
const cv = parseConversion(tx, b58e);
check("reads a real conversion", cv && cv.mint === NV && cv.sold === "51124490" && cv.zecOut === "8578950" && cv.minOut === "8493073" && cv.floor === "8198360" && cv.usdcLeg === 111.48164 && cv.decimals === 8 && cv.at === "2026-10-28T01:06:44.000Z", JSON.stringify(cv));
check("not a conversion: null", parseConversion({ meta: { logMessages: ["Program log: Instruction: Settle"] } }, b58e) === null);
const jv = judgeConversion(cv);
check("sold at $218.06 a token; the program's floor was 4.44% below what it got", jv.priceUsd === 218.06 && jv.floorPctBelow === 4.44 && !jv.belowFloor, JSON.stringify(jv));
let fz = conversionFindings([jv], () => "$NVDAx");
check("an ordinary conversion: nothing said", !fz.alerts.length && !fz.events.length);
fz = conversionFindings([judgeConversion({ ...cv, zecOut: "8000000" })], () => "$NVDAx");
check("got less than the program's own minimum: alert", fz.alerts.some((a) => /below the minimum its own program logged/.test(a)));

console.log(failures ? `\n${failures} failed` : "\nall quotes tests passed");
process.exitCode = failures ? 1 : 0;
