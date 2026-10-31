// Pure checks for Sapling's flywheel (buy back and burn the top 10 coins).
// Inputs are getTransaction results (encoding jsonParsed) and the claims from
// https://sapling.cash/api/flywheel/live. No network here, so tests run offline.

export const VAULT = "A9zFnNZpVjBbcE1SAPY92Z6H7WhicysLNPYPpDz15UxF";
export const ZEC_MINT = "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS"; // ZEC on Solana, 8 decimals
export const GROVE_OWNER = "Df8mXWxgUmCTahLCVk15MBN7JU4tcjN7CEZLDrKJ2PYa"; // vault PDA holding the pot
export const GROVE_ACCOUNT = "Eqg9vQ1tFeJ2viwTNaexrcEgUcZ7DSd6agoU5yvn5kkF"; // the pot's ZEC account

// Programs a buyback transaction may call at the top level.
export const BUYBACK_PROGRAMS = {
  ComputeBudget111111111111111111111111111111: "compute budget",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "associated token account",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "token-2022",
  [VAULT]: "sapling vault",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium cpmm",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "raydium launchlab",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pump amm",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump bonding curve",
};

/** Vault instruction names called at the top level, in order. */
export function vaultInstructions(tx, vault = VAULT) {
  const L = tx.meta?.logMessages ?? [];
  const out = [];
  for (let i = 0; i < L.length - 1; i++) {
    if (L[i] === `Program ${vault} invoke [1]` && L[i + 1].startsWith("Program log: Instruction: ")) {
      out.push(L[i + 1].slice("Program log: Instruction: ".length));
    }
  }
  return out;
}

/** Net change in token amount per owner for one mint. */
export function ownerDeltas(tx, mint) {
  const d = new Map();
  const add = (list, sign) => {
    for (const b of list ?? []) {
      if (b.mint !== mint) continue;
      d.set(b.owner, (d.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
    }
  };
  add(tx.meta?.preTokenBalances, -1n);
  add(tx.meta?.postTokenBalances, 1n);
  return d;
}

/** Net change of one token account (by address) in a transaction. */
export function accountDelta(tx, address) {
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(address);
  if (i < 0) return 0n;
  const amt = (list) => {
    const b = (list ?? []).find((x) => x.accountIndex === i);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  return amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
}

const signersOf = (tx) => tx.transaction.message.accountKeys
  .filter((k) => typeof k !== "string" && k.signer).map((k) => k.pubkey);

/**
 * Check one advertised burn against its transaction.
 * claim: { signature, mint, zat, burned }
 * Returns { signature, mint, venue, signers, problems: [] }.
 */
export function checkBurn(tx, claim, opts = {}) {
  const vault = opts.vault ?? VAULT, zecMint = opts.zecMint ?? ZEC_MINT, grove = opts.groveOwner ?? GROVE_OWNER;
  const problems = [];
  const out = { signature: claim.signature, mint: claim.mint, zat: String(claim.zat), burned: String(claim.burned), problems };
  if (!tx) { problems.push("transaction not found on chain"); return out; }
  if (tx.meta?.err) problems.push(`transaction failed on chain: ${JSON.stringify(tx.meta.err)}`);

  out.signers = signersOf(tx);
  const top = tx.transaction.message.instructions;
  const programs = [...new Set(top.map((i) => i.programId))];
  const unknown = programs.filter((p) => !BUYBACK_PROGRAMS[p]);
  if (unknown.length) problems.push(`unexpected program in buyback: ${unknown.join(", ")}`);
  out.venue = programs.map((p) => BUYBACK_PROGRAMS[p]).find((n) => /raydium|pump/.test(n ?? "")) ?? "unknown";

  const names = vaultInstructions(tx, vault);
  if (names[0] !== "DrawGrove" || names.at(-1) !== "CloseGrove") {
    problems.push(`expected DrawGrove … CloseGrove from the vault, saw ${names.join(", ") || "none"}`);
  }

  // ZEC: the pot pays exactly the advertised amount, and nobody else keeps any
  const zec = ownerDeltas(tx, zecMint);
  const groveDelta = zec.get(grove) ?? 0n;
  if (-groveDelta !== BigInt(claim.zat)) {
    problems.push(`pot paid ${-groveDelta} zat, Sapling lists ${claim.zat}`);
  }

  // The burn: right mint, right amount
  const burnIx = top.find((i) => i.parsed && /^burn/.test(i.parsed.type) && i.parsed.info?.mint === claim.mint) ??
    (tx.meta?.innerInstructions ?? []).flatMap((g) => g.instructions)
      .find((i) => i.parsed && /^burn/.test(i.parsed.type) && i.parsed.info?.mint === claim.mint);
  if (!burnIx) {
    problems.push(`no burn of ${claim.mint} in the transaction`);
    return out;
  }
  const info = burnIx.parsed.info;
  const amount = BigInt(info.tokenAmount?.amount ?? info.amount);
  out.burnAuthority = info.authority;
  if (amount !== BigInt(claim.burned)) problems.push(`burned ${amount}, Sapling lists ${claim.burned}`);

  // The wallet that did the swap keeps neither ZEC nor coins afterwards
  const spender = info.authority;
  const spenderZec = zec.get(spender) ?? 0n;
  if (spenderZec !== 0n) problems.push(`buyback wallet ${spender} kept ${spenderZec} zat`);
  const coin = ownerDeltas(tx, claim.mint);
  const spenderCoin = coin.get(spender) ?? 0n;
  if (spenderCoin !== 0n) problems.push(`buyback wallet ${spender} kept ${spenderCoin} of the coin instead of burning it`);
  return out;
}

/**
 * Classify a transaction that touched the pot's ZEC account.
 * kind: "inflow" (SettleTax), "buyback" (DrawGrove … CloseGrove), "setup", or "other".
 */
export function classifyPotTx(tx, opts = {}) {
  const vault = opts.vault ?? VAULT, account = opts.groveAccount ?? GROVE_ACCOUNT;
  const names = vaultInstructions(tx, vault);
  const delta = accountDelta(tx, account);
  let kind = "other";
  if (tx.meta?.err) kind = "failed";
  else if (names.length && names.every((n) => n === "SettleTax")) kind = "inflow";
  else if (names[0] === "DrawGrove" && names.at(-1) === "CloseGrove") kind = "buyback";
  else if (delta === 0n && !names.length) kind = "setup";
  const problems = [];
  if (kind === "inflow" && delta < 0n) problems.push(`SettleTax took ${-delta} zat out of the pot`);
  if (kind === "other") problems.push(`pot changed by ${delta} zat in an unexpected transaction (${names.join(", ") || "no vault instruction"})`);
  return { signature: tx.transaction.signatures[0], blockTime: tx.blockTime ?? null, kind, names, delta: String(delta), signers: signersOf(tx), problems };
}
