// The Telegram bot's words: finding a coin and writing its card, and which
// posts are new for the alert channel. Pure functions over zWatchtower's own
// data files, so they run offline in tests.

import { flagKind } from "./coins.mjs";

export const SITE = "https://zwatchtower.lovable.app";
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "?");
const usd = (n) => n == null ? "?" : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n)}`;
const pct = (v) => v == null ? "?" : `${v > 0 && v < 1 ? v.toFixed(2) : Math.round(v * 10) / 10}%`;
const day = (iso) => iso ? new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", timeZone: "UTC" }) : "?";

/**
 * Every coin matching a ticker ($ optional, any case) or a mint address,
 * biggest market cap first. From the report cards (coins over $10k) and the
 * creator records (every coin).
 */
export function findCoins(query, coinsJson, creatorsJson) {
  const q = String(query ?? "").trim().replace(/^\$/, "");
  if (!q) return [];
  const byMint = new Map();
  for (const c of coinsJson?.cards ?? []) byMint.set(c.mint, { mint: c.mint, symbol: c.symbol, card: c, marketCapUsd: c.marketCapUsd });
  for (const cr of creatorsJson?.creators ?? []) for (const k of cr.coins) {
    const e = byMint.get(k.mint) ?? { mint: k.mint, symbol: k.symbol, marketCapUsd: k.marketCapUsd };
    e.launch = { ...k, creator: cr.creator, record: { launched: cr.launched, checked: cr.checked, soldOut: cr.soldOut } };
    byMint.set(k.mint, e);
  }
  const isMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q);
  return [...byMint.values()]
    .filter((e) => (isMint ? e.mint === q : (e.symbol ?? "").toLowerCase() === q.toLowerCase()))
    .sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));
}

/** The reply to /check: the main coin's card, and any others using the same name. */
export function formatCheck(query, matches) {
  if (!matches.length) return `No Sapling coin called <b>${esc(query)}</b> found. Try the ticker (e.g. <code>/check SARAH</code>) or the coin's address.`;
  const [m, ...others] = matches;
  const c = m.card, l = m.launch;
  const lines = [`<b>$${esc(m.symbol)}</b>${c?.name ? ` · ${esc(c.name)}` : ""}`, `<code>${esc(m.mint)}</code>`];
  lines.push(`Market cap ${usd(m.marketCapUsd)}${c?.holders != null ? ` · ${c.holders} holders` : ""}${(c?.launchedAt ?? l?.launchedAt) ? ` · launched ${day(c?.launchedAt ?? l?.launchedAt)}` : ""}`);
  if (c) {
    const f = c.facts ?? {};
    lines.push("", c.flagCount ? `<b>${c.flagCount} flag${c.flagCount === 1 ? "" : "s"}</b>` : "<b>No flags</b>");
    for (const x of c.flags) lines.push(`• ${esc(x)}`);
    lines.push("");
    if (c.creatorHidden) lines.push("Creator: launched from a shielded Zcash wallet, not public");
    else if (f.creatorSoldPct !== undefined) lines.push(!f.creatorLaunchPct && !f.creatorSoldPct
      ? "Creator: didn't buy at launch, hasn't sold"
      : `Creator: bought ${pct(f.creatorLaunchPct)} at launch, has sold ${pct(f.creatorSoldPct)} of what they bought`);
    else lines.push("Creator: launch not read yet");
    if (f.creatorOtherCoins?.launched) lines.push(`Creator's other coins: ${f.creatorOtherCoins.launched}, sold out of ${f.creatorOtherCoins.soldOut} of ${f.creatorOtherCoins.checked} checked`);
    if (f.funding) lines.push(f.funding.lookedUp < f.funding.earlyBuyers
      ? `First buyers: ${f.funding.lookedUp} of ${f.funding.earlyBuyers} traced so far`
      : `First buyers: ${f.funding.earlyBuyers} traced, ${f.funding.fundedByCreator} funded by the creator${f.funding.viaBusyWallets ? `, ${f.funding.viaBusyWallets} via exchanges` : ""}`);
    if (f.top10Pct != null) lines.push(`Top 10 wallets: ${pct(f.top10Pct)}`);
    const auth = [f.mintAuthority ? "can mint more" : null, f.freezeAuthority ? "can freeze wallets" : null].filter(Boolean);
    if (f.mintAuthority !== undefined) lines.push(auth.length ? `⚠ Mint: ${auth.join(", ")}` : "Mint and freeze: renounced");
  } else if (l) {
    lines.push("", "Under $10k, so no full report card. What's known:");
    if (l.complete) lines.push(l.bought === false
      ? `Creator: didn't buy at launch${l.soldPct > 0 ? ", but has sold tokens" : ""}`
      : `Creator: bought ${pct(l.launchPct)} at launch, has sold ${pct(l.soldPct)} of it`);
    if (l.record?.launched > 1) lines.push(`Creator's coins: ${l.record.launched} launched, sold out of ${l.record.soldOut} of ${l.record.checked} checked`);
  }
  if (others.length) {
    lines.push("", `⚠ ${others.length} other coin${others.length === 1 ? " uses" : "s use"} this name:`);
    for (const o of others.slice(0, 5)) lines.push(`• <code>${esc(short(o.mint))}</code> ${usd(o.marketCapUsd)}`);
    lines.push("Check the address before you buy.");
  }
  lines.push("", c ? `<a href="${SITE}/coin/${esc(m.mint)}">Full report card</a> · facts, not financial advice`
    : l?.creator ? `<a href="${SITE}/creators#${esc(l.creator)}">The creator's coins</a> · facts, not financial advice`
    : "Facts, not financial advice");
  return lines.join("\n");
}

/**
 * Posts written since the cursor (x-posts.jsonl rows, oldest first), and the new cursor.
 * Every post goes to the channel whether or not X accepted it: an X failure
 * (no credits, rate limit) shouldn't silence the alert channel too.
 */
export function newPosts(rows, cursor) {
  const fresh = rows.filter((r) => r.text && r.at > (cursor ?? "")).sort((a, b) => a.at.localeCompare(b.at));
  return { posts: fresh, cursor: fresh.length ? fresh.at(-1).at : cursor };
}


// ---- /watch: tell a chat when a watched coin's report card changes

export const MAX_WATCHES = 20;
const kindsOf = (card) => [...new Set((card?.flags ?? []).map(flagKind))].sort();

/** What a chat starts watching: the coin and its flags right now. */
export function watchEntry(match) {
  return { symbol: match.symbol, kinds: match.card ? kindsOf(match.card) : null, carded: Boolean(match.card) };
}

/**
 * Compare every watched coin with the latest report cards.
 * @param watches { chatId: { mint: { symbol, kinds, carded } } }
 * @returns { messages: [{ chat, text }], watches } (watches updated to what was reported)
 */
export function watchUpdates(watches, coinsJson) {
  const cards = new Map((coinsJson?.cards ?? []).map((c) => [c.mint, c]));
  const messages = [];
  const next = {};
  for (const [chat, list] of Object.entries(watches ?? {})) {
    next[chat] = {};
    for (const [mint, w] of Object.entries(list)) {
      const card = cards.get(mint);
      const now = { symbol: card?.symbol ?? w.symbol, kinds: card ? kindsOf(card) : w.kinds, carded: Boolean(card) };
      const lines = [];
      if (card && !w.carded) lines.push(`now over $10k and has a report card: ${card.flagCount ? `${card.flagCount} flag${card.flagCount === 1 ? "" : "s"}` : "no flags"}`);
      else if (!card && w.carded) lines.push("dropped under $10k, so its report card is no longer refreshed");
      if (card && w.carded && w.kinds) {
        const added = card.flags.filter((f) => !w.kinds.includes(flagKind(f)));
        const gone = w.kinds.filter((k) => !now.kinds.includes(k));
        for (const f of added) lines.push(`new flag: ${f}`);
        if (gone.length) lines.push(`${gone.length} flag${gone.length === 1 ? "" : "s"} cleared`);
      }
      if (lines.length) messages.push({ chat, text: `👁 <b>$${esc(now.symbol)}</b> <code>${esc(short(mint))}</code>\n${lines.map((l) => "• " + esc(l)).join("\n")}\n<a href="${SITE}/coin/${esc(mint)}">Report card</a>` });
      next[chat][mint] = now;
    }
  }
  return { messages, watches: next };
}

// ---- /new: a feed of new launches, with the creator's record

/** Coins launched after the cursor (ISO time), oldest first, from the creator records. */
export function newLaunches(creatorsJson, cursor) {
  const out = [];
  for (const cr of creatorsJson?.creators ?? []) for (const k of cr.coins ?? [])
    if (k.launchedAt && k.launchedAt > (cursor ?? "")) out.push({ ...k, creator: cr.creator, record: { launched: cr.launched, checked: cr.checked, soldOut: cr.soldOut } });
  out.sort((a, b) => a.launchedAt.localeCompare(b.launchedAt));
  return { launches: out, cursor: out.length ? out.at(-1).launchedAt : cursor };
}

export function formatLaunch(k, others = 0) {
  const r = k.record ?? {};
  const prior = (r.launched ?? 1) - 1;
  const lines = [`🌱 New on Sapling: <b>$${esc(k.symbol)}</b> <code>${esc(k.mint)}</code>`];
  if (prior <= 0) lines.push("Creator: first Sapling coin");
  else lines.push(`Creator: ${prior} other Sapling coin${prior === 1 ? "" : "s"}${r.checked ? `, sold out of ${r.soldOut} of ${r.checked} checked` : ""}${r.soldOut >= 2 ? " ⚠" : ""}`);
  if (others) lines.push(`⚠ ${others} other coin${others === 1 ? " uses" : "s use"} this name. Check the address.`);
  lines.push(`<a href="${SITE}/creators#${esc(k.creator)}">Creator's coins</a> · facts, not financial advice`);
  return lines.join("\n");
}

export const HELP = [
  "<b>zWatchtower</b>: an independent, open-source watchdog of Sapling.",
  "",
  "<code>/check TICKER</code> or <code>/check address</code>: a coin's report card: flags, the creator's record, who funded the first buyers, and copycats.",
  "<code>/watch TICKER</code>: a message when that coin's report card changes. <code>/unwatch TICKER</code>, <code>/watching</code>.",
  "<code>/new</code>: new Sapling launches as they're read, with the creator's record. <code>/new off</code> to stop.",
  "",
  `Every coin: ${SITE}`,
  "Facts read from the chain, not financial advice.",
].join("\n");
