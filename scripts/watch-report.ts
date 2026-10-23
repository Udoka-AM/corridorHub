/**
 * Read-only mode: watch Stellar accounts Corridor does not control, match
 * what they did against the books, and print the exceptions. This is the
 * first thing a Hub customer runs — it moves no money (ADR 0011).
 *
 *   CORRIDOR_WATCH=GABC…,GDEF… pnpm watch:report
 */
import { summarize } from "@corridor/recon";
import { reconcile } from "@corridor/recon";
import { horizonPayments, sacContractId, StellarEventObserver, StellarObserver } from "@corridor/chain-stellar";
import { rpc } from "@stellar/stellar-sdk";
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

  // A classic asset moved by a contract — a CCTP mint, a Soroban app paying in
  // — never appears in Horizon's payment stream, so the SAC's own events are
  // the second half of the picture. Soroban RPC has no public mainnet
  // endpoint, so mainnet needs CORRIDOR_SOROBAN_RPC_URL.
  const sorobanUrl = process.env.CORRIDOR_SOROBAN_RPC_URL ?? (NETWORK === "testnet" ? "https://soroban-testnet.stellar.org" : undefined);
  let fromEvents: Awaited<ReturnType<typeof observer.poll>> = [];
  if (sorobanUrl) {
    const events = new StellarEventObserver(new rpc.Server(sorobanUrl) as never, {
      name: "watch-events",
      network: NETWORK,
      contracts: { USDC: sacContractId("USDC", NETWORK) },
      accounts,
      cursors: rt.cursors,
    });
    fromEvents = await events.poll();
  } else {
    console.log("no Soroban RPC configured, so contract-moved payments are not covered; set CORRIDOR_SOROBAN_RPC_URL");
  }
  const results = await reconcile(rt.ledger, [...seen, ...fromEvents]);
  console.log(`${seen.length} payment(s) and ${fromEvents.length} contract transfer(s) on ${accounts.length} account(s) · ${NETWORK}`);
  console.table(summarize(results));
  for (const r of results.filter((x) => x.status !== "matched")) {
    console.log(`${r.status.padEnd(16)} ${r.observation.externalRef} ${r.observation.asset} ${r.observation.amount}`);
  }
} finally {
  await rt.close();
}
