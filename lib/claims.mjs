// Sapling's headline claims, read from its homepage, against the chain.
// Only claims the chain can settle directly are checked.

export const SAPLING_MINT = "BZFYNPeQAEW3HWQ4DNsTVahC1n4ZjTgn6jB2nnBbB96W";
export const SAPLING_TOTAL = 1_000_000_000; // whole tokens at launch (pump.fun)

const text = (html) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");

/** "222.15M" / "212,230,000" near "burned" -> whole tokens, or null */
export function claimedBurn(html) {
  const t = text(html);
  const num = (s, unit) => Number(s.replace(/,/g, "")) * ({ k: 1e3, m: 1e6, b: 1e9 }[String(unit || "").toLowerCase()] ?? 1);
  const pats = [
    /\$?SAPLING burned\s*:?\s*([\d.,]+)\s*([kmb])?/i,
    /([\d.,]+)\s*([kmb])?\s*\$?SAPLING\s+burned/i,
    /burned\s*:?\s*([\d.,]+)\s*([kmb])?\s*\$?SAPLING/i,
  ];
  for (const p of pats) { const m = t.match(p); if (m && Number.isFinite(num(m[1], m[2]))) return num(m[1], m[2]); }
  return null;
}

/**
 * @param claimed whole tokens Sapling says are burned (or null)
 * @param supply  current supply in whole tokens, from the chain
 */
export function compareBurn(claimed, supply) {
  const onChain = SAPLING_TOTAL - supply;
  if (claimed == null) return { onChain, claimed: null, verdict: "claim not found on Sapling's page" };
  const diffPct = onChain ? Math.abs(claimed - onChain) / onChain * 100 : 100;
  // the page rounds to two decimals of millions and updates between reads
  return { onChain, claimed, diffPct: Math.round(diffPct * 100) / 100, verdict: diffPct <= 1 ? "matches" : "differs" };
}

/**
 * What Sapling's docs say about the multisig that can upgrade its program
 * ("a 2-of-3 multisig"), from the docs page HTML. null when not stated.
 */
export function multisigClaim(html) {
  const text = String(html ?? "").replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const m = text.match(/(\d+)\s*-?\s*of\s*-?\s*(\d+)\s+(?:Squads\s+)?multisig/i);
  return m ? { threshold: Number(m[1]), members: Number(m[2]) } : null;
}

/** The docs' claim against the multisig on chain. */
export function compareMultisig(claim, onChain) {
  if (!claim || !onChain) return null;
  return { says: `${claim.threshold}-of-${claim.members}`, onChain: `${onChain.threshold}-of-${onChain.members}`,
    matches: claim.threshold === onChain.threshold && claim.members === onChain.members };
}
