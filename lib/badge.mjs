// A small badge per coin, in the familiar two-part style, that a coin's team
// can put on X, Telegram or a site. It links to nothing by itself; the embed
// snippet on the coins page wraps it in a link to the coin's card.
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// rough width of 11px Verdana text, as badge makers use
const textWidth = (s) => [...String(s)].reduce((w, ch) => w + (/[ilIj.,:;'|!·]/.test(ch) ? 3.8 : ch === " " ? 3.9
  : /[mwMW%]/.test(ch) ? 11 : /[A-Z0-9$]/.test(ch) ? 8 : 7), 0);

export function badgeFor(card) {
  const launchUnread = card.facts?.creatorSoldPct === undefined;
  const n = card.flagCount ?? 0;
  const right = n ? `$${card.symbol} · ${n} flag${n === 1 ? "" : "s"}` : launchUnread ? `$${card.symbol} · launch not checked` : `$${card.symbol} · no flags`;
  const color = n >= 3 ? "#c0392b" : n ? "#d68910" : launchUnread ? "#7f8c8d" : "#2e8b57";
  return { left: "zWatchtower", right, color, title: n ? card.flags.join("; ") : launchUnread ? "Launch not checked: Sapling's trade history doesn't reach it yet" : "No flags" };
}

export function badgeSvg(card) {
  const { left, right, color, title } = badgeFor(card);
  const id = String(card.mint ?? card.symbol).replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const lw = Math.round(textWidth(left) + 14), rw = Math.round(textWidth(right) + 14), w = lw + rw;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">
<title>${esc(`${left}: ${right}. ${title}`)}</title>
<linearGradient id="s${id}" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r${id}"><rect width="${w}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r${id})"><rect width="${lw}" height="20" fill="#1f3b2d"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${w}" height="20" fill="url(#s${id})"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(left)}</text><text x="${lw / 2}" y="14">${esc(left)}</text>
<text x="${lw + rw / 2}" y="15" fill="#010101" fill-opacity=".3">${esc(right)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text>
</g></svg>`;
}
