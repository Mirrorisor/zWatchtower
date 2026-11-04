#!/usr/bin/env node
// zWatchtower Telegram bot
//
// Answers /check TICKER (or a coin address) with the coin's report card, and
// posts everything zWatchtower would post (alerts, coin warnings, the daily
// summary) to an alert channel. Reads the files the checks already write; asks
// Telegram for messages by long polling, so the server opens no ports.
//
//   TELEGRAM_BOT_TOKEN=...  TELEGRAM_CHANNEL=@zwatchtower_alerts  node telegram-bot.mjs
//
// Options: --data DIR (default ./data)  --state FILE (default ./bot-state.json)
//          --once (one poll and one channel pass, for tests)
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { findCoins, formatCheck, newPosts, HELP, watchEntry, watchUpdates, newLaunches, formatLaunch, MAX_WATCHES } from "./lib/telegram.mjs";

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const channel = (process.env.TELEGRAM_CHANNEL ?? "").trim();
const api = (process.env.TELEGRAM_API ?? "https://api.telegram.org").replace(/\/$/, "");
const dataDir = opt("--data", "./data");
const statePath = opt("--state", "./bot-state.json");
const once = args.includes("--once");
const RESTART_AFTER_MS = 6 * 3600 * 1000;   // exit now and then so the service restarts on the newest code
if (!token) { console.error("TELEGRAM_BOT_TOKEN is not set"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function tg(method, body) {
  const r = await fetch(`${api}/bot${token}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) {
    if (j.parameters?.retry_after) await sleep(j.parameters.retry_after * 1000);
    throw new Error(`${method}: ${j.description ?? r.status}`);
  }
  return j.result;
}
const readJson = (f) => { try { return JSON.parse(readFileSync(join(dataDir, f), "utf8")); } catch { return null; } };
const readRows = (f) => { try { return readFileSync(join(dataDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { offset: 0, cursor: null };
state.watches ??= {};   // chatId -> { mint: { symbol, kinds, carded } }
state.subs ??= {};      // chatId -> true: wants new launches
const save = () => writeFileSync(statePath, JSON.stringify(state));

async function reply(msg, text) {
  await tg("sendMessage", { chat_id: msg.chat.id, text, parse_mode: "HTML", disable_web_page_preview: true,
    reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true } });
}

async function handle(msg) {
  const text = (msg.text ?? "").trim();
  const m = text.match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
  if (!m) return;
  const [, cmd, rest] = m;
  if (cmd === "start" || cmd === "help") return reply(msg, HELP);
  const chat = String(msg.chat.id);
  if (cmd === "watch" || cmd === "unwatch") {
    const q = rest.trim().split(/\s+/)[0];
    if (!q) return reply(msg, `Which coin? Try <code>/${cmd} SARAH</code> or paste the coin's address.`);
    const matches = findCoins(q, readJson("coins.json"), readJson("creators.json"));
    if (!matches.length) return reply(msg, `No Sapling coin called <b>${q.replace(/[<>&]/g, "")}</b> found.`);
    const m = matches[0], list = (state.watches[chat] ??= {});
    if (cmd === "unwatch") { delete list[m.mint]; save(); return reply(msg, `Stopped watching <b>$${m.symbol}</b>.`); }
    if (!list[m.mint] && Object.keys(list).length >= MAX_WATCHES) return reply(msg, `You're watching ${MAX_WATCHES} coins already. <code>/unwatch</code> one first.`);
    list[m.mint] = watchEntry(m); save();
    return reply(msg, `Watching <b>$${m.symbol}</b> <code>${m.mint}</code>. I'll message here when its report card changes.` +
      (matches.length > 1 ? `\n⚠ ${matches.length - 1} other coin${matches.length === 2 ? " uses" : "s use"} this name; this is the biggest. To watch another, use its address.` : "") +
      (m.card ? "" : "\nIt's under $10k, so it has no report card yet: I'll tell you if it gets one."));
  }
  if (cmd === "watching") {
    const list = Object.entries(state.watches[chat] ?? {});
    return reply(msg, list.length ? `Watching:\n${list.map(([mint, w]) => `• <b>$${w.symbol}</b> <code>${mint.slice(0, 4)}…${mint.slice(-4)}</code>`).join("\n")}` : "Not watching anything. Try <code>/watch SARAH</code>.");
  }
  if (cmd === "new") {
    if (/^off$/i.test(rest.trim())) { delete state.subs[chat]; save(); return reply(msg, "New-launch messages are off."); }
    state.subs[chat] = true; save();
    return reply(msg, "New-launch messages are on: each new Sapling coin with its creator's record, about every 30 minutes as launches are read. <code>/new off</code> to stop.");
  }
  if (cmd === "check" || cmd === "c") {
    const q = rest.trim().split(/\s+/)[0];
    if (!q) return reply(msg, "Which coin? Try <code>/check SARAH</code> or paste the coin's address.");
    return reply(msg, formatCheck(q, findCoins(q, readJson("coins.json"), readJson("creators.json"))));
  }
}

async function pollOnce(timeout) {
  const updates = await tg("getUpdates", { offset: state.offset, timeout, allowed_updates: ["message"] });
  for (const u of updates) {
    state.offset = u.update_id + 1;
    if (u.message) { try { await handle(u.message); } catch (e) { console.error(`reply failed: ${e.message}`); } }
  }
  save();
}

async function channelOnce() {
  if (!channel) return;
  const rows = readRows("x-posts.jsonl");
  // first start: begin from now, don't replay the history
  if (state.cursor == null) { state.cursor = rows.map((r) => r.at).sort().at(-1) ?? new Date().toISOString(); save(); return; }
  const { posts } = newPosts(rows, state.cursor);
  for (const p of posts.slice(0, 10)) {
    try {
      await tg("sendMessage", { chat_id: channel, text: p.text, disable_web_page_preview: true });
      state.cursor = p.at; save();
    } catch (e) { console.error(`channel post failed: ${e.message}`); break; }
    await sleep(3500);   // well under Telegram's limit of 20 a minute per channel
  }
}

async function send(chat, text) {
  await tg("sendMessage", { chat_id: chat, text, parse_mode: "HTML", disable_web_page_preview: true });
}

// watched coins whose report card changed
async function watchesOnce() {
  const coins = readJson("coins.json");
  if (!coins) return;
  const { messages, watches } = watchUpdates(state.watches, coins);
  for (const m of messages) {
    try { await send(m.chat, m.text); } catch (e) { console.error(`watch message failed: ${e.message}`); if (/blocked|not found|kicked/i.test(e.message)) delete watches[m.chat]; }
    await sleep(500);
  }
  state.watches = watches; save();
}

// new launches to the chats that asked for them
async function launchesOnce() {
  const creators = readJson("creators.json");
  if (!creators) return;
  // first time: start from now, don't replay every coin ever launched
  if (state.launchCursor == null) { state.launchCursor = newLaunches(creators, null).cursor ?? new Date().toISOString(); save(); return; }
  const { launches, cursor } = newLaunches(creators, state.launchCursor);
  state.launchCursor = cursor; save();
  const chats = Object.keys(state.subs);
  if (!chats.length) return;
  const coins = readJson("coins.json");
  for (const k of launches.slice(-10)) {
    const others = findCoins(k.symbol, coins, creators).filter((x) => x.mint !== k.mint).length;
    for (const chat of chats) {
      try { await send(chat, formatLaunch(k, others)); } catch (e) { console.error(`launch message failed: ${e.message}`); if (/blocked|not found|kicked/i.test(e.message)) delete state.subs[chat]; }
      await sleep(500);
    }
  }
  save();
}

async function main() {
  const me = await tg("getMe");
  console.log(`zWatchtower bot @${me.username} running${channel ? `, posting to ${channel}` : ""}`);
  if (once) { await pollOnce(0); await channelOnce(); await watchesOnce(); await launchesOnce(); return; }
  const started = Date.now();
  let lastChannel = 0;
  while (Date.now() - started < RESTART_AFTER_MS) {
    try { await pollOnce(50); } catch (e) { console.error(e.message); await sleep(5000); }
    if (Date.now() - lastChannel > 60000) {
      lastChannel = Date.now();
      for (const job of [channelOnce, watchesOnce, launchesOnce]) { try { await job(); } catch (e) { console.error(e.message); } }
    }
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
