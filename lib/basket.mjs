// Holder rewards paid as a basket of tokens.
//
// Some Sapling coins pay holder rewards in several tokens: the pot is split
// into equal legs, one paid in ZEC and the rest swapped into other tokens
// (e.g. $SAPLING, CYPH, hSOL) and sent to the same holders. Sapling's payout
// rows list only the ZEC leg, so each share looks like 1/N of what the
// published formula gives. This file reads the other legs from the chain and
// judges whether every holder got every token in proportion to their share.
//
// The swaps go through one-time wallets the payout keeper opens: the rewards
// wallet sends each one ZEC, it buys a token, and sends the token (and any
// leftover ZEC) back; the rewards wallet then pays it out to the holders.

export const REWARDS_WALLET = "37BBnMe6rTeH3Cxs1meobB6C564GJ7Gxj7SinQfgHPrL";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
const TREASURY = "FauKh2enCxjqMDaEEmo3qMmA9toxyZPFvPhGEZNMzChr";

// Names for tokens seen in baskets so far (anything else shows as a short mint)
export const TOKEN_NAMES = {
  [ZEC_MINT]: "ZEC",
  BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W: "$SAPLING",
  CYPHuMmCL1GxJWa2tsPhLKykC7GrHJTCHwbXD4g5uawK: "CYPH",
  he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A: "hSOL",
  // seen in baskets 3-4 Nov 2026, names from Solscan
  "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG": "NEAR",
  WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp: "WXMR",
  BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T: "BOT",
  BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp: "BABA",
  XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1: "CRCLx",
  Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh: "NVDAx",
  XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp: "AAPLx",
  Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x: "BRK.Bx",
};
// The most an opened token account may cost a holder (0.001 ZEC). Seen: about
// 11,300 zat, close to the rent Sapling takes for a ZEC account.
export const MAX_ACCOUNT_COST_ZAT = 100_000n;
export const DEFAULT_ACCOUNT_COST_ZAT = 12_000n;

/** Least-squares fit of got = rate*s - cost*o over [{ s, g, o }]. */
/**
 * Is a fitted per-account deduction a believable account cost? Each one must be
 * worth at most MAX_ACCOUNT_COST_ZAT, and all of them together at most half of
 * what the leg bought when 3 or more holders test the fit (a tenth with fewer).
 * (Until 9 Nov it was always a tenth, which a tiny run trips: run 1727 paid
 * 6 holders about $8, and opening 4 or 5 accounts was 10–13% of a leg.)
 */
export function accountCostPlausible({ cost, opened, bought, costZat, holders = Infinity }) {
  // with 2 holders any rate and cost fit exactly, so the fit proves nothing: keep the old tenth
  const share = holders >= 3 ? 2 : 10;
  return costZat <= Number(MAX_ACCOUNT_COST_ZAT) && cost * opened * share <= bought;
}
export function fitRateAndCost(pts) {
  let ss = 0, so = 0, oo = 0, sg = 0, og = 0;
  for (const p of pts) { ss += p.s * p.s; so += p.s * p.o; oo += p.o * p.o; sg += p.s * p.g; og += p.o * p.g; }
  if (!oo || ss * oo - so * so === 0) return { rate: ss ? sg / ss : 0, cost: 0 };
  // [ss, -so; -so, oo] [rate; cost] = [sg; -og]
  const det = ss * oo - so * so;
  return { rate: (sg * oo - so * og) / det, cost: (sg * so - ss * og) / det };
}
export const tokenName = (mint) => TOKEN_NAMES[mint] ?? `${mint.slice(0, 4)}…`;

/** Net change per "owner|mint" in one transaction (jsonParsed meta). */
export function netMoves(meta) {
  const net = new Map();
  const key = (b) => `${b.owner}|${b.mint}`;
  for (const b of meta?.preTokenBalances ?? []) net.set(key(b), (net.get(key(b)) ?? 0n) - BigInt(b.uiTokenAmount.amount));
  for (const b of meta?.postTokenBalances ?? []) net.set(key(b), (net.get(key(b)) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  return net;
}
const get = (net, owner, mint) => net.get(`${owner}|${mint}`) ?? 0n;
const ataOf = (tx, owner, mint) => {
  const b = (tx?.meta?.postTokenBalances ?? []).find((x) => x.owner === owner && x.mint === mint);
  if (!b) return null;
  const k = tx.transaction.message.accountKeys[b.accountIndex];
  return k?.pubkey ?? k ?? null;
};

/**
 * Read a run's basket from the chain.
 * @param rpc      async (method, params) => result
 * @param zecAta   the rewards wallet's ZEC token account (from the release)
 * @param start,end unix seconds bounding the run (allow a few minutes either side)
 * @param holders  Set of owners in the run's payout rows
 */
export async function readBasket(rpc, { zecAta, start, end, holders, otherZat = null, maxPages = 10 }) {
  const getTx = (sig) => rpc("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 }]);
  async function sigsInWindow(address) {
    const out = [];
    let before;
    for (let page = 0; page < maxPages; page++) {
      const a = (await rpc("getSignaturesForAddress", [address, { limit: 1000, ...(before ? { before } : {}) }])) ?? [];
      out.push(...a.filter((x) => !x.err && x.blockTime >= start && x.blockTime <= end));
      if (a.length < 1000 || a.at(-1).blockTime < start) return out;
      before = a.at(-1).signature;
    }
    throw new Error(`more than ${maxPages} pages of history before the run`);
  }

  // 1. ZEC the rewards wallet sent to wallets that aren't holders: the swap wallets
  const zecOut = new Map();
  for (const x of await sigsInWindow(zecAta)) {
    const net = netMoves((await getTx(x.signature))?.meta);
    if (get(net, REWARDS_WALLET, ZEC_MINT) >= 0n) continue;
    for (const [k, v] of net) {
      const [owner, mint] = k.split("|");
      if (mint !== ZEC_MINT || v <= 0n || owner === REWARDS_WALLET || owner === TREASURY || holders.has(owner)) continue;
      zecOut.set(owner, (zecOut.get(owner) ?? 0n) + v);
    }
  }

  // 2. what each swap wallet sent back to the rewards wallet
  const legs = new Map();   // mint -> { bought, from: [wallets], ata }
  const zecBackBy = new Map();
  // biggest first: a swap leg is a sizeable slice of the pot; other coins' holders paid at the same moment drop out below
  // the swaps share what Sapling paid beyond the ZEC shares (equally or not: PI 1487 was 50% ZEC, 25% CYPH, 25% NEAR);
  // a swap bigger than all of it, or a sliver of it, belongs to something else
  const sized = otherZat ? [...zecOut].filter(([, v]) => v * 100n <= otherZat * 105n && v * 50n >= otherZat) : [...zecOut];
  const candidates = sized.sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0)).slice(0, 40).map(([w]) => w);
  for (const w of candidates) {
    const sigs = ((await rpc("getSignaturesForAddress", [w, { limit: 50 }])) ?? [])
      .filter((s) => !s.err && s.blockTime >= start && s.blockTime <= end);
    for (const x of sigs) {
      const tx = await getTx(x.signature);
      const net = netMoves(tx?.meta);
      for (const [k, v] of net) {
        const [owner, mint] = k.split("|");
        if (owner !== REWARDS_WALLET || v <= 0n || get(net, w, mint) >= 0n) continue;
        if (mint === ZEC_MINT) { zecBackBy.set(w, (zecBackBy.get(w) ?? 0n) + v); continue; }
        const leg = legs.get(mint) ?? { bought: 0n, from: [], ata: ataOf(tx, REWARDS_WALLET, mint) };
        leg.bought += v; leg.from.push(w);
        legs.set(mint, leg);
      }
    }
  }

  // 3. what the rewards wallet paid out of each leg, and to whom
  for (const [mint, leg] of legs) {
    leg.sent = new Map();
    leg.opened = new Set();   // holders whose token account was opened in the payout
    if (!leg.ata) continue;
    for (const x of await sigsInWindow(leg.ata)) {
      const meta = (await getTx(x.signature))?.meta;
      const net = netMoves(meta);
      if (get(net, REWARDS_WALLET, mint) >= 0n) continue;
      const had = new Set((meta?.preTokenBalances ?? []).filter((b) => b.mint === mint).map((b) => b.owner));
      // a payout of this token to anyone outside this run's holders belongs to another run
      const to = [...net].filter(([k, v]) => k.endsWith(`|${mint}`) && v > 0n && !k.startsWith(`${REWARDS_WALLET}|`)).map(([k]) => k.split("|")[0]);
      if (to.some((o) => !holders.has(o))) { leg.otherRunTxs = (leg.otherRunTxs ?? 0) + 1; continue; }
      for (const [k, v] of net) {
        const [owner, m] = k.split("|");
        if (m !== mint || v <= 0n || owner === REWARDS_WALLET) continue;
        leg.sent.set(owner, (leg.sent.get(owner) ?? 0n) + v);
        if (!had.has(owner)) leg.opened.add(owner);
      }
    }
  }
  // a swap wallet is one that sent a token back (the vault that takes the
  // rolled-over ZEC also sends ZEC to the rewards wallet, in the release)
  const swapWallets = [...new Set([...legs.values()].flatMap((l) => l.from))];
  const zecToSwaps = swapWallets.reduce((a, w) => a + zecOut.get(w), 0n);
  const zecBack = swapWallets.reduce((a, w) => a + (zecBackBy.get(w) ?? 0n), 0n);
  // the ZEC spent on each leg, to value its tokens
  for (const leg of legs.values()) leg.zecIn = [...new Set(leg.from)].reduce((a, w) => a + zecOut.get(w) - (zecBackBy.get(w) ?? 0n), 0n);
  return { swapWallets, zecToSwaps, zecBack, legs: [...legs].map(([mint, l]) => ({ mint, ...l })) };
}

/**
 * Does the basket explain the run? Pure.
 * @param rows   [{ owner, balance, share }] confirmed payout rows (ZEC leg)
 * @param pot,sum the run's pot and the snapshot's sum of balances (BigInt)
 * @param paid   the run's published paid (BigInt)
 * @param basket readBasket's result
 */
export function judgeBasket({ rows, pot, sum, paid }, basket) {
  const problems = [];
  const legs = basket.legs;
  const paidRows = rows.filter((r) => BigInt(r.share) > 0n);
  const tokens = ["ZEC", ...legs.map((l) => tokenName(l.mint))];
  // can't find or tell apart this run's swaps: not checked, not a finding
  if (!legs.length) return { ok: false, inconclusive: true, tokens, problems: ["no other tokens paid out during the run"] };
  const shareSum = paidRows.reduce((a, r) => a + BigInt(r.share), 0n);
  const zecUsed = shareSum + basket.zecToSwaps - basket.zecBack;
  const zecGap = zecUsed > paid ? zecUsed - paid : paid - zecUsed;
  if (zecGap * 50n > paid)
    return { ok: false, inconclusive: true, tokens,
      problems: [`ZEC to holders and the swaps found (${zecUsed}) is more than 2% from the published paid (${paid}): not every swap was found, or another run's was`] };

  // every ZEC share is the same fraction of its formula share (half, a quarter... not always equal legs)
  const ratios = paidRows.map((r) => Number((pot * BigInt(r.balance)) / sum) / Number(r.share)).sort((x, y) => x - y);
  const m = ratios[Math.floor(ratios.length / 2)];
  const off = paidRows.filter((r) => {
    const formula = Number((pot * BigInt(r.balance)) / sum), diff = Math.abs(formula - m * Number(r.share));
    return diff > m + 1 && diff > formula * 0.005;   // more than 0.5% and more than rounding
  });
  if (off.length) problems.push(`${off.length} ZEC shares aren't the same fraction (1/${m.toFixed(2)}) of the formula share as the rest`);

  // every other token: all of it to the same holders, in proportion to their share
  const owners = new Set(paidRows.map((r) => r.owner));
  const accounts = [];   // token accounts opened for holders, paid for from their share
  const skipped = [];    // holders whose leg was worth less than an account
  for (const leg of legs) {
    const name = tokenName(leg.mint);
    const sentSum = [...leg.sent.values()].reduce((a, v) => a + v, 0n);
    if (sentSum > leg.bought) problems.push(`${name}: paid out more than was bought`);
    if (sentSum * 100n < leg.bought * 99n) problems.push(`${name}: ${leg.bought - sentSum} of ${leg.bought} bought wasn't paid out`);
    const strangers = [...leg.sent.keys()].filter((o) => !owners.has(o));
    if (strangers.length) problems.push(`${name}: sent to ${strangers.length} wallets not in the payout rows`);
    if (!leg.sent.size) problems.push(`${name}: no payout of it to this run's holders found`);
    // Holders are paid at one rate per unit of ZEC share; a holder whose token
    // account had to be opened gets that, less one flat cost of the account
    // (like the ZEC leg's rent). Fit got = rate*share - cost*opened by least
    // squares, then every holder must sit on that line.
    const got = paidRows.filter((r) => leg.sent.has(r.owner))
      .map((r) => ({ s: Number(r.share), g: Number(leg.sent.get(r.owner)), o: leg.opened?.has(r.owner) ? 1 : 0 }));
    const fit = fitRateAndCost(got);
    let skew = 0;
    for (const r of got) {
      const pred = fit.rate * r.s - fit.cost * r.o;
      if (Math.abs(r.g - pred) > Math.max(2, pred * 0.01)) skew++;
    }
    const opened = got.filter((r) => r.o).length;
    // what one account cost, in zat at the price the leg was bought at
    const costZat = leg.zecIn && leg.bought && fit.cost > 0 ? Math.round(fit.cost * Number(leg.zecIn) / Number(leg.bought)) : 0;
    if (fit.cost > 2 && !accountCostPlausible({ cost: fit.cost, opened, bought: Number(leg.bought), costZat, holders: got.length })) skew = got.length;
    if (fit.cost < -2) skew = got.length;   // holders with new accounts paid more: not an account cost
    if (skew) problems.push(`${name}: ${skew} holders not paid in proportion to their share`);
    else if (opened && fit.cost > 2) accounts.push({ token: name, holders: opened, cost: String(Math.round(fit.cost)), costZat: String(costZat) });

    // a holder whose leg is worth little more than opening an account for it can be skipped
    const skipBelow = BigInt(Math.max(2 * costZat, Number(DEFAULT_ACCOUNT_COST_ZAT) * 2));
    const shareOf = new Map(paidRows.map((r) => [r.owner, BigInt(r.share)]));
    const missed = [...owners].filter((o) => !leg.sent.has(o));
    // what this token was worth to the holder, in zat: their ZEC share scaled by the ZEC spent on this leg
    // (ZDOG splits its non-ZEC half three ways, so each token is worth a third of that)
    const legValue = (o) => (leg.zecIn && shareSum > 0n ? (shareOf.get(o) * leg.zecIn) / shareSum : shareOf.get(o));
    const tooSmall = missed.filter((o) => legValue(o) <= skipBelow);
    if (missed.length > tooSmall.length) problems.push(`${name}: ${missed.length - tooSmall.length} holders got none`);
    if (tooSmall.length) skipped.push({ token: name, holders: tooSmall.length });
  }
  return {
    ok: problems.length === 0, problems,
    tokens,
    accountsOpened: accounts, smallHoldersSkipped: skipped,
    zec: { shares: String(shareSum), toSwaps: String(basket.zecToSwaps), back: String(basket.zecBack), paid: String(paid) },
    legs: legs.map((l) => ({ token: tokenName(l.mint), mint: l.mint, bought: String(l.bought),
      paidOut: String([...l.sent.values()].reduce((a, v) => a + v, 0n)), holders: l.sent.size,
      zecSpent: l.zecIn == null ? null : String(l.zecIn), swapWallets: l.from })),
  };
}
