# Corrections

When zWatchtower gets something wrong, it's fixed in the code and listed
here, newest first. Disputes are filed with the "Dispute a flag or fact"
issue form; each gets a public answer.

| Date (UTC) | What was wrong | Fix |
| --- | --- | --- |
| 2026-11-02 | Coins launched from a shielded Zcash wallet (Sapling shows "shielded launch" as the creator) were counted as one creator. | Shielded launches now have no public creator; nothing is said about their buys or sells (aea3563). |
| 2026-11-02 | Launch reading stopped near the launch and could skip trades in the same second at a page edge, undercounting launch buys. No posted figure changed. | History is read to its start and the boundary second re-read (b7e8c31). |
| 2026-11-02 | The coins page showed Sapling's list market cap, which overstates coins still on their launch curve. | Each coin's own page is used (b7e8c31). |
| 2026-11-01 | 19 flywheel alerts for buybacks routed through Jupiter, which Sapling started using that day. | Jupiter accepted as a buyback route (66c5e4b). |
| 2026-10-31 | 1,323 holder-reward alerts caused by the free Solana RPC refusing lookups, not by Sapling. | Refused lookups are notes, re-checked later; the alerts were withdrawn. |
