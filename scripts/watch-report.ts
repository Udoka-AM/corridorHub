/**
 * Read-only mode: watch Stellar accounts Corridor does not control, match
 * what they did against the books, and print the exceptions. This is the
 * first thing a Hub customer runs — it moves no money (ADR 0011).
 *
 *   CORRIDOR_WATCH=GABC…,GDEF… pnpm watch:report
 */
import { summarize } from "@corridor/recon";
import { reconcile } from "@corridor/recon";
import { horizonPayments, StellarObserver } from "@corridor/chain-stellar";
import { NETWORK, openRuntime, reader } from "./runtime.ts";

const accounts = (process.env.CORRIDOR_WATCH ?? "").split(",").map((a) => a.trim()).filter(Boolean);
if (accounts.length === 0) throw new Error("set CORRIDOR_WATCH to one or more Stellar account ids");

const rt = await openRuntime();
try {
  const client = reader();
  const observer = new StellarObserver(horizonPayments(client.server), {
    name: "watch",
    network: NETWORK,
    accounts,
    cursors: rt.cursors,
    unreferenced: true,
  });

  const seen = await observer.poll();
  const results = await reconcile(rt.ledger, seen);
  console.log(`${seen.length} movements on ${accounts.length} account(s) · ${NETWORK}`);
  console.table(summarize(results));
  for (const r of results.filter((x) => x.status !== "matched")) {
    console.log(`${r.status.padEnd(16)} ${r.observation.externalRef} ${r.observation.asset} ${r.observation.amount}`);
  }
} finally {
  await rt.close();
}
