// Holder rewards paid as a basket of tokens: reading the legs from a fake
// chain, and judging them. Numbers shaped like ZDOG run 1559.
import { readBasket, judgeBasket, REWARDS_WALLET as R, ZEC_MINT as ZEC } from "../lib/basket.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };

const SAP = "BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W";
const A = "HolderAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", B = "HolderBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const S = "SwapWalletSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS", V = "VaultVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const ZATA = "RewardsZecAtaZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", SATA = "RewardsSapAtaYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY";
const T = 1_793_832_211;

// a transaction from [owner, mint, pre, post] balances (pre null: account opened in it)
let n = 0;
const keys = [];
function tx(moves, ataFor = {}) {
  const pre = [], post = [];
  moves.forEach(([owner, mint, a, b]) => {
    const i = keys.length;
    keys.push(ataFor[`${owner}|${mint}`] ?? `acct${i}`);
    if (a !== null) pre.push({ accountIndex: i, owner, mint, uiTokenAmount: { amount: String(a) } });
    post.push({ accountIndex: i, owner, mint, uiTokenAmount: { amount: String(b) } });
  });
  return { sig: `sig${++n}`, tx: { blockTime: T + n, transaction: { message: { accountKeys: keys } }, meta: { preTokenBalances: pre, postTokenBalances: post } } };
}
function chain(sapA, sapB) {
  keys.length = 0; n = 0;
  const release = tx([[V, ZEC, 30_000, 0], [R, ZEC, 0, 30_000]], { [`${R}|${ZEC}`]: ZATA });
  const payZec = tx([[R, ZEC, 30_000, 15_000], [A, ZEC, 0, 5_000], [B, ZEC, 0, 10_000]], { [`${R}|${ZEC}`]: ZATA });
  const toSwap = tx([[R, ZEC, 15_000, 0], [S, ZEC, null, 15_000]], { [`${R}|${ZEC}`]: ZATA });
  const back = tx([[S, ZEC, 100, 0], [R, ZEC, 0, 100], [S, SAP, 3_000, 0], [R, SAP, null, 3_000]],
    { [`${R}|${ZEC}`]: ZATA, [`${R}|${SAP}`]: SATA });
  const paySap = tx([[R, SAP, 3_000, 3_000 - sapA - sapB], [A, SAP, 50, 50 + sapA], [B, SAP, null, sapB]], { [`${R}|${SAP}`]: SATA });
  const sigs = { [ZATA]: [release, payZec, toSwap, back], [S]: [toSwap, back], [SATA]: [back, paySap], [V]: [release] };
  const all = new Map([release, payZec, toSwap, back, paySap].map((x) => [x.sig, x.tx]));
  return async (method, [arg]) => {
    if (method === "getSignaturesForAddress") return (sigs[arg] ?? []).map((x) => ({ signature: x.sig, blockTime: x.tx.blockTime, err: null })).reverse();
    if (method === "getTransaction") return all.get(arg);
    throw new Error(method);
  };
}
const rows = [{ owner: A, balance: "1000", share: "5000" }, { owner: B, balance: "2000", share: "10000" }];
const run = { rows, pot: 30_000n, sum: 3000n, paid: 30_000n - 100n };

// B's token account is opened in the payout: it gets the same rate less a flat
// cost, which stays in the pool (A's rate rises a little); all 3,000 is paid out
let b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]) });
check("finds the swap wallet and the token it bought", b.swapWallets.join() === S && b.legs.length === 1 && b.legs[0].mint === SAP && b.legs[0].bought === 3000n, JSON.stringify(b.swapWallets));
check("the vault's release isn't mistaken for a swap", !b.swapWallets.includes(V));
check("ZEC to the swap and the dust it sent back", b.zecToSwaps === 15000n && b.zecBack === 100n);
check("notes which holder's account was opened", b.legs[0].opened.has(B) && !b.legs[0].opened.has(A));
let j = judgeBasket(run, b);
check("a basket paid in proportion passes", j.ok, JSON.stringify(j.problems));
check("names the tokens", j.tokens.join() === "ZEC,$SAPLING");
check("reports the flat cost of an opened account", j.accountsOpened[0]?.holders === 1 && j.accountsOpened[0]?.cost === "39", JSON.stringify(j.accountsOpened));

b = await readBasket(chain(1500, 1500), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]) });
j = judgeBasket(run, b);
check("a holder paid more than their share fails", !j.ok && j.problems.some((p) => /not paid in proportion/.test(p)), JSON.stringify(j.problems));

b = await readBasket(chain(1000, 1000), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]) });
j = judgeBasket(run, b);
check("a third of the token kept back fails", !j.ok && j.problems.some((p) => /wasn't paid out/.test(p)), JSON.stringify(j.problems));

j = judgeBasket({ ...run, paid: 40_000n }, { swapWallets: [], zecToSwaps: 0n, zecBack: 0n, legs: [] });
check("no other tokens: not a basket", !j.ok && /no other tokens/.test(j.problems[0]));

b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]) });
j = judgeBasket({ ...run, paid: 40_000n }, b);
check("ZEC that doesn't add up to what was paid: swaps missing or mixed, so not checked", !j.ok && j.inconclusive && j.problems.some((p) => /from the published paid/.test(p)), JSON.stringify(j.problems));

const strangerLeg = { ...b.legs[0], sent: new Map([...b.legs[0].sent, ["Stranger1111111111111111111111111111111111", 5n]]) };
j = judgeBasket(run, { ...b, legs: [strangerLeg] });
check("tokens sent to someone not in the payout rows fail", !j.ok && j.problems.some((p) => /not in the payout rows/.test(p)));

// another coin's run paying the same token at the same time doesn't count
j = judgeBasket({ ...run, paid: run.paid * 2n }, b);
check("a swap not found: inconclusive, not a finding", j.inconclusive && !j.ok, JSON.stringify(j.problems));
b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A]) });
check("a payout that also goes to a non-holder is left to its own run", b.legs[0].otherRunTxs === 1 && b.legs[0].sent.size === 0, JSON.stringify(b.legs[0].otherRunTxs));
b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]), otherZat: 1_000_000n });
check("a sliver of what went to swaps isn't taken for one", b.legs.length === 0);
b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]), otherZat: 5_000n });
check("nor a swap bigger than all of it", b.legs.length === 0);
b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]), otherZat: 30_000n });
check("a swap that's half of it is (legs needn't be equal)", b.legs.length === 1);
// a holder whose leg is worth less than an account can be skipped
b = await readBasket(chain(1013, 1987), { zecAta: ZATA, start: T - 60, end: T + 600, holders: new Set([A, B]) });
const C = "HolderCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
j = judgeBasket({ ...run, paid: run.paid + 5000n, rows: [...rows, { owner: C, balance: "1", share: "5000" }] }, b);
check("a tiny holder with no tokens is noted, not flagged", !j.problems.some((p) => /got none/.test(p)) && j.smallHoldersSkipped[0]?.holders === 1, JSON.stringify(j.problems));
j = judgeBasket({ ...run, paid: run.paid + 500000n, rows: [...rows, { owner: C, balance: "1", share: "500000" }] }, b);
check("a real holder with no tokens is flagged", j.problems.some((p) => /1 holders got none/.test(p)), JSON.stringify(j.problems));

// Real run 1491 legs (Solscan, 3 Nov 2026): BOT, every holder's account opened and charged the same cost
const R1491 = { "29zkao": [47617, 18784], "4kP7hg": [66091, 28654], "8VSeYP": [48007, 18993], "AMwLPC": [57803, 24226], "Amxbqj": [286521, 146432],
  "BTLtTy": [64372, 27735], "DiBiwF": [345167, 177767], "ELj5Rd": [285194, 145723], "ERjMjn": [124575, 59900], "F3LbGi": [89529, 41179], "GmfCfT": [199683, 100033] };
const rows1491 = Object.entries(R1491).map(([o, [sh]]) => ({ owner: o, balance: String(sh * 10), share: String(sh) }));
const shareSum1491 = rows1491.reduce((a, r) => a + BigInt(r.share), 0n);
const botLeg = { mint: "BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T", bought: 789426n, from: ["w"], zecIn: shareSum1491,
  sent: new Map(Object.entries(R1491).map(([o, [, g]]) => [o, BigInt(g)])), opened: new Set(Object.keys(R1491)) };
const run1491 = { rows: rows1491, pot: shareSum1491 * 2n, sum: shareSum1491 * 10n, paid: shareSum1491 * 2n };
j = judgeBasket(run1491, { swapWallets: ["w"], zecToSwaps: shareSum1491, zecBack: 0n, legs: [botLeg] });
check("every holder charged one account cost (no uncharged holder to compare with) passes", j.ok, JSON.stringify(j.problems));
// hSOL: one holder (64,372 zat share, ~$0.80 leg) got nothing; its share stayed in the rewards wallet
const hsolSent = { "29zkao": 3741388, "4kP7hg": 5676072, "8VSeYP": 3782233, "AMwLPC": 6053311, "Amxbqj": 30007137, "DiBiwF": 34903701,
  "ELj5Rd": 28622706, "ERjMjn": 11800495, "F3LbGi": 8130952, "GmfCfT": 20912456 };
const hsolLeg = { mint: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A", bought: 160371735n, from: ["w"], zecIn: shareSum1491,
  sent: new Map(Object.entries(hsolSent).map(([o, g]) => [o, BigInt(g)])), opened: new Set(["29zkao", "4kP7hg", "8VSeYP", "ELj5Rd", "ERjMjn", "F3LbGi", "DiBiwF"]) };
j = judgeBasket(run1491, { swapWallets: ["w"], zecToSwaps: shareSum1491, zecBack: 0n, legs: [hsolLeg] });
check("a holder left out of a leg worth far more than an account is flagged, with what wasn't paid",
  j.problems.some((p) => /hSOL: 1 holders got none/.test(p)) && j.problems.some((p) => /hSOL: 6741284 of 160371735 bought wasn't paid out/.test(p)) &&
  !j.problems.some((p) => /proportion/.test(p)), JSON.stringify(j.problems));
process.exitCode = failures ? 1 : 0;
