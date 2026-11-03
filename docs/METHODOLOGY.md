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
| **rewards** (`rewards-check.mjs`) | Each holder-reward run from Sapling's API: snapshot, eligibility prices, payout rows; the release and payout transactions | The snapshot hash, $20 minimum, share formula `floor(pot × balance / sum)`, one row per holder, `pot = paid + rolledOver + rent`, `paid = confirmed shares − rent`, or the on-chain release don't hold. When shares are off, it records what holders received on chain | Holders Sapling left out of the snapshot entirely (the snapshot is checked against itself and its hash, not against every wallet) |
| **float** (`float-check.mjs`) | Every Zcash order address, derived from the public keys Sapling publishes, and each forward out of them | ZEC held over the published caps, a payout stuck longer than an hour, or a forward going to a transparent address instead of the shielded pool | Where shielded ZEC goes after it is forwarded (that's what shielded means). Terminal sales are paid by NEAR Intents straight to the seller and are not followed |
| **tax** (`tax-check.mjs`) | Every Raydium coin's on-chain transfer-fee settings | The fee in force differs from what Sapling advertises, or a change is scheduled | Coins on other venues (they have no transfer fee to check) |
| **flywheel** (`flywheel-check.mjs`) | Every buy-and-burn Sapling lists, and every movement of the flywheel's tax pot; $SAPLING's supply | A listed burn isn't on chain as listed, or the pot doesn't reconcile to the zat. Reports Sapling's headline burn against the supply | Buybacks Sapling doesn't list (its headline total is larger than the listed burns; noted, not alerted) |
| **coins** (`coins-check.mjs`) | Each coin's Sapling page and full trade history; its mint account; its largest holders | Facts past a published line become flags: creator's launch buy over 5%, creator sold over 50%, others buying over 10% in the first 10 s, top 10 wallets over 50%, mint or freeze authority, a creator who sold out of most of their other coins, any first-10-s buyer funded by the creator, or 3+ first buyers funded by one wallet (each buyer's first SOL deposit, from its oldest transaction; an exchange wallet doesn't count: either on the short list of labelled exchange wallets in lib/funding.mjs, each with its source, or a very busy funder, 1,000 transactions within a day) | Who is behind a wallet; coins launched from a shielded Zcash wallet have no public creator; holders who split across many wallets look like many holders; a buyer funded through an exchange or a chain of wallets looks independent; very old, busy wallets' first deposit can't be reached and counts as unknown |

**Flags are facts, not verdicts.** Early buyers can be bots or fast real
buyers; a creator selling can be planned. The cards say what happened on
chain and leave the judgement to the reader. Anyone can dispute a flag with
the "Dispute a flag or fact" issue form, and every dispute gets a public answer.

**Independence.** zWatchtower is not affiliated with Sapling. Its builder
launched $ZWATCH on Sapling (one wallet, 0.34%, disclosed in the README),
and alerts are never softened because of it. Posts about a coin competing
with $ZWATCH in Sapling's Race to $1M say so up front.
