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
r = compareQuotes({ C1: { ...base.C1, referenceRaw: "2170000000" } }, { C1: { ...base.C1, hash: "zz", referenceRaw: "2300000000" } });
check("a new reference number is spelled out", r.events.some((e) => /looks like a reference price \(\$217\.00 → \$230\.00\)/.test(e)), JSON.stringify(r.events));
r = compareQuotes(base, { C1: { ...base.C1, paused: true } });
check("paused by its issuer is news", r.events.some((e) => /\$TSLAx has been paused by its issuer/.test(e)) && !r.alerts.length);
r = compareQuotes(base, { C1: { ...base.C1, permanentDelegate: "NEW" } });
check("a new permanent delegate is news", r.events.some((e) => /move tokens out of any account changed from 5aMN.* to NEW/.test(e)));
const split = tokenControls({ ...tsla, extensions: tsla.extensions.map((e) => e.extension === "scaledUiAmountConfig" ? { ...e, state: { ...e.state, newMultiplier: "3", newMultiplierEffectiveTimestamp: 1794700800 } } : e) });
r = compareQuotes(base, { C1: { ...base.C1, ...split } });
check("a scheduled split is news", r.events.some((e) => /scheduled balances to be shown ×3 from 2026-11-15/.test(e)), JSON.stringify(r.events));
const s = quotesSummary({ ...base, C2: { mint: "M2", ...split, symbol: "X", paused: true } });
check("summary", s.tokens === 2 && s.paused.length === 1 && s.withPermanentDelegate === 2 && s.scheduledMultiplier.length === 1, JSON.stringify(s));
console.log(failures ? `\n${failures} failed` : "\nall quotes tests passed");
process.exitCode = failures ? 1 : 0;
