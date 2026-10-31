// Dependency-free BIP32 public derivation and Zcash transparent P2PKH addresses.
// Used to list Sapling's order addresses from the account public keys in
// https://sapling.cash/.well-known/sapling-exits.json (stamps SPEC §10.1):
//   order i = P2PKH( CKDpub( CKDpub(accountPubkey, 0), i ) )
import { createHash, createHmac } from "node:crypto";

// secp256k1
const P = 2n ** 256n - 2n ** 32n - 977n;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
const mod = (a, m = P) => ((a % m) + m) % m;
const pow = (b, e, m = P) => {
  let r = 1n; b = mod(b, m);
  for (; e > 0n; e >>= 1n, b = (b * b) % m) if (e & 1n) r = (r * b) % m;
  return r;
};
const inv = (a) => pow(a, P - 2n);

function add(p, q) {
  if (!p) return q;
  if (!q) return p;
  const [x1, y1] = p, [x2, y2] = q;
  if (x1 === x2 && mod(y1 + y2) === 0n) return null;
  const l = x1 === x2
    ? mod(3n * x1 * x1 * inv(2n * y1))
    : mod((y2 - y1) * inv(x2 - x1));
  const x3 = mod(l * l - x1 - x2);
  return [x3, mod(l * (x1 - x3) - y1)];
}
// Jacobian coordinates: one inversion per scalar multiplication instead of
// one per step. Fixed-base table of 2^i * G (affine) built once.
function jDouble([X, Y, Z]) {
  if (Y === 0n) return [0n, 1n, 0n];
  const S = mod(4n * X * Y * Y), M = mod(3n * X * X);
  const X3 = mod(M * M - 2n * S);
  return [X3, mod(M * (S - X3) - 8n * Y ** 4n), mod(2n * Y * Z)];
}
function jAddAffine([X1, Y1, Z1], [x2, y2]) {
  if (Z1 === 0n) return [x2, y2, 1n];
  const Z1Z1 = mod(Z1 * Z1), U2 = mod(x2 * Z1Z1), S2 = mod(y2 * Z1 * Z1Z1);
  const H = mod(U2 - X1), R = mod(S2 - Y1);
  if (H === 0n) return R === 0n ? jDouble([X1, Y1, Z1]) : [0n, 1n, 0n];
  const HH = mod(H * H), HHH = mod(H * HH), V = mod(X1 * HH);
  const X3 = mod(R * R - HHH - 2n * V);
  return [X3, mod(R * (V - X3) - Y1 * HHH), mod(Z1 * H)];
}
function toAffine([X, Y, Z]) {
  if (Z === 0n) return null;
  const zi = inv(Z), zi2 = mod(zi * zi);
  return [mod(X * zi2), mod(Y * zi2 * zi)];
}
let G_TABLE = null;
function mul(k) {
  if (!G_TABLE) {
    G_TABLE = [G];
    for (let i = 1; i < 256; i++) G_TABLE.push(add(G_TABLE[i - 1], G_TABLE[i - 1]));
  }
  let r = [0n, 1n, 0n];
  for (let i = 0; k > 0n; i++, k >>= 1n) if (k & 1n) r = jAddAffine(r, G_TABLE[i]);
  return toAffine(r);
}

const toBig = (buf) => BigInt("0x" + Buffer.from(buf).toString("hex"));
const to32 = (n) => Buffer.from(n.toString(16).padStart(64, "0"), "hex");

export function decompress(buf) {
  if (buf.length !== 33 || (buf[0] !== 2 && buf[0] !== 3)) throw new Error("bad compressed key");
  const x = toBig(buf.subarray(1));
  let y = pow(mod(x ** 3n + 7n), (P + 1n) / 4n);
  if (mod(y * y) !== mod(x ** 3n + 7n)) throw new Error("not on curve");
  if ((y & 1n) !== BigInt(buf[0] & 1)) y = P - y;
  return [x, y];
}
export const compress = ([x, y]) =>
  Buffer.concat([Buffer.from([y & 1n ? 3 : 2]), to32(x)]);

// BIP32 non-hardened public child derivation.
export function ckdPub({ chainCode, key }, index) {
  if (index >= 0x80000000) throw new Error("hardened index");
  const data = Buffer.concat([key, Buffer.from([index >>> 24, index >>> 16 & 255, index >>> 8 & 255, index & 255])]);
  const I = createHmac("sha512", chainCode).update(data).digest();
  const il = toBig(I.subarray(0, 32));
  if (il >= N) return null; // invalid index: never used (SPEC §10.1)
  const child = add(mul(il), decompress(key));
  if (!child) return null;
  return { chainCode: I.subarray(32), key: compress(child) };
}

// accountPubkey: 130 hex = 32-byte chain code, then 33-byte compressed key
export function parseAccountPubkey(hex) {
  const b = Buffer.from(hex, "hex");
  if (b.length !== 65) throw new Error("account pubkey must be 65 bytes");
  return { chainCode: b.subarray(0, 32), key: b.subarray(32) };
}

const sha256 = (b) => createHash("sha256").update(b).digest();
const hash160 = (b) => createHash("ripemd160").update(sha256(b)).digest();

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58check(payload) {
  const full = Buffer.concat([payload, sha256(sha256(payload)).subarray(0, 4)]);
  let n = toBig(full), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const byte of full) { if (byte !== 0) break; s = "1" + s; }
  return s;
}

// Zcash mainnet transparent P2PKH: 2-byte prefix 1c b8 ("t1...")
export const zcashP2PKH = (compressedKey) =>
  base58check(Buffer.concat([Buffer.from([0x1c, 0xb8]), hash160(compressedKey)]));

export function orderAddresses(accountPubkeyHex, from, count) {
  const external = ckdPub(parseAccountPubkey(accountPubkeyHex), 0);
  const out = [];
  for (let i = from; i < from + count; i++) {
    const child = ckdPub(external, i);
    if (child) out.push({ index: i, address: zcashP2PKH(child.key) });
  }
  return out;
}

// Bitcoin P2PKH (prefix 00), only for checking derivation against known vectors.
export const bitcoinP2PKH = (compressedKey) =>
  base58check(Buffer.concat([Buffer.from([0x00]), hash160(compressedKey)]));
