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
import { findCoins, formatCheck, newPosts, HELP } from "./lib/telegram.mjs";

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

async function main() {
  const me = await tg("getMe");
  console.log(`zWatchtower bot @${me.username} running${channel ? `, posting to ${channel}` : ""}`);
  if (once) { await pollOnce(0); await channelOnce(); return; }
  const started = Date.now();
  let lastChannel = 0;
  while (Date.now() - started < RESTART_AFTER_MS) {
    try { await pollOnce(50); } catch (e) { console.error(e.message); await sleep(5000); }
    if (Date.now() - lastChannel > 60000) { lastChannel = Date.now(); try { await channelOnce(); } catch (e) { console.error(e.message); } }
  }
}

main().catch((e) => { console.error(e.message); process.exitCode = 1; });
