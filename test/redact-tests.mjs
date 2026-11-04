// Secrets never reach anything zWatchtower writes or posts.
import { redact } from "../lib/redact.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };
const key = "61b398c7-55b5-4b08-8425-8dd959a5946e";
check("a Helius key in an error is removed", !redact(`HTTP error for https://mainnet.helius-rpc.com/?api-key=${key}`).includes("61b398c7"));
check("a cut-off key is removed too", !redact(`(HTTP error for https://mainnet.helius-rpc.com/?api-key=61b398c7-55b5-4b08-8425-8)`).includes("61b398c7"));
check("inside JSON it stays valid JSON", JSON.parse(redact(JSON.stringify({ e: `x?api-key=${key}&y=1` }))).e === "x?api-key=[redacted]&y=1");
check("a plain RPC URL is left alone", redact("https://api.mainnet-beta.solana.com") === "https://api.mainnet-beta.solana.com");
process.exitCode = failures ? 1 : 0;
