/**
 * A whole payout through the saga engine, on Stellar, booked double-entry.
 *
 * Two anchors, one code path:
 *
 *   pnpm stellar:payout
 *     `MockPartner` stands in for the anchor, so the run needs nothing but a
 *     funded testnet account. The route, the saga, the Stellar payment and
 *     every ledger entry are the real ones.
 *
 *   CORRIDOR_ANCHOR_BASE_URL=http://localhost:8080 CORRIDOR_PAYOUT_CURRENCY=USD pnpm stellar:payout
 *     `SepAnchor` against a real SEP server over the network: SEP-1
 *     discovery, a SEP-10 challenge this vault verifies before signing,
 *     SEP-12 customer records, a firm SEP-38 quote and a SEP-31 transaction,
 *     funded with the anchor's own memo and polled to completion.
 *     `examples/anchor` brings one up.
 *
 * No real local currency moves either way: no anchor is signed.
 */
import { RefKind, customerTag, encodeRef, formatMoney, money, uuidv7, type Fiat } from "@corridor/core";
import { explorerTx } from "@corridor/chain-stellar";
import { MockPartner, PartnerRegistry, SepAnchor, type RampPartner } from "@corridor/partners";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type PayoutData } from "@corridor/saga";
import { partnerPayoutLeg, stellarAnchorFunder } from "@corridor/legs";
import { PartnerEventStore } from "@corridor/webhooks";
import { NETWORK, openRuntime, report, vault } from "./runtime.ts";

const CUSTOMER = "eu-payco";
/**
 * The corridor under test. KES is the first corridor Corridor opens; the
 * local example anchor serves USD, because the Anchor Platform's stock
 * reference server prices a fixed set of pairs.
 */
const PAYOUT_CURRENCY = (process.env.CORRIDOR_PAYOUT_CURRENCY ?? "KES") as Fiat;
const CORRIDOR = `EUR-${PAYOUT_CURRENCY}` as const;
const AMOUNT = 70_000_000n; // 7 USDC at the hub's 7 dp

/** The asset the anchor is funded in. XLM on testnet, where a funded USDC trustline needs an issuer faucet. */
const FUNDING_ASSET = (process.env.CORRIDOR_FUNDING_ASSET ?? "XLM") as "XLM" | "USDC";
const ANCHOR_BASE_URL = process.env.CORRIDOR_ANCHOR_BASE_URL;
/**
 * The local example anchor's Platform API. Paying the beneficiary is the
 * anchor's own business step, which a real anchor performs itself when the
 * money lands in its customer's account; the stand-in has to be told. Unset
 * against a real anchor.
 */
const ANCHOR_PLATFORM_URL = process.env.CORRIDOR_ANCHOR_PLATFORM_URL;

/**
 * Tell the local example anchor its operator has paid the beneficiary.
 *
 * A real anchor does this itself, off its own rail, and Corridor only ever
 * reads the result. The Anchor Platform's reference server waits to be told,
 * and will not accept it until its own Stellar observer has seen the funding
 * payment — so this retries in the background while the saga waits.
 */
function settleAtExampleAnchorSoon(transactionId: string): void {
  void (async () => {
    const deadline = Date.now() + 120_000;
    let lastError = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000));
      const res = await fetch(ANCHOR_PLATFORM_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify([
          { id: "1", jsonrpc: "2.0", method: "notify_offchain_funds_sent", params: { transaction_id: transactionId, message: "paid the beneficiary" } },
        ]),
      });
      // JSON-RPC reports failure in the body, with a 200.
      const [reply] = (await res.json()) as [{ result?: { status?: string }; error?: { message?: string } }];
      if (reply?.result?.status === "completed") {
        console.log("the example anchor reports the beneficiary paid (a real anchor does this itself)");
        return;
      }
      lastError = reply?.error?.message ?? `status ${reply?.result?.status ?? res.status}`;
    }
    console.warn(`the example anchor never settled ${transactionId}: ${lastError}`);
  })();
}

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

  // A real SEP server when one is given, and otherwise a stand-in that
  // assigns its own funding memo the way a SEP-31 anchor does — so either way
  // the run exercises the real funding path rather than a shortcut.
  let mock: MockPartner | undefined;
  let anchor: RampPartner;
  if (ANCHOR_BASE_URL) {
    const domain = new URL(ANCHOR_BASE_URL).host;
    anchor = new SepAnchor({
      domain,
      baseUrl: ANCHOR_BASE_URL,
      network: NETWORK,
      asset: { code: FUNDING_ASSET === "XLM" ? "native" : FUNDING_ASSET },
      payoutCurrencies: [PAYOUT_CURRENCY],
      senderId: process.env.CORRIDOR_SEP12_SENDER_ID,
      receiverId: process.env.CORRIDOR_SEP12_RECEIVER_ID,
      signer: { address: treasury.address, sign: (hash) => treasury.signer!.sign(hash) },
    });
    console.log(`anchor: ${domain} over SEP-1/10/12/38/31\n`);
  } else {
    mock = new MockPartner({ webhookSecret: "whsec_dev", chains: ["STELLAR"], stellarAccount: escrow.address });
    anchor = mock;
    console.log("anchor: MockPartner (set CORRIDOR_ANCHOR_BASE_URL for a real SEP server)\n");
  }
  const registry = new PartnerRegistry().register(anchor);

  // The real funding path: pay the order's receiving account out of the
  // treasury, carrying the anchor's memo when the order names one and the
  // Corridor Reference otherwise. A signed anchor changes only who returns
  // the account and the memo.
  let fundingTx = "";
  const fund = stellarAnchorFunder({
    treasury,
    asset: FUNDING_ASSET,
    onSent: (sent, memo) => {
      fundingTx = sent.externalRef.split(":")[0]!;
      console.log(`funded ${formatMoney({ asset: sent.asset, amount: sent.amount })} with the anchor's memo (${memo.type}: ${memo.value})`);
      console.log(`  ${explorerTx(NETWORK, fundingTx)}`);
    },
  });

  const leg = partnerPayoutLeg({
    partners: registry,
    events,
    pollMs: 500,
    timeoutMs: Number(process.env.CORRIDOR_ANCHOR_TIMEOUT_MS ?? 5 * 60_000),
    fund: async (args) => {
      const ref = await fund(args);
      // A real anchor sees the payment itself, through its Stellar observer.
      await mock?.observeFunding(args.order.id, fundingTx);
      if (ANCHOR_PLATFORM_URL) settleAtExampleAnchorSoon(args.order.id);
      return ref;
    },
  });

  const plan = planRoute({
    corridor: CORRIDOR,
    privacy: "public",
    source: { venue: "stellar", asset: "USDC" },
    destination: { venue: "partner_fiat", asset: PAYOUT_CURRENCY },
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
