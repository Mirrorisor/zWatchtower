// Plain base58 (Bitcoin alphabet), used for Solana addresses and instruction data.
const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const MAP = new Map([...A].map((c, i) => [c, BigInt(i)]));

export function decode(s) {
  let n = 0n;
  for (const c of s) {
    const v = MAP.get(c);
    if (v === undefined) throw new Error("bad base58 character");
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 255n)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; bytes.unshift(0); }
  return Buffer.from(bytes);
}

export function encode(buf) {
  let n = BigInt("0x" + (Buffer.from(buf).toString("hex") || "0"));
  let s = "";
  while (n > 0n) { s = A[Number(n % 58n)] + s; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; s = "1" + s; }
  return s;
}
