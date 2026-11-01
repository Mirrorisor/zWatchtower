// X posting: OAuth 1.0a signature against X's documented example, how
// alerts become posts, and post length.
import { signRequest, composePosts, composeSummary, fit, xLength } from "../lib/xpost.mjs";

let failures = 0;
const check = (label, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`);
};

// X's "Creating a signature" worked example (developer docs); the expected
// value is as given in the deno.land/x/oauthsignature README for the same input
const header = signRequest("POST", "https://api.twitter.com/1.1/statuses/update.json", {
  apiKey: "xvz1evFS4wEEPTGEFPHBog", apiSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
  accessToken: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", accessSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
}, { status: "Hello Ladies + Gentlemen, a signed OAuth request!", include_entities: "true" },
  "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", 1318622958);
check("OAuth signature matches X's documented example", header.includes('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"'), header);

// an upgrade run as the keys check reports it
const now = "2026-10-31T23:28:40.000Z";
const upgrade = [
  "vault program upgraded: last deploy slot 463604102 -> 463872407",
  "multisig vault_transaction_execute at 2026-10-31T23:24:37.000Z (54Toh)",
  "multisig proposal_approve at 2026-10-31T23:22:48.000Z (3cDV)",
  "multisig proposal_approve at 2026-10-31T23:22:35.000Z (35KN)",
  "multisig vault_transaction_create at 2026-10-31T23:21:22.000Z (5d4M)",
  "multisig proposal_create at 2026-10-31T23:21:22.000Z (5d4M)",
];
let posts = composePosts("keys", upgrade, [], now);
check("an upgrade becomes one post", posts.length === 1, posts.join(" | "));
check("the post says when it landed, via the multisig, and how fast it was flagged",
  /at 23:24 UTC, through its Squads multisig\. Flagged 4 minutes after it landed/.test(posts[0]), posts[0]);

posts = composePosts("keys", [
  "privileged vault instruction set_stock_quote via multisig at 2026-10-31T20:52:47.000Z (2Gau)",
  "privileged vault instruction set_stock_quote via multisig at 2026-10-31T22:54:20.000Z (5dgu)",
  "multisig batch_execute_transaction at 2026-10-31T20:52:48.000Z (41xc)",
], [], now);
check("admin actions are grouped by name", posts.length === 1 &&
  posts[0] === "Sapling's admin ran SetStockQuote on its vault program 2 times through the multisig, last at 22:54 UTC.", posts.join(" | "));

posts = composePosts("keys", ["multisig proposal_approve at 2026-10-31T20:52:14.000Z (3aBX)"], [], now);
check("routine multisig steps alone are not posted", posts.length === 0);

posts = composePosts("keys", [], ["multisig proposal_approve at 2026-10-31T20:52:14.000Z (3aBX)"], now);
check("keys events clearing are not posted", posts.length === 0);

posts = composePosts("tax", ["tax ABC (mint1): fee change scheduled: 3% -> 9% from epoch 1076 (now 1074)"], [], now);
check("a tax alert is posted", posts.length === 1 && /Coin tax check: .*3% -> 9%/.test(posts[0]), posts[0]);

posts = composePosts("flywheel", ["a", "b", "c"], ["d"], now);
check("several alerts are summarised, and clearing is posted", posts.length === 2 && /3 new problems/.test(posts[0]) && /earlier alert has cleared/.test(posts[1]), posts.join(" | "));

const long = fit("x".repeat(300));
check("posts are cut to 280", xLength(long) === 280 && long.endsWith("…"));
check("emoji count double", xLength("🌱") === 2);

const summary = composeSummary({
  keys: { status: "ran", ok: true }, rewards: { status: "ran", ok: true }, float: { status: "ran", ok: true, summary: { currentFloatZec: 0 } },
  tax: { status: "ran", ok: true, summary: { coins: 61, matching: 61 } }, flywheel: { status: "ran", ok: false, summary: { pot: { reconciled: true } } },
});
check("daily summary reads well", summary === "zWatchtower daily: 4 of 5 checks green. 61 of 61 Raydium coins charge their advertised tax. Flywheel pot reconciled to the zat. 0 ZEC waiting in payouts. Open alerts: flywheel.", summary);

process.exitCode = failures ? 1 : 0;
