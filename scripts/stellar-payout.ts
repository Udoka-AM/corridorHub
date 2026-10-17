/**
 * A whole payout through the saga engine, on Stellar, booked double-entry.
 *
 * The anchor here is `MockPartner`, so no real local currency moves — but the
 * route, the saga, the Stellar payment and every ledger entry are the real
 * ones. A signed anchor replaces the mock with `SepAnchor` and supplies its
 * own funding address and memo; nothing else changes.
 *
 *   pnpm stellar:payout
 */
import { RefKind, customerTag, encodeRef, formatMoney, money, uuidv7 } from "@corridor/core";
import { explorerTx, transferWithReference } from "@corridor/chain-stellar";
import { MockPartner, PartnerRegistry } from "@corridor/partners";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type PayoutData } from "@corridor/saga";
import { partnerPayoutLeg } from "@corridor/legs";
import { PartnerEventStore } from "@corridor/webhooks";
import { NETWORK, openRuntime, report, vault } from "./runtime.ts";

const CUSTOMER = "eu-payco";
const CORRIDOR = "EUR-KES" as const;
const AMOUNT = 70_000_000n; // 7 USDC at the hub's 7 dp

const rt = await openRuntime();
const treasury = await vault("TREASURY");
const escrow = await vault("ESCROW");

try {
  // The customer's balance on the hub, as a collection would have left it.
  const treasuryAccount = await rt.accounts.vault("treasury", "USDC", "stellar");
  const customerAccount = await rt.accounts.customer(CUSTOMER, CORRIDOR, "USDC", "stellar");
  await rt.ledger.post({
    kind: "deposit",
    lines: [
      { account: treasuryAccount, direction: "D", money: money("USDC", AMOUNT) },
      { account: customerAccount, direction: "C", money: money("USDC", AMOUNT) },
    ],
  });

  const events = await PartnerEventStore.open(rt.db);
  const mock = new MockPartner({ webhookSecret: "whsec_dev", chains: ["STELLAR"] });
  const registry = new PartnerRegistry().register(mock);

  const leg = partnerPayoutLeg({
    partners: registry,
    events,
    pollMs: 500,
    // A real anchor returns its own receiving account and memo; here the
    // escrow vault stands in for it, and the payment itself is real.
    fund: async ({ order, usdcAmount, reference }) => {
      console.log(`funding order ${order.id} with ${formatMoney({ asset: "XLM", amount: 1_000_000n })} (XLM stands in for USDC on testnet)`);
      const sent = await transferWithReference(treasury, { asset: "XLM", to: escrow.address, amount: 1_000_000n, reference });
      console.log(`  ${explorerTx(NETWORK, sent.txHash)}`);
      void usdcAmount;
      await mock.observeFunding(order.id, sent.txHash);
      return sent.txHash;
    },
  });

  const plan = planRoute({
    corridor: CORRIDOR,
    privacy: "public",
    source: { venue: "stellar", asset: "USDC" },
    destination: { venue: "partner_fiat", asset: "KES" },
    env: NETWORK === "mainnet" ? "mainnet" : "testnet",
  });
  console.log(`route: ${plan.steps.map((s) => s.kind).join(" -> ")}\n`);

  const data: PayoutData = {
    payoutId: uuidv7(),
    customerId: CUSTOMER,
    corridor: CORRIDOR,
    asset: "USDC",
    venue: "stellar",
    amount: AMOUNT.toString(),
    reference: encodeRef({
      kind: RefKind.Payout,
      corridor: CORRIDOR,
      shielded: false,
      id: uuidv7(),
      customerTag: customerTag(CUSTOMER, process.env.CORRIDOR_TAG_SECRET ?? "dev"),
    }),
    recipient: { kind: "bank", bankCode: "01", accountNumber: "0123456789" },
  };

  const engine = await SagaEngine.open(rt.db, rt.ledger, rt.accounts, [ledgerReserveLeg, leg]);
  const id = await engine.start({ kind: "payout", plan, data });
  const outcome = await engine.run(id);
  console.log(`\nsaga ${outcome}`);

  const view = await engine.get(id);
  for (const step of view.steps) {
    console.log(`  ${step.kind.padEnd(16)} ${step.status}${step.error ? ` — ${step.error}` : ""}`);
  }
  const payout = view.steps.at(-1)?.output as Record<string, unknown> | undefined;
  if (payout) console.log(`\npaid ${payout.fiatAmount} ${payout.currency} at ${payout.rate} (order ${payout.orderId})`);

  console.log(`\ninvariants: ${JSON.stringify(await rt.ledger.checkInvariants())}`);
  console.log(`customer balance: ${formatMoney(await rt.ledger.balance(customerAccount))}`);
  await report(treasury, "treasury", treasury.address, ["XLM"]);
} finally {
  await rt.close();
}
