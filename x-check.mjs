#!/usr/bin/env node
// Checks the X keys in the environment: which account they post as, and
// whether they can write. Posts nothing.
import { signRequest } from "./lib/xpost.mjs";
const env = process.env;
const creds = { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET };
if (Object.values(creds).some((v) => !v)) { console.log("✗ Not all four X keys are set."); process.exit(1); }
const url = "https://api.x.com/2/users/me";
let r;
try { r = await fetch(url, { headers: { authorization: signRequest("GET", url, creds) } }); }
catch (e) { console.log(`✗ Couldn't reach X (${e.cause?.code ?? e.message}). The keys are saved; try again in a minute.`); process.exit(1); }
const body = await r.json().catch(() => ({}));
if (!r.ok) {
  console.log(`✗ X said ${r.status}: ${JSON.stringify(body).slice(0, 200)}`);
  console.log(r.status === 401 ? "  One of the four keys is wrong or was copied incompletely. Run the setup again." : "  Check the app's permissions and billing in the X developer console.");
  process.exit(1);
}
const access = r.headers.get("x-access-level");
console.log(`✓ Keys work. zWatchtower will post as @${body.data?.username}.`);
if (access && !/write/i.test(access)) console.log(`✗ But the access token is "${access}": set the app to Read and write, then generate the Access Token again and rerun.`);
