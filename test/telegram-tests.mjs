// The Telegram bot: finding coins, writing cards, posting to the channel.
import { findCoins, formatCheck, newPosts } from "../lib/telegram.mjs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";

let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };

const SARAH = "4LT4uDp694w7soJerjRjSEVr2884J33EjLNG1WGzcash", COPY = "5isLWbGJcVd8VJ1fZtq8qVVPWvTb1xH2Wq3T9aHkcash";
const coins = { cards: [{ mint: SARAH, symbol: "SARAH", name: "Sarah The Barista", marketCapUsd: 142000, holders: 651, launchedAt: "2026-11-03T15:37:34.000Z",
  creator: "2TcgZHSAxb3j7KLSyzh3V9RwX7mTT3ixhiqnKiHbQwwd", flagCount: 1, flags: ["21 wallets bought 37.7% in the first 10 seconds"],
  facts: { creatorLaunchPct: 0, creatorSoldPct: 0, top10Pct: 23.7, mintAuthority: null, freezeAuthority: null,
    funding: { earlyBuyers: 21, lookedUp: 21, fundedByCreator: 0, viaBusyWallets: 3 } } }] };
const creators = { creators: [
  { creator: "2TcgZHSAxb3j7KLSyzh3V9RwX7mTT3ixhiqnKiHbQwwd", launched: 1, checked: 0, soldOut: 0, coins: [{ mint: SARAH, symbol: "SARAH", marketCapUsd: 142000, complete: true, bought: false, soldPct: 0 }] },
  { creator: "4JUovKxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", launched: 3, checked: 2, soldOut: 2, coins: [{ mint: COPY, symbol: "SARAH", marketCapUsd: 2800, launchedAt: "2026-11-03T15:40:00.000Z", complete: true, bought: true, launchPct: 4, soldPct: 100 }] },
] };

let m = findCoins("$sarah", coins, creators);
check("finds every coin with the ticker, any case, biggest first", m.length === 2 && m[0].mint === SARAH && m[1].mint === COPY);
check("finds a coin by its address", findCoins(COPY, coins, creators).length === 1);
let t = formatCheck("sarah", m);
check("card: name, address, market cap, flags, creator, first buyers", /\$SARAH<\/b> · Sarah The Barista/.test(t) && t.includes(SARAH) &&
  /Market cap \$142\.0k · 651 holders · launched 3 Nov/.test(t) && /1 flag/.test(t) && /• 21 wallets bought 37\.7%/.test(t) &&
  /Creator: didn't buy at launch, hasn't sold/.test(t) && /First buyers: 21 traced, 0 funded by the creator, 3 via exchanges/.test(t) && /Mint and freeze: renounced/.test(t), t);
check("card: warns about the copycat, by address", /⚠ 1 other coin uses this name/.test(t) && t.includes("5isL…cash") && /Check the address/.test(t));
check("card: links to the site's coin page", t.includes(`https://zwatchtower.lovable.app/coin/${SARAH}`));
t = formatCheck(COPY, findCoins(COPY, coins, creators));
check("a coin under $10k: what's known from the creator records", /Under \$10k/.test(t) && /bought 4% at launch, has sold 100%/.test(t) && /3 launched, sold out of 2 of 2/.test(t) && t.includes("/creators#4JUovK"), t);
check("unknown coin: a helpful answer", /No Sapling coin called <b>NOPE<\/b>/.test(formatCheck("NOPE", [])));
check("text is HTML-escaped", !formatCheck("<b>", []).includes("<b><b>"));
const rows = [{ at: "2026-11-04T01:00:00Z", text: "a" }, { at: "2026-11-04T02:00:00Z", text: "b", status: "error" }, { at: "2026-11-04T03:00:00Z", text: "c" }];
const np = newPosts(rows, "2026-11-04T00:30:00Z");
check("channel: new posts since the cursor, oldest first, errors skipped", np.posts.map((p) => p.text).join() === "a,c" && np.cursor === "2026-11-04T03:00:00Z");

// ---- end to end against a fake Telegram
const here = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "tg-test-"));
writeFileSync(join(dir, "coins.json"), JSON.stringify(coins));
writeFileSync(join(dir, "creators.json"), JSON.stringify(creators));
writeFileSync(join(dir, "x-posts.jsonl"), JSON.stringify({ at: "2026-11-04T01:00:00Z", text: "old post" }) + "\n");
const sent = [];
let updates = [{ update_id: 7, message: { message_id: 1, chat: { id: 42 }, text: "/check@zwatchtower_bot SARAH" } }];
const server = createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d));
  req.on("end", () => {
    const method = req.url.split("/").pop(), body = b ? JSON.parse(b) : {};
    const ok = (result) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, result })); };
    if (method === "getMe") return ok({ username: "zwatchtower_bot" });
    if (method === "getUpdates") { const u = updates.filter((x) => x.update_id >= (body.offset ?? 0)); return ok(u); }
    if (method === "sendMessage") { sent.push(body); return ok({ message_id: sent.length }); }
    ok(true);
  });
});
await new Promise((r) => server.listen(0, r));
const run = () => new Promise((done) => {
  const p = spawn(process.execPath, [join(here, "../telegram-bot.mjs"), "--once", "--data", dir, "--state", join(dir, "bot.json")],
    { env: { ...process.env, TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHANNEL: "@alerts", TELEGRAM_API: `http://127.0.0.1:${server.address().port}` } });
  let e = ""; p.stderr.on("data", (d) => (e += d)); p.on("close", (code) => done({ code, err: e }));
});
try {
  let r = await run();
  const answer = sent.find((s) => s.chat_id === 42);
  check("end to end: /check in a group gets the card, as a reply", r.code === 0 && answer && /\$SARAH/.test(answer.text) && answer.parse_mode === "HTML" &&
    answer.reply_parameters?.message_id === 1, r.err || JSON.stringify(sent));
  check("end to end: first start doesn't replay old posts to the channel", !sent.some((s) => s.chat_id === "@alerts"));
  const st = JSON.parse(readFileSync(join(dir, "bot.json"), "utf8"));
  check("end to end: messages aren't answered twice", st.offset === 8);
  writeFileSync(join(dir, "x-posts.jsonl"), [{ at: "2026-11-04T01:00:00Z", text: "old post" }, { at: "2026-11-04T05:00:00Z", text: "Copycat: new coin $X" }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  updates = [];
  r = await run();
  const posted = sent.filter((s) => s.chat_id === "@alerts").map((s) => s.text);
  check("end to end: a new post goes to the channel, once", posted.join() === "Copycat: new coin $X", JSON.stringify(posted));
  await run();
  check("end to end: and isn't posted again", sent.filter((s) => s.chat_id === "@alerts").length === 1);
} finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
