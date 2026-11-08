# How zWatchtower checks Sapling

Every check reads only public data: Sapling's public API and pages, the
Solana chain (through any RPC) and the Zcash chain (through 3xpl or your own
Zebra node). No viewing keys, no logins, no user tracking. Each check is one
script in this repo; each result is kept on the `status` branch, so any
finding can be traced to the run that made it.

**Reproduce any of it:** `git clone https://github.com/Mirrorisor/zWatchtower && cd zWatchtower && npm run once`
(Node 18+, no dependencies). Add `WATCHTOWER_SOLANA_RPC=<your RPC URL>` for
the on-chain parts; the free public RPC refuses some lookups.

**Lookups that fail are not findings.** A refused or timed-out lookup becomes
a note and is tried again next run; it is never reported as Sapling's fault.
Mistakes zWatchtower made are listed in [CORRECTIONS.md](../CORRECTIONS.md).

| Check | Reads | Says something is wrong when | Can't see |
| --- | --- | --- | --- |
| **keys** (`keys-check.mjs`) | The vault program's upgrade authority and last deploy slot; the vault config account; every vault and multisig transaction | The program is upgraded, its authority or config owner changes, the config changes (two self-updating fields excluded), or an admin-only instruction runs | Why an upgrade was made; the new code's behaviour (the binary is public, the source isn't) |
| **programs** (`programs-check.mjs`) | Every program run in transactions of Sapling's known wallets, and who can upgrade each; the Terminal guard's own trades | A program Sapling controls is upgraded, changes hands, or a new one appears. Reports Terminal tokens whose mint breaks the rules Sapling's docs give | Programs that never touch Sapling's known wallets. The guard's address is inferred (only other program the multisig controls, and it trades through Jupiter), not published by Sapling |
| **rewards** (`rewards-check.mjs`) | Each holder-reward run from Sapling's API: snapshot, eligibility prices, payout rows; the release and payout transactions. For coins that pay a basket of tokens, the swaps and token payouts on chain | The snapshot hash, $20 minimum, share formula `floor(pot × balance / sum)`, one row per holder, `pot = paid + rolledOver + rent`, `paid = confirmed shares − rent`, or the on-chain release don't hold. For a basket (rows list only the ZEC leg): every other token bought must go, all of it, to the same holders in proportion to their share, less at most a small flat cost for opening a holder's token account, and ZEC to holders plus ZEC swapped must match what Sapling says it paid | Holders Sapling left out of the snapshot entirely (the snapshot is checked against itself and its hash, not against every wallet). Whether a basket's swaps got a fair price |
| **float** (`float-check.mjs`) | Every Zcash order address, derived from the public keys Sapling publishes, and each forward out of them | ZEC held over the published caps, a payout stuck longer than an hour, or a forward going to a transparent address instead of the shielded pool | Where shielded ZEC goes after it is forwarded (that's what shielded means). Terminal sales are paid by NEAR Intents straight to the seller and are not followed |
| **tax** (`tax-check.mjs`) | Every Raydium coin's on-chain transfer-fee settings | The fee in force differs from what Sapling advertises, or a change is scheduled | Coins on other venues (they have no transfer fee to check) |
| **flywheel** (`flywheel-check.mjs`) | Every buy-and-burn Sapling lists, and every movement of the flywheel's tax pot; $SAPLING's supply | A listed burn isn't on chain as listed, or the pot doesn't reconcile to the zat. Reports Sapling's headline burn against the supply | Why a buyback was made. Sapling's burn list shows only recent burns, so its "bought back" headline is checked against every buyback the pot paid on chain instead |
| **coins** (`coins-check.mjs`) | Each coin's Sapling page and full trade history; its mint account; its largest holders | Facts past a published line become flags: creator's launch buy over 5%, creator sold over 50%, others buying over 10% in the first 10 s, top 10 wallets over 50%, mint or freeze authority, a creator who sold out of most of their other coins, any first-10-s buyer funded by the creator, or 3+ first buyers funded by one wallet (each buyer's first SOL deposit, from its oldest transaction; an exchange wallet doesn't count: either on the short list of labelled exchange wallets in lib/funding.mjs, each with its source, or a very busy funder, 1,000 transactions within a day) | Who is behind a wallet; coins launched from a shielded Zcash wallet have no public creator; holders who split across many wallets look like many holders; a buyer funded through an exchange or a chain of wallets looks independent; very old, busy wallets' first deposit can't be reached and counts as unknown |

**Fee recipients** (`payees-check.mjs`, hourly). Every coin's record: whether its fee share goes to the Zcash Foundation, holder rewards, a wallet or the creator, and the totals paid. Sapling's docs say donating and holder rewards are permanent; an alert if a coin stops, if a paid total goes down, or if the coins' donations stop adding up to Sapling's platform total. A recipient change on a coin over $10k is posted as news. Can't see: the last hop of a donation, which is sent shielded to the Zcash Foundation (by design, nobody can see it).

**Creator dumps.** Coins under two days old are re-read every run (older ones daily). When the creator of one bought at least 2% of supply at launch and has sold 90% or more of it, zWatchtower posts it once, with how long after launch the sells passed 90%. Coins of any size are covered, not only those over $10k.

**Flags are facts, not verdicts.** Early buyers can be bots or fast real
buyers; a creator selling can be planned. The cards say what happened on
chain and leave the judgement to the reader. Anyone can dispute a flag with
the "Dispute a flag or fact" issue form, and every dispute gets a public answer.

**Pairing tokens.** Sapling coins can be paired with tokenized stocks
(xStocks and Backpack Securities tokens such as NVDAx, TSLAx and SPYx) and a
few other tokens. Sapling's multisig sets that list on chain (SetStockQuote:
one config account per token, owned by the vault program); Sapling's docs
say fee conversions are checked against Pyth. Every 30 minutes
the pairing tokens check (quotes-check.mjs) reads every config account and
each token's issuer controls, and posts when Sapling adds, removes or changes
a token, when an issuer pauses or unpauses one, when who can freeze, pause,
create or move a token changes, or when a balance multiplier (a split) is
scheduled. On 8 Nov 2026 there were 47; every tokenized stock's issuer can
pause it, freeze accounts and move tokens out of any account.
It also logs every conversion of Sapling's fees in such a token into ZEC
(ConvertStockEnd): the token sold, the ZEC received, the dollar price when the
swap went through USDC, and the program's own minimum and floor, and alerts
if a conversion ever received less than either. It can't yet say whether the
price was fair: Pyth's price service now needs an API key, and the conversion
transactions read no Pyth price on chain. (The floor sat 4–13% below the ZEC
received in the conversions we read by hand.)

**Liquidity.** Sapling's docs say its liquidity is one protocol-owned
$SAPLING/ZEC pool on PumpSwap (6ejg4a…K51G) whose LP tokens "are burned the
moment they are minted, so nobody can ever pull it". Every 15 minutes the
liquidity check (liquidity-check.mjs) reads the pool and its LP token
(4A2HF1…MtBW) on chain and alerts if any LP token exists (whoever held it
could withdraw that share), if anyone but the pool can create LP tokens, if
the LP token can be frozen, or if the pool's tokens change. It also records
where the pool's creator fee goes (Sapling's treasury, as the docs say). On
8 Nov 2026 the LP token's supply was 0: all 682.06 LP shares the pool has
issued had been burned.

**The "90% back" claim.** Sapling's company site (sapling.llc) says "Ninety
percent of every fee goes back to the people who use Sapling, paid in ZEC.
Always." and sapling.cash/stats lists where the fees went, with "Sapling's
10%" as one line. Every hour the split check (split-check.mjs) reads that
breakdown (from the stats page itself, since the API carries only some lines)
and works out Sapling's share of everything that has reached a
destination (fees still waiting in the pots are left out). The claim "holds"
when that share rounds to 10% or less, is "close" under 11%, and "does not
hold" above. It then checks the lines we measure ourselves: paid to holders
(the sum of every coin's holder-rewards total), received by the Zcash
Foundation (the sum of every coin's donations) and bought back by coins'
flywheels (the flywheel check's on-chain total), each within 2%. Paid to
deployers and payees is a lower bound only, since deployers can be paid
outside the coin records. Not yet measured independently: liquidity, the
$SAPLING buyback in ZEC (the tokens burned are checked by the flywheel check)
and Sapling's own share. Fields are found by name; the ones used are listed
in api/split.json, and a line that can't be found is reported, never guessed.

**Independence.** zWatchtower is not affiliated with Sapling. Its builder
launched $ZWATCH on Sapling (one wallet, 0.34%, disclosed in the README),
and alerts are never softened because of it. Posts about a coin competing
with $ZWATCH in Sapling's Race to $1M say so up front.
