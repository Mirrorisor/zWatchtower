<img src="public/logo.png" alt="zWatchtower" width="120">

# zWatchtower

[![tests](https://github.com/Mirrorisor/zWatchtower/actions/workflows/test.yml/badge.svg)](https://github.com/Mirrorisor/zWatchtower/actions/workflows/test.yml)

An open-source watchdog for [Sapling](https://sapling.cash), the Zcash-native
launchpad on Solana. Six independent checks turn what Sapling users would
otherwise take on trust into public, repeatable checks. They read only public
chain data and Sapling's own published files: no viewing keys, no user
addresses, nothing signed, nothing needed from Sapling.

## Independence

zWatchtower is not affiliated with Sapling. Every check is code in this repo
and every result can be reproduced by running it.

### The $ZWATCH coin

zWatchtower has a coin on Sapling: [$ZWATCH](https://sapling.cash/coin/9Kz9RmVm8tqXRLZDRxaPZm2tkhjCrp7X8RUz1Ayzcash)
(mint `9Kz9RmVm8tqXRLZDRxaPZm2tkhjCrp7X8RUz1Ayzcash`), launched 1 Nov 2026 12:17 UTC on Raydium LaunchLab and
entered in Sapling's Race to $1M privacy tech track.

- **Its 1% creator share goes to the Zcash Foundation, permanently.** That was
  set on chain at launch; nobody, the team included, can redirect it.
- **The team's holding:** the launch wallet `4KPboYtTrodVbHqJQWVyRybCfzuj7iT3FoUHNpEiuuDQ`
  bought 3,353,573 ZWATCH (0.34% of supply) for 0.0079862 ZEC at launch. Any
  change is posted here first. The team holds no other wallet: the 0.96% bought
  3 seconds after launch by `6bD2YsuNF2MjMdYiLHRzmHswx3BzmtRgkFhJuBF6czBs` was
  someone else.
- **Same rules as every Sapling Raydium coin:** 3% transfer tax (Sapling's 2%
  + the 1% above), no mint or freeze authority, and, like 59 of Sapling's 61
  other Raydium coins, Sapling's program can still change the tax rate.
  zWatchtower's tax check watches $ZWATCH like any other coin.
- **The coin changes nothing about the checks.** Alerts about Sapling are never
  held back or softened, including ones that could hurt the coin's price.

## The checks

- `rewards-check.mjs`: re-checks every holder-reward run.
- `float-check.mjs`: finds every Zcash order address Sapling pays out from,
  and checks the ZEC held there against the published caps.
- `keys-check.mjs`: alerts when the vault program is upgraded, its config
  changes, or a privileged or multisig action happens.
- `tax-check.mjs`: checks each Raydium LaunchLab coin's on-chain transfer fee
  against the tax Sapling advertises, and alerts on any scheduled change.
- `flywheel-check.mjs`: checks every buy-and-burn Sapling lists against the
  chain, and accounts for every movement of the flywheel's tax pot.
- `coins-check.mjs`: a safety report card for every Sapling coin worth
  $10,000 or more (see "Coin report cards" below).

Node 18 or later, no dependencies.

# Live on GitHub

`.github/workflows/watch.yml` runs every 15 minutes on GitHub Actions: it runs
each check whose interval has passed (`--once --due`), saves every result to
the `status` branch, and publishes the dashboard to GitHub Pages at
https://mirrorisor.github.io/zWatchtower/. Alerts go to the webhook in the
`WATCHTOWER_WEBHOOK` repository secret (Slack, or Discord with `/slack` on the
end of the webhook URL). GitHub can start scheduled runs a few minutes late.

Solana's free public RPC often limits GitHub's servers. Lookups it refuses are
never reported as findings: the check notes them and tries again next run.
For faster, complete runs, put a private RPC URL (Helius, Triton, QuickNode;
free tiers work) in the `WATCHTOWER_SOLANA_RPC` secret.

## Coin report cards

`coins-check.mjs` keeps a report card for every Sapling coin with a market
cap of $10,000 or more (`--min-mcap-usd`; the figure on the coin's own page
decides, since Sapling's coin list overstates coins still on their launch
curve; a coin that falls under the line loses its card), published at https://mirrorisor.github.io/zWatchtower/coins.html. Each card
is facts plus a flag when a fact crosses a line (`lib/coins.mjs`):

| Fact | Source | Flagged when |
| --- | --- | --- |
| Creator's buy at launch, % of supply | Sapling trades | over 5% |
| Creator has sold, % of what they bought | Sapling trades | over 50% |
| Other wallets' buys in the first 10 seconds, % of supply | Sapling trades | over 10% |
| Top 10 wallets' share (pools, curves and program accounts left out) | Solana | over 50% |
| Mint or freeze authority | Solana | either is set |
| Tax rate still changeable, where the creator fee goes | Solana, Sapling | noted, not flagged |

Flags are facts, not verdicts. Where Sapling's trade history doesn't reach
back to a coin's launch, launch facts are left blank rather than guessed.
Each run refreshes 40 cards (new coins first, then the stalest), so the
public RPC's limits are respected; market cap and holders refresh every run.

### Who funded the first buyers

A creator can launch without buying from their own wallet, then buy through
wallets they funded ("bundling"). For every coin with a card, the check looks
up who first sent SOL to each wallet that bought in the first 10 seconds
(that wallet's oldest transaction; looked up once and kept), and flags the
coin when any was funded by the creator, or when 3 or more share one funder.

### Creator track records and badges

Every Sapling coin, not only the ones over $10,000, is read once a day: who
launched it, and whether they sold out (sold at least 90% of what they
bought). A card shows the creator's other coins, and is flagged when the
creator sold out of at least two of them and most of those checked. A coin
launched in the last day by such a creator is posted as a warning, once, as
is any new coin that takes the name of an older coin worth $10,000 or more
(a copycat), whoever launched it.
The coins page lists creators with more than one coin, and `creators.html`
has a page for every creator (`creators.html#<wallet>`, data in
`api/creators.json`): each coin they launched, what they bought at launch and
how much they sold.

Every coin with a card has a badge at `badges/<mint>.svg`, with an embed
snippet on the coins page that links to the coin's page on the public site
(https://zwatchtower.lovable.app/coin/<mint>): green for no flags,
amber for one or two, red for three or more, grey while the launch hasn't
been read.

### Sapling's programs

`programs-check.mjs` reads the transactions of Sapling's own wallets
(treasury, rewards, buyback, liquidity, flywheel pot, admin and the multisig
vault that upgrades its code), lists every program they run, and reads who can
upgrade each. Programs Sapling controls (upgrade authority = its multisig
vault or admin) are watched: any upgrade, any change of control, and any new
one appearing is an alert. Sapling publishes only its vault program's address;
the Terminal's `sapling_accounts` guard, which holds Terminal users' tokens,
is found this way and marked by its trades through Jupiter. The vault's own
upgrades stay with `keys-check.mjs`.

It then reads the guard's own transactions, picks out the token each
Terminal trade bought or sold (the one the trade's holding only received or
only sent; pools, routes and the ZEC payment both send and receive), and
checks each token's mint against what Sapling's docs say the guard refuses:
a freeze authority, a permanent delegate, pausing, accounts frozen by
default, non-transferable tokens, transfer hooks, or a transfer fee over 5%.
Tokens outside those rules are reported; they become alerts once the way
tokens are picked out has been checked on live data.

### Privacy of payouts

The float check also looks up every forward out of Sapling's Zcash order
addresses and counts how many went to a shielded pool and how many to a
transparent address, since Sapling says each is forwarded "as a shielded
note". The pool names 3xpl reports are listed with the counts so the
classification can be checked. First live run (2 Nov 2026): 14 of 14
forwards went to the shielded pool. A forward to a transparent address is an
alert. Terminal sales are paid out by NEAR Intents
straight to the seller's wallet and, per Sapling's docs, are not shielded;
zWatchtower doesn't follow those, since that would mean tracking users.

### Weekly report

`report.html` sums up the last seven days: every code upgrade and change of
control, payouts forwarded shielded, buybacks verified, coin taxes, reward
runs, Terminal tokens, flagged coins and new-coin warnings, and any problem
still open. Failed lookups and alerts zWatchtower withdrew are left out, since
they were its own mistakes. The data is `api/report.json`; a one-line summary
is written to the posts feed each Monday.

### Public data and disputes

How every check works, what it can't see, and how to reproduce it:
[docs/METHODOLOGY.md](docs/METHODOLOGY.md). Everything on the dashboard is
free JSON anyone can build on, documented and versioned in
[docs/API.md](docs/API.md). Think a flag is wrong? Use the
"Dispute a flag or fact" issue form (linked from every card). Every dispute
gets a public answer; mistakes are fixed and listed in
[CORRECTIONS.md](CORRECTIONS.md).

### Coin changes

Each run compares every card with the last one and posts what changed, once:
a creator selling past half of what they bought (or selling the rest), the
top 10 wallets passing 50%, a mint or freeze authority appearing, and a
flagged coin passing $10,000. These go to X and the webhook like alerts, are
listed under "Recent changes" on the coins page, and are logged in
`coin-events.jsonl`. Launch facts appearing once a long history finishes
reading are not posted: the launch didn't change, the reading caught up.

## Posting alerts to X

New findings are posted to X automatically: program upgrades (with how fast
they were caught), admin instructions (grouped by name), and any check that
finds something wrong, plus a post when it clears. Routine multisig proposal
and approval steps are not posted. At most 3 posts a run and 10 a day; over
that, one post says how many more.

Without X keys it only previews: every post it would have made is logged in
`x-posts.jsonl` on the `status` branch and at `api/x-posts.json` on the
dashboard. To post for real, add four repository secrets from an app in the
X Developer Console (OAuth 1.0a, Read and Write): `X_API_KEY`,
`X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_SECRET`. Optional repository
variables: `X_DAILY_SUMMARY=1` for one status post a day, `X_INCLUDE_LINKS=1`
to add the dashboard link (X charges more for posts with links).

# Run the service

`watchtower.mjs` runs all six checks on their own schedules, keeps the
results, posts each alert once to a webhook, and serves the dashboard.

```
cp watchtower.config.example.json watchtower.config.json   # edit as needed
npm start                     # dashboard on http://localhost:8787
npm run once                  # every check once, then exit (for cron)
npm test                      # all offline tests
```

Default schedule: keys every 5 minutes, coin taxes and the flywheel every 15, rewards every 30, float every 60.
The rewards check is incremental after its first full pass: each pass re-checks
the last 5 runs plus any new ones, and failures from older runs stay open.

Alerts are posted once when they appear and once when they clear. A check
that fails to run (an RPC outage, say) shows as "check failed" and leaves
alerts as they were, so an outage is never reported as a problem with Sapling.

| Path | What |
| --- | --- |
| `/` | dashboard |
| `/api/status` | latest result of each check, open alerts |
| `/api/history?check=keys&limit=20` | past results, newest first |
| `/api/alerts` | alerts raised and resolved, newest first |
| `/healthz` | liveness |

Config (`watchtower.config.json`): `solanaRpc` (a private RPC avoids public
rate limits), `webhook` (Slack or Discord-style, receives `{ "text": … }`),
`threexplKey` or `zebra` for the float check, `squadsMultisig` to watch
upgrade proposals, and per-check `everyMinutes`.

Data lives in `dataDir`: `state.json`, `history.jsonl`, `alerts.jsonl`, and the
keys check's baseline `keys-state.json`. Delete them to start fresh.

# Float check

Sapling's shielded payouts land at a one-time transparent "order address" and
are forwarded as a shielded note minutes later. Order addresses are derived
from the two account public keys in
`https://sapling.cash/.well-known/sapling-exits.json` (stamps SPEC §10.1), so
`lib/derive.mjs` can list them all.

```
node float-check.mjs                    # 3xpl sandbox API, full history
node float-check.mjs --api-key KEY      # paid 3xpl API, much faster
node float-check.mjs --source zebra --zebra http://127.0.0.1:8232   # own node
```

Reports the current float against the custody cap (200 ZEC) and in-flight cap
(50), any payout not forwarded within `--stuck-minutes` (default 60), hold
times, and the peak float ever reached. Exit code 1 if anything is stuck or
over a cap.

Derivation is checked against the BIP32 test vector and against Sapling's own
certificate for order address 18 (t1auBszcWwx8MCYKDkGNxEcD4WZgK81E34s).

## First results (2026-10-28, indexes 0–59 of both keys)

- 14 used order addresses (6 for sales and sends, 8 for Zcash accounts),
  matching Rings' 14 shielded exits.
- 2.29777685 ZEC delivered; less 14 × 0.00015 network fee = 2.2957 ZEC,
  exactly Rings' "delivered, shielded" figure.
- Current float 0; nothing stuck. Peak float 0.5717 ZEC (2 Oct).
- Hold times: 1.6–5.7 minutes for sales and sends, 20.6–25.2 minutes for
  Zcash accounts.
- Zcash Foundation donation sends come from addresses that are not derived
  from either published key, so they are outside this check.

# Keys check

```
node keys-check.mjs --rpc https://api.mainnet-beta.solana.com
node keys-check.mjs --rpc URL --state keys-state.json --webhook https://hooks.example/...
node keys-check.mjs --rpc URL --squads-multisig <Squads multisig account>
```

Run it on a schedule (every few minutes, from cron or similar). The first run
records a baseline in the state file; each later run compares against it.

It alerts when:

- the vault program's upgrade authority is not the published Squads vault
  (3eCXkz…57sMtf; 2 of 4 members must approve on chain, Sapling's docs say
  2-of-3), or the program is frozen
- the vault program is redeployed (its last-deploy slot changes)
- the vault Config account changes: reports which known wallets (treasury,
  rewards, buyback, LP wallet) appeared or disappeared, and which bytes moved
- the config account is not owned by the vault program
- a privileged vault instruction runs (retire_roots, set_lp, init_donation,
  set_donation, pause_donations, set_zec_payees, pause_zec_payees)
- a Squads proposal is created, activated, approved
  or executed, so an upgrade is visible before it lands

- the multisig's members, threshold or time lock change

Instruction names come from Anchor's "Instruction: Name" log lines, with the
discriminator table as a fallback. Routine keeper work (settle,
observe_sapling, release_rewards, close_rewards_run, roots_to_pot, draw_lp,
draw_donation, draw_zec_payee) is counted, not alerted. Anything run through
the multisig or signed by the admin is privileged, named or not. Other
unrecognised names are listed; config changes they make are still caught by
the config fingerprint. `--webhook` posts alerts as JSON `{ "text": ... }`,
which Slack and Discord-style webhooks accept.

The multisig account (7f4Yok…X59) is watched by default; `--no-squads` skips it.

## First live run (2026-10-29)

- Config account 8z2Rv1…QyRy is owned by the vault program and holds the
  treasury, rewards, buyback, LP wallet and LP pot, plus the admin
  (5H1gfdDcrtPq7V11uh457dHjZ75caZv6xNd7CeBiPAaV, offset 8) and recovery
  (Dpyf8nA6xPSTnjaX7K3hgq3uPJncJSJRtYjudPHoCwuv, offset 169) keys.
- Upgrade authority is the Squads vault 3eCXkz…57sMtf, as published.
- Upgrade history: initial deploy 2026-09-25, then 8 upgrades, all through
  the multisig; the latest 2026-10-29 04:28 UTC.
- The multisig is **2-of-4** with no time lock, and the admin key is a member.
  Sapling's docs say 2-of-3.
- The multisig has run `SetStockQuote` on the vault, an admin action the docs
  don't list.

Tests: `node test/keys-tests.mjs` (19 cases).

# Rewards check

Independently re-checks every Sapling holder-reward run from public data.
It reads `https://sapling.cash/api/rewards/<id>` and, optionally, a Solana RPC.

## Telegram bot

`telegram-bot.mjs` answers `/check TICKER` (or a coin address) with the
coin's report card, warns when other coins use the same name, and posts
everything zWatchtower writes to the posts feed (alerts, coin warnings, the
daily summary) to an alert channel. It long-polls Telegram, so the server
opens no ports. On a server set up as above:

```sh
curl -fsSL https://raw.githubusercontent.com/Mirrorisor/zWatchtower/main/deploy/setup-bot.sh -o setup-bot.sh && bash setup-bot.sh
```

## Run it every 5 minutes on a server

GitHub starts scheduled runs 30–60 minutes apart. On a small Ubuntu 24.04
server (a US$6 DigitalOcean droplet is plenty), as root:

```sh
curl -fsSL https://raw.githubusercontent.com/Mirrorisor/zWatchtower/main/deploy/setup-server.sh -o setup.sh && bash setup.sh
```

It installs Node, asks for the Solana RPC URL and webhook (kept in
`/etc/zwatchtower.env`, readable only by the service), prints a deploy key to
add to the repo with write access, and starts a 5-minute timer
(`deploy/run.sh`). Each round runs the checks that are due, pushes results to
the `status` branch and the dashboard to the `gh-pages` branch. Set GitHub
Pages to serve `gh-pages` (Settings → Pages → Deploy from a branch).

## Run it

```
node rewards-check.mjs                                   # every run, API checks
node rewards-check.mjs --rpc https://api.mainnet-beta.solana.com   # plus on-chain checks
node rewards-check.mjs --from 1000 --to 1071 --json > report.json
```

Node 18 or later. Exit code 1 means at least one run failed a check.

## What it checks

For each run:

1. `sha256(JSON.stringify(snapshot))` equals the published `snapshotHash`
2. every holder is worth at least $20 at the run's own recorded prices
3. every share is `floor(pot × balance / Σ balances)`
4. one payout row per snapshot holder, no extras
5. `pot = paid + rolledOver + rentZec`
6. `paid = confirmed shares − rent`
7. with `--rpc`: the release transaction exists, succeeded, moved exactly the pot
   to the rewards wallet, and its event data carries the snapshot hash

## Not yet checked

- That the snapshot's balances match the chain at `snapshotSlot`, and that no
  eligible holder was left out. Needs historical token balances, which public
  Solana RPCs don't serve; an indexer or archive node is required.
- The source of the keeper's prices (`zecPerToken`, `zecUsd`).

## Tests

```
node test/run-tests.mjs     # rewards check
node test/float-tests.mjs   # float check
node test/keys-tests.mjs    # keys check
```

Uses real runs captured on 2026-10-28 plus tampered copies; each tampered copy
must be caught.

## First results (2026-10-28, run in a browser against the live API)

- 1,071 runs published; 1,070 pass checks 1–6.
- Run 845 ($ZDOG, 2026-10-22) is marked failed with no pot, but lists a release
  signature that does not exist on Solana. No ZEC moved; the record is stale.
- Spot check of run 1070's release on chain: it moved exactly its pot,
  0.0210818 ZEC, to the rewards wallet.


# Tax check (Raydium LaunchLab coins)

Since 2026-10-29, new Sapling coins launch on Raydium LaunchLab as Token-2022
mints. Each carries a transfer fee (the "tax", 2–5%) that Sapling's vault
program withdraws, partly sells for holder rewards and partly uses for
flywheel buybacks (`WithdrawTax`, `SellTax`, `DrawGrove`, ...).

```
node tax-check.mjs --rpc https://api.mainnet-beta.solana.com --state data/tax-state.json
```

For every LaunchLab coin listed by `/api/coins` (and any coin seen before):

1. the mint is owned by Token-2022, with no mint or freeze authority
2. no risky extensions: permanent delegate, transfer hook, pausable, default
   account state, non-transferable, close authority, confidential transfers
3. the fee in force this epoch equals the advertised `taxBps`
4. no different fee is scheduled for a later epoch (Token-2022 applies a new
   fee two epochs after it is set, about four days, so this is the warning window)
5. the fee withdraw authority is Sapling's vault PDA `69nv6e…GLEY`, and the
   fee config authority is either none or the vault PDA `WLHv2U…VJh`

## First live run (2026-10-29, epoch 1071)

- 16 LaunchLab coins; all 16 charge exactly the advertised tax; no change
  scheduled; no mint or freeze authority; no risky extensions.
- Both authorities are program-derived addresses (off the ed25519 curve), so
  only the vault program, upgraded through the multisig, can use them.
- On 15 of 16 coins the fee config authority is still set, so the rate can be
  changed. `maximumFee` is unlimited. Only the graduated coin has renounced it.
- Sapling's docs do not yet describe the Raydium launches or the flywheel.


# Flywheel check (buy back and burn)

Sapling says a share of every trade "buys back and burns the top 10 Sapling
coins". On chain this works as follows:

- Coin taxes, in ZEC on Solana (`A7bdiY…QXaS`), are paid into a pot held by a
  vault PDA (`Df8mXW…2PYa`, token account `Eqg9vQ…5kkF`) by the vault
  instruction `SettleTax`.
- Each buyback is one transaction: `DrawGrove` moves ZEC from the pot to the
  buyback wallet `7fAC78…f9Pdu`, which buys the coin on Raydium CPMM, Raydium
  LaunchLab or the pump AMM and burns everything it bought; `CloseGrove`
  returns any unspent ZEC to the pot.

```
node flywheel-check.mjs --rpc https://api.mainnet-beta.solana.com --state data/flywheel-state.json
```

It checks:

1. every burn in `/api/flywheel/live`: the transaction succeeded, called only
   the expected programs, ran `DrawGrove … CloseGrove`, the pot paid exactly the
   listed ZEC, the listed amount of the listed coin was burned, and the buyback
   wallet ended with no ZEC and none of the coin
2. every transaction on the pot account is a `SettleTax` inflow or a
   `DrawGrove … CloseGrove` buyback; anything else that moves the pot is an alert
3. the pot's balance equals the sum of every movement since it was created,
   and the balance Sapling shows
4. the keys that sign settlements and buybacks don't change unannounced

## First live run (2026-10-29 11:08 UTC)

- 20 burns listed, 20 confirmed on chain exactly as listed: 14 on the pump
  AMM, 5 on Raydium CPMM, 1 on LaunchLab. Coins: ZILLIONS, 0, BLACKCAT, all in
  the current top 10.
- The pot has had 370 transactions since it was created through the multisig
  on 2026-10-28 16:58 UTC: 349 `SettleTax` deposits from 14 coins'
  tax accounts (0.76977236 ZEC), 20 buybacks (0.76974978 ZEC out). The
  remaining 2,258 zat is the balance on chain and the balance Sapling shows.
  Sapling's headline "bought back" figure matches the outflow exactly.
- The coins burned are net of each coin's own transfer tax (Raydium coins
  burn about 5% less than the pool sent).
- One buyback (ZILLIONS, 0.62 ZEC) is 81% of everything bought back so far.

## Worth asking Sapling

- The buyback wallet `7fAC78…` is an ordinary key, not a program address. It
  briefly holds the pot's ZEC and the bought coins inside each transaction.
  Does `CloseGrove` check that the burn happened, or could that key keep the
  coins? Every past buyback burned everything; the check would catch one
  that didn't, but only after the fact.
- How is a coin's tax split between holder rewards and the flywheel pot?
- How is "top 10" decided at the moment of a buyback? The rank isn't
  recorded on chain, so it can't be checked historically.
