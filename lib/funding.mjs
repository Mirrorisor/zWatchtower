// Who funded a coin's first buyers? A creator who launches without buying,
// then buys through wallets they just funded, is "bundling". Pure functions;
// coins-check.mjs does the fetching.

export const SAME_FUNDER_MIN = 3;   // flag when at least this many early buyers share a funder

/**
 * The wallet that first sent SOL to `wallet`, from that wallet's oldest
 * transaction (jsonParsed). null when the oldest transaction isn't a plain
 * SOL transfer into it (e.g. it was created by a program).
 */
export function funderFromTx(tx, wallet) {
  const ixs = [
    ...(tx?.transaction?.message?.instructions ?? []),
    ...((tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])),
  ];
  for (const ix of ixs) {
    const p = ix.parsed;
    if (ix.program !== "system" && ix.programId !== "11111111111111111111111111111111") continue;
    if (!p || !["transfer", "transferWithSeed", "createAccount"].includes(p.type)) continue;
    const to = p.info?.destination ?? p.info?.newAccount;
    if (to === wallet && p.info?.source && p.info.source !== wallet) return p.info.source;
  }
  return null;
}

/**
 * Group a coin's early buyers by who funded them.
 * @param buyers  [wallet] that bought in the first seconds (creator excluded)
 * @param funders { wallet: funder | null } (null = not a plain SOL transfer; undefined = not looked up yet)
 * @param creator the coin's creator wallet, or null
 */
export function fundingFacts(buyers, funders, creator) {
  const known = buyers.filter((b) => funders[b] !== undefined);
  const groups = new Map();
  for (const b of known) {
    const f = funders[b];
    if (!f) continue;
    if (!groups.has(f)) groups.set(f, []);
    groups.get(f).push(b);
  }
  const byCreator = creator ? (groups.get(creator) ?? []).length : 0;
  const shared = [...groups].filter(([, list]) => list.length >= 2)
    .map(([funder, list]) => ({ funder, buyers: list.length, isCreator: funder === creator }))
    .sort((a, b) => b.buyers - a.buyers);
  return {
    earlyBuyers: buyers.length, lookedUp: known.length,
    fundedByCreator: byCreator,
    sharedFunders: shared.slice(0, 5),
    largestGroup: shared[0]?.buyers ?? 0,
  };
}

/** Flags for a card from its funding facts. */
export function fundingFlags(ff) {
  const out = [];
  if (!ff || ff.lookedUp < ff.earlyBuyers) return out;   // only judge once every early buyer is known
  if (ff.fundedByCreator >= 1)
    out.push(`${ff.fundedByCreator} of the first buyers ${ff.fundedByCreator === 1 ? "was" : "were"} funded by the creator`);
  const top = ff.sharedFunders.find((g) => !g.isCreator);
  if (top && top.buyers >= SAME_FUNDER_MIN)
    out.push(`${top.buyers} of the first buyers were funded by the same wallet`);
  return out;
}
