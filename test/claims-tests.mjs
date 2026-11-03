// Sapling's headline burn claim against the chain.
import { claimedBurn, compareBurn } from "../lib/claims.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };

check("reads '$SAPLING burned 222.15M' from the page", claimedBurn(`<div><span>$SAPLING burned</span><b>222.15M</b></div>`) === 222.15e6);
check("reads '212.23M $SAPLING burned'", claimedBurn(`<p>212.23M <i>$SAPLING</i> burned</p>`) === 212.23e6);
check("reads a plain number with commas", claimedBurn(`$SAPLING burned: 212,230,000`) === 212230000);
check("ignores scripts", claimedBurn(`<script>var x="$SAPLING burned 999M"</script><p>nothing here</p>`) === null);
let c = compareBurn(222.15e6, 1e9 - 222_151_234);
check("a rounded claim matches the chain", c.verdict === "matches" && c.onChain === 222_151_234, JSON.stringify(c));
c = compareBurn(250e6, 1e9 - 222e6);
check("a claim 12% over the chain differs", c.verdict === "differs" && c.diffPct > 12, JSON.stringify(c));
check("no claim on the page is said plainly", compareBurn(null, 8e8).verdict === "claim not found on Sapling's page");
process.exitCode = failures ? 1 : 0;
