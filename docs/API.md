# zWatchtower public data API (v1)

Static JSON, rebuilt on every run (about every 30–45 minutes), served from
GitHub Pages with open CORS, so any site or app can read it from the browser.
Free, no key, no sign-up.

Base URL: `https://mirrorisor.github.io/zWatchtower/`

**Stability.** Every file carries `apiVersion`. Within a version, fields are
only ever added: none is renamed, retyped or removed. A breaking change gets
a new version, announced in this file and the README at least 14 days ahead,
with the old version kept alongside it in the meantime.

**What it is.** Facts read from Sapling's public API and the Solana and
Zcash chains. A flag means a fact crossed a published line; it is not a
verdict, and nothing here is financial advice. Mistakes are fixed and listed
in [CORRECTIONS.md](../CORRECTIONS.md).

## `api/coins.json`: coin report cards

```jsonc
{
  "apiVersion": 1,
  "generatedAt": "2026-11-03T00:10:00.000Z",
  "minMcapUsd": 10000,              // only coins at or above this market cap get a card
  "limits": { "creatorLaunchPct": 5, "creatorSoldPct": 50, "earlyBuyersPct": 10, "top10Pct": 50 },
  "earlySeconds": 10,
  "soldOutPct": 90,                 // "sold out" = sold at least this % of what they bought
  "cards": [ /* card, below; biggest market cap first */ ],
  "events": [ { "at": "…", "mint": "…", "symbol": "…", "text": "…" } ],   // recent changes, newest first
  "serialCreators": [ { "creator": "…", "launched": 5, "checked": 4, "soldOut": 4, "coins": [ … ] } ],
  "repeatHolders": [ { "owner": "…", "coins": [ { "symbol": "…", "mint": "…", "pct": 2.1 } ], "created": [], "earlyBuyerIn": [] } ],
  "launchesKnown": 120              // coins whose creator and launch have been read so far
}
```

A **card**:

| Field | Meaning |
| --- | --- |
| `mint`, `symbol`, `name` | The coin |
| `marketCapUsd`, `holders` | From the coin's own Sapling page |
| `launchedAt`, `venue`, `graduated` | Launch time, where it trades, whether it left its launch curve |
| `creator` | The launching wallet, or `null` when launched from a shielded Zcash wallet (`creatorHidden: true`) |
| `taxPct`, `feesTo` | Trade tax, and who receives the creator share (`creator`, `holders`, `Zcash Foundation`, `another wallet`) |
| `facts.creatorLaunchPct` | % of supply the creator bought at launch (absent until the launch has been read) |
| `facts.creatorSoldPct` | % of what the creator bought that they have sold |
| `facts.earlyBuyers`, `facts.earlyBuyersPct` | Other wallets buying in the first `earlySeconds`, and the % of supply they bought |
| `facts.top10Pct`, `facts.top10` | Share held by the 10 largest wallets (pools and program accounts left out) |
| `facts.creatorOtherCoins` | `{ launched, checked, soldOut, soldOutCoins }` for the creator's other Sapling coins |
| `facts.mintAuthority`, `facts.freezeAuthority`, `facts.taxChangeable` | On-chain mint settings |
| `flags` | Plain-English facts past a line; `flagCount` is their number |
| `notes` | What couldn't be checked, and why |
| `refreshedAt` | When this card was last read |

A field that couldn't be read is absent rather than guessed.

## `badges/<mint>.svg`: a badge per carded coin

Green: no flags. Amber: 1–2 flags. Red: 3 or more. Grey: launch not read yet.
Link it to `coins.html#<mint>`.

## `api/status.json`: every check

```jsonc
{
  "apiVersion": 1,
  "generatedAt": "…",
  "schedule": { "keys": 5, "rewards": 30, "float": 60, "tax": 15, "flywheel": 15, "coins": 30, "programs": 30 },
  "checks": {
    "keys": { "status": "ran", "ok": true, "finishedAt": "…", "alerts": [], "summary": { … } },
    …
  },
  "openAlerts": { "rewards": { "<alert text>": "<raised at>" } }
}
```

`ok` is `true` (no alerts), `false` (alerts open) or `null` (the check itself
failed to run, which says nothing about Sapling).

## `api/alerts.json`, `api/history.json`, `api/x-posts.json`

The last 500 alerts (`raised`, `resolved`, `withdrawn`), the last 500 check
results, and the last 200 posts zWatchtower wrote, newest first.
