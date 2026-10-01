/**
 * Public payout on testnet: EUR→NGN through the saga.
 *
 *   pnpm payout:demo
 *
 * reserve (ledger) → bridge (real Tempo leg to the bridge escrow; Solana fill
 * simulated) → partner payout (Paj-shaped partner: offramp order, memo-tagged
 * funding on Solana devnet when the vault holds devnet USDC, signed webhooks
 * over HTTP). A second payout forces a partner failure *before funding* and
 * is compensated in reverse with a real Tempo refund. Finally the observers
 * reconcile Tempo movements and partner orders against the ledger.
 */
import { RefKind, customerTag, encodeRef, formatMoney, money, parseMoney, uuidv7, type CorridorCode } from "@corridor/core";
import { explorerTx, transferWithReference } from "@corridor/chain-tempo";
import { reconcile, summarize } from "@corridor/recon";
import { planRoute } from "@corridor/routing";
import type { PayoutData } from "@corridor/saga";
import { partnerObservation } from "@corridor/webhooks";
import { testnetKey } from "./env.ts";
import { startRuntime } from "./runtime.ts";

const CUSTOMER_ID = "eu-payco-demo";
const CORRIDOR: CorridorCode = "EUR-NGN";
const tag = customerTag(CUSTOMER_ID, testnetKey("CORRIDOR_REF_SECRET"));
const rt = await startRuntime();
const { ledger, accounts, engine } = rt;

// 1. The PSP pre-funds 20 pathUSD on Tempo, booked from the on-chain transfer.
const depositRef = encodeRef({ kind: RefKind.Deposit, corridor: CORRIDOR, shielded: false, id: uuidv7(), customerTag: tag });
const deposit = await transferWithReference(rt.customer, {
  asset: "pathUSD",
  to: rt.treasury.account.address,
  amount: parseMoney("pathUSD", "20").amount,
  reference: depositRef,
});
await ledger.post({
  kind: "tempo.deposit",
  reference: depositRef,
  external: { venue: "tempo", ref: deposit.externalRef },
  lines: [
    { account: await accounts.vault("treasury", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", deposit.amount) },
    { account: await accounts.customer(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo"), direction: "C", money: money("pathUSD", deposit.amount) },
  ],
});
console.log(`\ndeposit   20 pathUSD  ${explorerTx("moderato", deposit.txHash)}`);

const plan = planRoute({
  corridor: CORRIDOR,
  privacy: "public",
  source: { venue: "tempo", asset: "pathUSD" },
  destination: { venue: "partner_fiat", asset: "NGN" },
  env: "testnet",
});
console.log(`route     ${plan.steps.map((s) => s.kind).join(" → ")}`);

async function payout(amount: string, opts: { failAtPartner?: boolean } = {}) {
  const payoutId = uuidv7();
  const data: PayoutData = {
    payoutId,
    customerId: CUSTOMER_ID,
    corridor: CORRIDOR,
    asset: "pathUSD",
    venue: "tempo",
    amount: parseMoney("pathUSD", amount).amount.toString(),
    reference: encodeRef({ kind: RefKind.Payout, corridor: CORRIDOR, shielded: false, id: payoutId, customerTag: tag }),
    recipient: { kind: "bank", bankCode: "058", accountNumber: "0123456789", name: "Ada Obi" },
    tempoStartBlock: rt.startBlock.toString(),
  };
  const id = await engine.start({ kind: "payout", reference: data.reference, plan, data, faults: opts.failAtPartner ? { failAt: "partner.payout" } : undefined });
  console.log(`\npayout ${amount} pathUSD to Ada Obi (GTBank 0123456789)`);
  const status = await engine.run(id);
  const view = await engine.get(id);
  console.log(`  → ${status.toUpperCase()}  (saga ${id})`);
  for (const s of view.steps) {
    const out = (s.output ?? {}) as Record<string, string>;
    const detail =
      s.kind === "partner.payout" && out.orderId
        ? `${out.partner} order ${out.orderId.slice(0, 14)}…  ₦${(Number(out.fiatAmount) / 100).toLocaleString("en-NG")} @ ${out.rate}`
        : out.tempoMove
          ? explorerTx("moderato", out.tempoMove.split(":")[0]!)
          : "";
    console.log(`  ${s.idx} ${s.kind.padEnd(16)} ${s.status.padEnd(12)} ${s.error ?? detail}`);
  }
  for (const e of view.events.filter((e) => e.event === "compensated" && e.detail?.includes("tempoRefund"))) {
    console.log(`  reversal  ${explorerTx("moderato", JSON.parse(e.detail!).tempoRefund.split(":")[0])}`);
  }
  return view;
}

const ok = await payout("7");
await payout("4", { failAtPartner: true });

// 2. Reconcile what the observers saw against the books.
const tempoSeen = await rt.observer.poll();
const partnerOut = ok.steps.find((s) => s.kind === "partner.payout")?.output as { orderId?: string } | null;
const partnerSeen = partnerOut?.orderId ? [partnerObservation(await rt.mock.getOrder(partnerOut.orderId))!] : [];
const results = await reconcile(ledger, [...tempoSeen, ...partnerSeen]);
console.log(`\nreconciliation: ${tempoSeen.length} Tempo movements + ${partnerSeen.length} partner payout:`, summarize(results));

const available = await accounts.customer(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo");
const hold = await accounts.customerHold(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo");
console.log(`customer available ${formatMoney(await ledger.balance(available))}, held ${formatMoney(await ledger.balance(hold))}`);
console.log(`invariants         ${JSON.stringify(await ledger.checkInvariants())}`);
await rt.close();
if (results.some((r) => r.status !== "matched")) process.exitCode = 1;
