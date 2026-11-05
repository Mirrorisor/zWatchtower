// Wrapped ZEC: authorities and supply moves.
import { compare, changeOver } from "../lib/zec.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
const AUTH = "FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds";
const at = (h) => new Date(Date.parse("2026-11-04T00:00:00Z") + h * 3600e3).toISOString();
const snap = (h, supply, mint = AUTH, freeze = null) => ({ at: at(h), solana: { supply, mintAuthority: mint, freezeAuthority: freeze }, near: { supply: 200000 } });

let r = compare(null, snap(0, 105000));
check("first run: a baseline, no alerts", !r.alerts.length && r.state.authorities.mint === AUTH && r.state.history.length === 1);
let s = r.state;
r = compare(s, snap(0.25, 105100)); s = r.state;
check("normal bridging: nothing to say", !r.alerts.length && !r.events.length);
r = compare(s, snap(1.1, 108000)); s = r.state;
check("a big hour of bridging is an event, not an alert", !r.alerts.length && /3,000 ZEC bridged in/.test(r.events[0] ?? ""), JSON.stringify(r.events));
r = compare(s, snap(1.3, 108000, "Someone1111111111111111111111111111111111111"));
check("a new mint authority is an alert", r.alerts.length === 1 && /can create new ZEC changed from FvULaw/.test(r.alerts[0]), r.alerts[0]);
check("and the new one becomes the baseline", compare(r.state, snap(1.5, 108000, "Someone1111111111111111111111111111111111111")).alerts.length === 0);
r = compare(s, snap(1.3, 108000, AUTH, "Freezer111111111111111111111111111111111111"));
check("a freeze authority appearing is an alert", r.alerts.length === 1 && /can freeze ZEC accounts changed from none/.test(r.alerts[0]));
check("change over a window", changeOver(s.history, "solana", 2 * 3600e3, at(1.1)) === 3000);
check("no 7-day change until there are 7 days of history", changeOver(s.history, "solana", 7 * 24 * 3600e3, at(1.1)) === null);
// history is thinned to hourly after a day
let st = null;
for (let h = 0; h < 48; h += 0.25) st = compare(st, snap(h, 105000)).state;
check("history: every run for a day, hourly before that", st.history.length === 24 + 4 * 24 - 1 || (st.history.length > 110 && st.history.length < 125), String(st.history.length));
process.exitCode = failures ? 1 : 0;
