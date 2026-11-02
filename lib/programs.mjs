// Sapling's Solana programs: find them in the transactions of Sapling's own
// wallets, and tell which ones Sapling can upgrade. Pure functions, so they
// run offline in tests; programs-check.mjs does the fetching.

export const LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
export const JUPITER = "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4";

// Everyday programs that are nobody's in particular: never candidates.
export const COMMON = new Set([
  "11111111111111111111111111111111",            // system
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",  // token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",  // token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token accounts
  "ComputeBudget111111111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
  "AddressLookupTab1e1111111111111111111111111",
  "Vote111111111111111111111111111111111111111",
  "Stake11111111111111111111111111111111111111",
  "Ed25519SigVerify111111111111111111111111111",
  "KeccakSecp256k11111111111111111111111111111",
  "Secp256r1SigVerify1111111111111111111111111",
  "BPFLoader2111111111111111111111111111111111",
  LOADER_UPGRADEABLE,
]);

const instructionsOf = (tx) => [
  ...(tx?.transaction?.message?.instructions ?? []),
  ...((tx?.meta?.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])),
];

/**
 * The programs a transaction (jsonParsed) ran, and any program it upgraded or
 * deployed through the upgradeable loader (a multisig upgrade runs the loader,
 * not the program, so the program only shows up as the loader's argument).
 */
export function programsInTx(tx) {
  const invoked = new Set(), touched = new Set();
  for (const ix of instructionsOf(tx)) {
    if (!ix.programId) continue;
    invoked.add(ix.programId);
    if (ix.programId === LOADER_UPGRADEABLE) {
      const info = ix.parsed?.info ?? {};
      for (const k of ["programAccount", "program", "programId"]) if (typeof info[k] === "string") touched.add(info[k]);
    }
  }
  return { invoked, touched };
}

/**
 * Compare this run's programs with the last run's.
 * @param prev  { [id]: { authority, slot, sapling } } from the last run (empty on the first)
 * @param now   { [id]: { authority, slot, sapling } } read this run
 * @param baseline true on the first run: nothing is "new" yet
 */
export function programAlerts(prev, now, baseline) {
  const alerts = [];
  for (const [id, p] of Object.entries(now)) {
    const was = prev[id];
    if (!was) {
      if (p.sapling && !baseline) alerts.push(`new program controlled by Sapling: ${id} (upgrade authority ${p.authority})`);
      continue;
    }
    if (!(was.sapling || p.sapling)) continue; // only Sapling's own programs are watched
    if (was.authority !== p.authority)
      alerts.push(`program ${id} upgrade authority is ${p.authority ?? "none (made immutable)"} (was ${was.authority ?? "none"})`);
    if (was.slot != null && p.slot != null && p.slot !== was.slot)
      alerts.push(`program ${id} upgraded: last deploy slot ${was.slot} -> ${p.slot}`);
  }
  return alerts;
}

// ---- the Terminal guard's token rules ------------------------------------
// Sapling's docs: "The guard refuses tokens whose mint lets someone take,
// freeze, pause or block them, or that charge more than 5% per transfer."
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_MINTS = new Set([ZEC_MINT, WSOL_MINT]);

/**
 * The tokens a Terminal trade bought or sold, from the transaction's token
 * balances. A trade's holding only receives the bought token (or only sends
 * the sold one); pools and routes both send and receive, and the ZEC side is
 * the payment, so neither counts.
 */
export function tokensHandled(tx) {
  const amt = (b) => BigInt(b.uiTokenAmount?.amount ?? "0");
  const net = new Map();
  for (const b of tx?.meta?.preTokenBalances ?? []) if (b.owner) net.set(`${b.owner}|${b.mint}`, (net.get(`${b.owner}|${b.mint}`) ?? 0n) - amt(b));
  for (const b of tx?.meta?.postTokenBalances ?? []) if (b.owner) net.set(`${b.owner}|${b.mint}`, (net.get(`${b.owner}|${b.mint}`) ?? 0n) + amt(b));
  const byOwner = new Map();
  for (const [k, v] of net) {
    if (v === 0n) continue;
    const [owner, mint] = k.split("|");
    const o = byOwner.get(owner) ?? { up: new Set(), down: new Set() };
    (v > 0n ? o.up : o.down).add(mint);
    byOwner.set(owner, o);
  }
  const bought = new Set(), sold = new Set();
  for (const o of byOwner.values()) {
    if (o.up.size && !o.down.size) for (const m of o.up) if (!QUOTE_MINTS.has(m)) bought.add(m);
    if (o.down.size && !o.up.size) for (const m of o.down) if (!QUOTE_MINTS.has(m)) sold.add(m);
  }
  return { bought, sold };
}

/** Which of the guard's stated rules a mint (jsonParsed mint info) breaks. */
export function mintRuleBreaks(info) {
  const out = [];
  if (info.freezeAuthority) out.push("can be frozen (freeze authority set)");
  for (const e of info.extensions ?? []) {
    const st = e.state ?? {};
    switch (e.extension) {
      case "permanentDelegate": if (st.delegate) out.push("can be taken (permanent delegate)"); break;
      case "pausableConfig": case "pausable": if (st.authority) out.push("can be paused"); break;
      case "defaultAccountState": if (/frozen/i.test(String(st.accountState ?? ""))) out.push("new holders start frozen"); break;
      case "nonTransferable": out.push("can't be transferred"); break;
      case "transferHook": if (st.programId) out.push("transfers run another program, which can block them (transfer hook)"); break;
      case "transferFeeConfig": {
        const bps = Math.max(st.newerTransferFee?.transferFeeBasisPoints ?? 0, st.olderTransferFee?.transferFeeBasisPoints ?? 0);
        if (bps > 500) out.push(`charges ${bps / 100}% per transfer`);
        break;
      }
    }
  }
  return out;
}
