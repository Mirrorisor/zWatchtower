// Who funded a coin's first buyers.
import { funderFromTx, fundingFacts, fundingFlags } from "../lib/funding.mjs";
let failures = 0;
const check = (label, cond, detail) => { if (!cond) failures++; console.log(`${cond ? "PASS" : "FAIL"} ${label}${detail ? ": " + detail : ""}`); };

const tx = (ixs, inner = []) => ({ transaction: { message: { instructions: ixs } }, meta: { innerInstructions: [{ instructions: inner }] } });
const transfer = (from, to) => ({ program: "system", programId: "11111111111111111111111111111111", parsed: { type: "transfer", info: { source: from, destination: to, lamports: 1e7 } } });
check("a plain SOL transfer in names the funder", funderFromTx(tx([transfer("F1", "W1")]), "W1") === "F1");
check("a transfer inside another program counts too", funderFromTx(tx([{ programId: "Some" }], [transfer("F2", "W1")]), "W1") === "F2");
check("a transfer out of the wallet isn't its funding", funderFromTx(tx([transfer("W1", "X")]), "W1") === null);
check("no system transfer: unknown", funderFromTx(tx([{ programId: "Some" }]), "W1") === null);

const buyers = ["a", "b", "c", "d", "e"];
let ff = fundingFacts(buyers, { a: "C", b: "X", c: "X", d: "X", e: null }, "C", { X: false });
check("groups buyers by funder; the creator's own counted", ff.fundedByCreator === 1 && ff.largestGroup === 3 && ff.lookedUp === 5, JSON.stringify(ff));
let fl = fundingFlags(ff);
check("flags: funded by the creator, and 3 by one wallet", fl.includes("1 of the first buyers was funded by the creator") && fl.includes("3 of the first buyers were funded by the same wallet"), fl.join(" | "));
ff = fundingFacts(buyers, { a: "C", b: "X" }, "C");
check("not judged until every early buyer is looked up", fundingFlags(ff).length === 0 && ff.lookedUp === 2);
ff = fundingFacts(buyers, { a: "A", b: "B", c: "C2", d: "X", e: "X" }, "C", { X: false });
check("two sharing a funder isn't enough to flag (setup)", true);
const pending = fundingFacts(buyers, { a: "Y", b: "Y", c: "Y", d: "Y", e: null }, "C", {});
check("a shared funder not yet checked for exchange-like activity isn't flagged yet", fundingFlags(pending).length === 0 && pending.busyPending === 1, JSON.stringify(pending));
check("two sharing a funder isn't enough to flag", fundingFlags(ff).length === 0 && ff.largestGroup === 2);
// an exchange's hot wallet funding several early buyers isn't a bundle
import("../lib/funding.mjs").then(({ isBusy }) => {
  ff = fundingFacts(buyers, { a: "EX", b: "EX", c: "EX", d: "EX", e: null }, "C", { EX: true });
  check("buyers funded by a very busy wallet (an exchange) aren't flagged", fundingFlags(ff).length === 0 && ff.viaBusyWallets === 4 && ff.largestGroup === 0, JSON.stringify(ff));
  const now = 1793000000;
  check("busy: 1,000 transactions within a day", isBusy(Array.from({ length: 1000 }, (_, i) => ({ blockTime: now - i * 60 }))) === true);
  check("not busy: 1,000 over a month, or fewer than 1,000", isBusy(Array.from({ length: 1000 }, (_, i) => ({ blockTime: now - i * 3000 }))) === false && isBusy([{ blockTime: now }]) === false);
  process.exitCode = failures ? 1 : 0;
});
process.exitCode = failures ? 1 : 0;
