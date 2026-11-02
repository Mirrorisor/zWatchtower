// Posting alerts to X.
//
// composePosts() turns one check's new alerts into a few readable posts:
// upgrades, admin actions and failed checks are posted; routine multisig
// proposal and approval steps are not. signRequest() is OAuth 1.0a
// (HMAC-SHA1), which X needs to post as a user; postToX() sends one post.
import { createHmac, randomBytes } from "node:crypto";

export const X_POST_URL = "https://api.x.com/2/tweets";

// ---- composing -------------------------------------------------------------

const camel = (s) => s.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
const hhmm = (iso) => (iso ? `${iso.slice(11, 16)} UTC` : "");

/** X counts most characters as 1 and emoji and CJK as 2. */
export function xLength(text) {
  let n = 0;
  for (const ch of text) n += ch.codePointAt(0) > 0x10ff ? 2 : 1;
  return n;
}
export function fit(text, max = 280) {
  if (xLength(text) <= max) return text;
  let out = "";
  for (const ch of text) { if (xLength(out + ch + "…") > max) break; out += ch; }
  return out.trimEnd() + "…";
}

/**
 * @param check  "keys" | "tax" | "flywheel" | "float" | "rewards"
 * @param raised   alert texts that are new this run
 * @param resolved alert texts that cleared this run
 * @param now      ISO time of this run
 * @returns array of post texts (unsized; the caller fits and caps them)
 */
export function composePosts(check, raised, resolved, now = new Date().toISOString()) {
  const posts = [];
  if (check === "keys") {
    const executes = raised.map((a) => a.match(/^multisig vault_transaction_execute at (\S+)/)?.[1]).filter(Boolean).sort();
    for (const a of raised) {
      const up = a.match(/^vault program upgraded: last deploy slot (\d+) -> (\d+)/);
      if (up) {
        const landed = executes.at(-1);
        const mins = landed ? Math.max(1, Math.round((Date.parse(now) - Date.parse(landed)) / 60000)) : null;
        // Only the upgrade authority can upgrade; if it had changed, that is its own
        // alert. The multisig's execute step can land in a later run's batch, so
        // its absence here proves nothing and is not mentioned.
        const authChanged = raised.some((x) => /^upgrade authority is /.test(x));
        posts.push(`Sapling just upgraded its vault program${landed ? ` at ${hhmm(landed)}` : ""}` +
          `${authChanged ? "." : ", through its Squads multisig."}` +
          `${mins && mins <= 90 ? ` Flagged ${mins} minute${mins === 1 ? "" : "s"} after it landed.` : ""}` +
          `\n\nEvery upgrade is checked and logged on the zWatchtower dashboard.`);
        continue;
      }
      const auth = a.match(/^upgrade authority is (.*)$/);
      if (auth) { posts.push(`ALERT: control of Sapling's vault program upgrades has changed: the upgrade authority is ${auth[1]}.`); continue; }
      const owner = a.match(/^config account owner is (.*)$/);
      if (owner) { posts.push(`ALERT: Sapling's vault config account is now owned by ${owner[1]}, not the vault program.`); continue; }
      const cfg = a.match(/^vault config changed: (.*)$/);
      if (cfg) { posts.push(`Sapling's vault config just changed: ${cfg[1]}`); continue; }
    }
    // admin instructions, grouped by name
    const admin = new Map();
    for (const a of raised) {
      const m = a.match(/^privileged vault instruction (\S+)( via multisig)? at (\S+)/);
      if (!m) continue;
      const k = camel(m[1]);
      const e = admin.get(k) ?? { n: 0, multisig: false, last: m[3] };
      e.n++; e.multisig ||= Boolean(m[2]); if (m[3] > e.last) e.last = m[3];
      admin.set(k, e);
    }
    for (const [name, e] of admin) {
      posts.push(`Sapling's admin ran ${name} on its vault program${e.n > 1 ? ` ${e.n} times` : ""}` +
        `${e.multisig ? " through the multisig" : ""}, last at ${hhmm(e.last)}.`);
    }
    const unknown = raised.filter((a) => /unrecognised/.test(a));
    if (unknown.length) posts.push(`Sapling's vault program ran ${unknown.length} instruction${unknown.length > 1 ? "s" : ""} zWatchtower doesn't recognise yet. Looking into it.`);
    return posts;
  }

  const label = { tax: "Coin tax check", flywheel: "Flywheel check", float: "Payout float check", rewards: "Holder rewards check" }[check] ?? `${check} check`;
  if (raised.length === 1) posts.push(`${label}: ${raised[0]}`);
  else if (raised.length > 1) {
    const what = { tax: "coin tax", flywheel: "buyback", float: "payout", rewards: "reward run" }[check] ?? "item";
    posts.push(`${label}: ${raised.length} new problems (${what}s that don't match the chain). First: ${raised[0]}`);
  }
  if (resolved.length) posts.push(`${label}: ${resolved.length === 1 ? "an earlier alert has" : `${resolved.length} earlier alerts have`} cleared.`);
  return posts;
}

/** One line a day: how every check stands. */
export function composeSummary(latest) {
  const names = ["keys", "rewards", "float", "tax", "flywheel"];
  const ran = names.filter((n) => latest[n]?.status === "ran");
  const green = ran.filter((n) => latest[n].ok);
  const parts = [`zWatchtower daily: ${green.length} of ${names.length} checks green.`];
  const tax = latest.tax?.summary;
  if (tax?.coins) parts.push(`${tax.matching} of ${tax.coins} Raydium coins charge their advertised tax.`);
  const pot = latest.flywheel?.summary?.pot;
  if (pot?.reconciled) parts.push(`Flywheel pot reconciled to the zat.`);
  const fl = latest.float?.summary;
  if (fl && fl.currentFloatZec != null) parts.push(`${fl.currentFloatZec} ZEC waiting in payouts.`);
  const red = ran.filter((n) => !latest[n].ok);
  if (red.length) parts.push(`Open alerts: ${red.join(", ")}.`);
  return parts.join(" ");
}

// ---- OAuth 1.0a ------------------------------------------------------------

const pct = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/** The Authorization header for one request. extraParams are query or form params (not a JSON body). */
export function signRequest(method, url, creds, extraParams = {}, nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000)) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...extraParams, ...oauth };
  const paramString = Object.keys(all).map((k) => [pct(k), pct(String(all[k]))])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join("&");
  const base = [method.toUpperCase(), pct(url), pct(paramString)].join("&");
  const key = `${pct(creds.apiSecret)}&${pct(creds.accessSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return "OAuth " + Object.keys(header).sort().map((k) => `${pct(k)}="${pct(header[k])}"`).join(", ");
}

export async function postToX(text, creds, url = X_POST_URL) {
  const r = await fetch(url, {
    method: "POST",
    headers: { authorization: signRequest("POST", url, creds), "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`X ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.data?.id ?? null;
}
