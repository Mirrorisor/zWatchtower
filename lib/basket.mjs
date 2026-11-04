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
};
// The most an opened token account may cost a holder (0.001 ZEC). Seen: about
// 11,300 zat, close to the rent Sapling takes for a ZEC account.
export const MAX_ACCOUNT_COST_ZAT = 100_000n;
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
export async function readBasket(rpc, { zecAta, start, end, holders, legZat = null, maxPages = 10 }) {
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
  // a swap leg is about the size of the ZEC leg (seen within 2%); other runs' swaps and payouts aren't
  const sized = legZat ? [...zecOut].filter(([, v]) => (v > legZat ? v - legZat : legZat - v) * 100n <= legZat * 15n) : [...zecOut];
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
export function judgeBasket({ rows, pot, sum, paid, expectedLegs = null }, basket) {
  const problems = [];
  const legs = basket.legs;
  const k = legs.length + 1;
  // can't tell this run's legs from another's: not checked, not a finding
  if (expectedLegs && k !== expectedLegs)
    return { ok: false, inconclusive: true, tokens: ["ZEC", ...legs.map((l) => tokenName(l.mint))],
      problems: [`shares say ${expectedLegs} legs, found ${k} on chain`] };
  const paidRows = rows.filter((r) => BigInt(r.share) > 0n);
  if (!legs.length) return { ok: false, tokens: ["ZEC"], problems: ["no other tokens paid out during the run"] };

  // the ZEC leg is the formula share split k ways (within rounding)
  const off = paidRows.filter((r) => {
    const formula = (pot * BigInt(r.balance)) / sum, kShare = BigInt(k) * BigInt(r.share);
    const diff = formula > kShare ? formula - kShare : kShare - formula;
    return diff > BigInt(k + 1) && diff * 200n > formula;   // more than 0.5% and more than rounding
  });
  if (off.length) problems.push(`${off.length} ZEC shares aren't 1/${k} of the formula share`);

  // ZEC: the shares plus what went to the swaps (less what came back) is what Sapling says it paid
  const shareSum = paidRows.reduce((a, r) => a + BigInt(r.share), 0n);
  const zecUsed = shareSum + basket.zecToSwaps - basket.zecBack;
  const zecGap = zecUsed > paid ? zecUsed - paid : paid - zecUsed;
  if (zecGap * 50n > paid) problems.push(`ZEC to holders and swaps (${zecUsed}) is more than 2% from the published paid (${paid})`);

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
    // a holder whose leg is worth less than opening an account for it can be skipped
    const shareOf = new Map(paidRows.map((r) => [r.owner, BigInt(r.share)]));
    const missed = [...owners].filter((o) => !leg.sent.has(o));
    const tooSmall = missed.filter((o) => shareOf.get(o) <= MAX_ACCOUNT_COST_ZAT);
    if (missed.length > tooSmall.length) problems.push(`${name}: ${missed.length - tooSmall.length} holders got none`);
    if (tooSmall.length) skipped.push({ token: name, holders: tooSmall.length });
    // Holders are paid at one rate per unit of ZEC share. A holder whose token
    // account had to be opened gets that rate less the same flat cost of the
    // account (as with the ZEC leg's rent); anything else is out of proportion.
    const got = paidRows.filter((r) => leg.sent.has(r.owner)).map((r) => ({ ...r, got: leg.sent.get(r.owner), opened: leg.opened?.has(r.owner) }));
    const pool = got.filter((r) => !r.opened).length ? got.filter((r) => !r.opened) : got;
    const ref = pool.reduce((a, r) => (r.got * BigInt(a.share) > a.got * BigInt(r.share) ? r : a), pool[0]);
    const deductions = [];
    let skew = 0;
    for (const r of got) {
      const want = ref ? (ref.got * BigInt(r.share)) / BigInt(ref.share) : r.got;
      const diff = want - r.got;
      const abs = diff < 0n ? -diff : diff;
      if (abs <= 2n || abs * 100n <= want) continue;
      if (r.opened && diff > 0n) deductions.push(diff); else skew++;
    }
    if (deductions.length) {
      const lo = deductions.reduce((a, d) => (d < a ? d : a)), hi = deductions.reduce((a, d) => (d > a ? d : a));
      const total = deductions.reduce((a, d) => a + d, 0n);
      // what one account cost, in zat at the price the leg was bought at
      const costZat = leg.zecIn && leg.bought ? (hi * leg.zecIn) / leg.bought : null;
      const flat = (hi - lo) * 50n <= hi || hi - lo <= 2n;
      const small = costZat !== null && costZat <= MAX_ACCOUNT_COST_ZAT && total * 10n <= leg.bought;
      if (!flat || !small) skew += deductions.length;
      else accounts.push({ token: name, holders: deductions.length, cost: String(hi), costZat: String(costZat) });
    }
    if (skew) problems.push(`${name}: ${skew} holders not paid in proportion to their share`);
  }
  return {
    ok: problems.length === 0, problems,
    tokens: ["ZEC", ...legs.map((l) => tokenName(l.mint))],
    accountsOpened: accounts, smallHoldersSkipped: skipped,
    zec: { shares: String(shareSum), toSwaps: String(basket.zecToSwaps), back: String(basket.zecBack), paid: String(paid) },
    legs: legs.map((l) => ({ token: tokenName(l.mint), mint: l.mint, bought: String(l.bought),
      paidOut: String([...l.sent.values()].reduce((a, v) => a + v, 0n)), holders: l.sent.size,
      zecSpent: l.zecIn == null ? null : String(l.zecIn), swapWallets: l.from })),
  };
}
