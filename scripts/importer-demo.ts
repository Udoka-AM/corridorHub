/**
 * The reverse flow on testnet: a Nigerian importer pays a supplier in China.
 *
 *   pnpm importer:demo
 *
 *   1. collection: partner opens a one-off naira virtual account; the importer
 *      pays ₦; the partner delivers USDC; USDC crosses into the Tempo hub (real
 *      Tempo leg from the bridge escrow); the importer's pathUSD balance is credited
 *   2. payout: from that hub balance to the supplier in CNY through a payout
 *      partner (NGN-CNY corridor)
 *
 * Both sagas run on the same ledger, the same route planner and the same
 * reconciliation as payouts into Africa: the hub-and-spoke network in action.
 */
import { RefKind, customerTag, encodeRef, formatMoney, uuidv7, type CorridorCode } from "@corridor/core";
import { explorerTx } from "@corridor/chain-tempo";
import type { CollectionData } from "@corridor/legs";
import { reconcile, summarize } from "@corridor/recon";
import { planRoute } from "@corridor/routing";
import type { PayoutData } from "@corridor/saga";
import { partnerObservation } from "@corridor/webhooks";
import { testnetKey } from "./env.ts";
import { startRuntime } from "./runtime.ts";

const IMPORTER = "adeola-imports";
const CORRIDOR: CorridorCode = "NGN-CNY";
const tag = customerTag(IMPORTER, testnetKey("CORRIDOR_REF_SECRET"));

const rt = await startRuntime({
  onCollectionOpened: async (order, mock) => {
    const va = order.virtualAccount!;
    console.log(`  virtual account for the importer: ${va.bank} ${va.accountNumber} (${va.accountName}), pay ₦${(Number(order.fiatAmount) / 100).toLocaleString("en-NG")}`);
    // The importer pays from their own bank app a few seconds later.
    setTimeout(() => void mock.payerTransferred(order.id), 3_000);
  },
});
const { ledger, accounts, engine } = rt;

// ---- 1. collect ₦1,560,000 into the importer's hub balance ----
const collectionPlan = planRoute({
  corridor: CORRIDOR,
  purpose: "collection",
  privacy: "public",
  source: { venue: "partner_fiat", asset: "NGN" },
  destination: { venue: "tempo", asset: "pathUSD" },
  env: "testnet",
});
const collection: CollectionData = {
  collectionId: uuidv7(),
  customerId: IMPORTER,
  corridor: CORRIDOR,
  currency: "NGN",
  fiatAmount: "156000000", // ₦1,560,000.00
  reference: encodeRef({ kind: RefKind.Collection, corridor: CORRIDOR, shielded: false, id: uuidv7(), customerTag: tag }),
  tempoStartBlock: rt.startBlock.toString(),
};
console.log(`\ncollection  ${collectionPlan.steps.map((s) => s.kind).join(" → ")}`);
const cid = await engine.start({ kind: "collection", reference: collection.reference, plan: collectionPlan, data: collection });
const cStatus = await engine.run(cid);
const cView = await engine.get(cid);
const collected = cView.steps[0]!.output as Record<string, string>;
const bridgeIn = cView.steps[1]!.output as Record<string, string>;
console.log(`  → ${cStatus.toUpperCase()}: ₦1,560,000 at ${collected.rate} = ${Number(collected.usdcAmount) / 1e6} USDC`);
console.log(`  into the hub: ${explorerTx("moderato", bridgeIn.tempoMove!.split(":")[0]!)}`);
const balanceAcct = await accounts.customer(IMPORTER, CORRIDOR, "pathUSD", "tempo");
console.log(`  importer hub balance: ${formatMoney(await ledger.balance(balanceAcct))}`);

// ---- 2. pay the supplier in China from that balance ----
const payoutPlan = planRoute({
  corridor: CORRIDOR,
  privacy: "public",
  source: { venue: "tempo", asset: "pathUSD" },
  destination: { venue: "partner_fiat", asset: "CNY" },
  env: "testnet",
});
const payoutId = uuidv7();
const payout: PayoutData = {
  payoutId,
  customerId: IMPORTER,
  corridor: CORRIDOR,
  asset: "pathUSD",
  venue: "tempo",
  amount: collected.usdcAmount!, // the whole collection goes to the supplier
  reference: encodeRef({ kind: RefKind.Payout, corridor: CORRIDOR, shielded: false, id: payoutId, customerTag: tag }),
  recipient: { kind: "bank", bankCode: "CN-ICBC", accountNumber: "6222020200112233445", name: "Shenzhen Brightline Electronics Co." },
  tempoStartBlock: rt.startBlock.toString(),
};
console.log(`\nsupplier payout  ${payoutPlan.steps.map((s) => s.kind).join(" → ")}`);
const pid = await engine.start({ kind: "payout", reference: payout.reference, plan: payoutPlan, data: payout });
const pStatus = await engine.run(pid);
const pView = await engine.get(pid);
const paid = pView.steps.at(-1)!.output as Record<string, string>;
const bridgeOut = pView.steps[1]!.output as Record<string, string>;
console.log(`  → ${pStatus.toUpperCase()}: ${Number(payout.amount) / 1e6} USDC → ¥${(Number(paid.fiatAmount) / 100).toLocaleString("en-US")} to Shenzhen Brightline Electronics (rate ${paid.rate})`);
console.log(`  out of the hub: ${explorerTx("moderato", bridgeOut.tempoMove!.split(":")[0]!)}`);

// ---- reconcile both directions ----
const tempoSeen = await rt.observer.poll();
const partnerSeen = [collected.orderId!, paid.orderId!].map((id) => rt.mock.getOrder(id));
const results = await reconcile(ledger, [...tempoSeen, ...(await Promise.all(partnerSeen)).map((o) => partnerObservation(o)!)]);
console.log(`\nreconciliation (${tempoSeen.length} Tempo movements + 2 partner orders):`, summarize(results));
console.log(`importer hub balance after payout: ${formatMoney(await ledger.balance(balanceAcct))}`);
console.log(`invariants: ${JSON.stringify(await ledger.checkInvariants())}`);
await rt.close();
if (results.some((r) => r.status !== "matched")) process.exitCode = 1;
