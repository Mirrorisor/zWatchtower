// Was a forward private? See float-check.mjs: 3xpl lists a Zcash
// transaction's movements as address/effect events, with shielded value under
// a pool name instead of an address.
const T_ADDR = /^t[13][1-9A-HJ-NP-Za-km-z]{30,}$/;

/** shielded: every output went to a shielded pool; transparent: every output
 *  went to a t-address; mixed: both; unknown: no outputs seen. Change back to
 *  the order address itself doesn't count. */
export function classifyForward(events, fromAddress) {
  // "the-void" is where 3xpl puts the network fee
  const outs = events.filter((e) => BigInt(e.effect) > 0n && e.address !== fromAddress && e.address !== "the-void");
  if (!outs.length) return { kind: "unknown", pools: [] };
  const transparent = outs.filter((e) => T_ADDR.test(e.address));
  const pools = [...new Set(outs.filter((e) => !T_ADDR.test(e.address)).map((e) => e.address))];
  return { kind: transparent.length ? (pools.length ? "mixed" : "transparent") : "shielded", pools };
}
