import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair, Networks, Account as SdkAccount, type Transaction } from "@stellar/stellar-sdk";
import { RefKind, customerTag, encodeRef, fromStellarMemo, money, toStellarMemo, uuidv7 } from "@corridor/core";
import { STELLAR_ISSUERS, localStellarSigner, type PaymentSource, type StellarClient, type StellarPaymentRecord } from "@corridor/chain-stellar";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { MockPartner, PartnerRegistry, type PartnerOrder } from "@corridor/partners";
import { reconcile } from "@corridor/recon";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type Leg, type PayoutData } from "@corridor/saga";
import { PartnerEventStore, handlePartnerWebhook, partnerObservation } from "@corridor/webhooks";
import { ledgerCreditLeg, partnerCollectLeg, partnerPayoutLeg, stellarAnchorFunder, stellarPathPaymentLeg, type CollectionData } from "./index.ts";

// EURC has no testnet issuer in the registry on purpose (ADR 0007), so this
// supplies one the way a deployment would.
process.env.CORRIDOR_STELLAR_ISSUER_EURC_TESTNET = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

/** A Stellar that prices and settles offline: the order books are the test's. */
function fakeStellar(delivered: bigint, memo: () => string) {
  const keys = Keypair.random();
  const amountStr = (v: bigint) => (Number(v) / 1e7).toFixed(7);
  const record = {
    id: "op1",
    paging_token: "1",
    type: "path_payment_strict_send",
    transaction_hash: "b".repeat(64),
    created_at: "2026-10-23T09:00:00Z",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: STELLAR_ISSUERS.USDC!.testnet!,
    from: keys.publicKey(),
    to: keys.publicKey(),
    amount: amountStr(delivered),
  };
  const page = () => ({
    call: async () => ({ records: [{ ...record, transaction_attr: { memo: memo(), memo_type: "hash", ledger_attr: 9, successful: true } }] }),
  });
  return {
    network: "testnet" as const,
    passphrase: Networks.TESTNET,
    address: keys.publicKey(),
    signer: { kind: "local", address: keys.publicKey(), sign: async (h: Uint8Array) => new Uint8Array(keys.sign(Buffer.from(h))) },
    fee: async () => "100",
    server: {
      strictSendPaths: () => ({
        call: async () => ({
          records: [{ destination_amount: amountStr(delivered), source_amount: "0", path: [], asset_type: "credit_alphanum4", asset_code: "USDC" }],
        }),
      }),
      loadAccount: async () => new SdkAccount(keys.publicKey(), "7"),
      submitTransaction: async () => ({ hash: "b".repeat(64), successful: true, ledger: 9 }),
      payments: () => ({ forAccount: () => ({ join: () => ({ order: () => ({ limit: () => ({ ...page(), cursor: () => page() }) }) }) }) }),
    },
  } as unknown as StellarClient;
}

const SECRET = "whsec_legs";
let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;
let events: PartnerEventStore;

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  accounts = new Accounts(ledger);
  events = await PartnerEventStore.open(db);
  const treasury = await accounts.vault("treasury", "USDC", "stellar");
  const customer = await accounts.customer("eu-payco", "EUR-NGN", "USDC", "stellar");
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: treasury, direction: "D", money: money("USDC", 500_000_000n) },
      { account: customer, direction: "C", money: money("USDC", 500_000_000n) },
    ],
  });
});
afterEach(() => db.close());

/** Chain-free stand-in for bridge.simulated with the same bookings shape, both directions. */
const fakeBridge: Leg<any> = {
  kind: "bridge.simulated",
  async forward(ctx) {
    const amt = BigInt(ctx.data.amount ?? (Object.values(ctx.outputs).find((o: any) => o?.usdcAmount) as any).usdcAmount);
    const a = ctx.accounts;
    const t = await a.vault("treasury", "USDC", "stellar");
    const pt = await a.clearing("usd-peg", "USDC", "stellar");
    const ps = await a.clearing("usd-peg", "USDC", "solana");
    const out = ctx.step.from.venue === "stellar";
    const vault = await a.vault(out ? "solana-egress" : "solana-ingress", "USDC", "solana");
    const pair = (asset: "USDC", d: string, c: string) => [
      { account: d, direction: "D" as const, money: money(asset, amt) },
      { account: c, direction: "C" as const, money: money(asset, amt) },
    ];
    return {
      output: { amount: amt.toString() },
      bookings: [
        { kind: "bridge", lines: out ? pair("USDC", pt, t) : pair("USDC", t, pt) },
        { kind: "fill", lines: out ? pair("USDC", vault, ps) : pair("USDC", ps, vault) },
      ],
    };
  },
};

const ref = () => encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id: uuidv7(), customerTag: customerTag("eu-payco", "s") });

function payoutData(over: Partial<PayoutData> = {}): PayoutData {
  const id = uuidv7();
  return {
    payoutId: id,
    customerId: "eu-payco",
    corridor: "EUR-NGN",
    asset: "USDC",
    venue: "stellar",
    amount: "70000000",
    reference: ref(),
    recipient: { kind: "bank", bankCode: "058", accountNumber: "0123456789" },
    ...over,
  };
}

const payoutPlan = planRoute({
  corridor: "EUR-NGN",
  privacy: "public",
  source: { venue: "stellar", asset: "USDC" },
  destination: { venue: "partner_fiat", asset: "NGN" },
  env: "testnet",
});

describe("partner payout leg", () => {
  it("opens the order, funds it once, waits for the webhook and books a matched payout", async () => {
    const registry = new PartnerRegistry();
    const mock = new MockPartner({ webhookSecret: SECRET, chains: ["STELLAR"], deliver: (b, h) => handlePartnerWebhook(registry, events, "mock", b, h).then(() => {}) });
    registry.register(mock);
    const funded: string[] = [];
    const leg = partnerPayoutLeg({
      partners: registry,
      events,
      pollMs: 5,
      fund: async ({ order, to }) => {
        funded.push(to);
        await mock.observeFunding(order.id, "stellarTx1");
        return "stellarTx1";
      },
    });
    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, leg]);
    const data = payoutData();
    const id = await engine.start({ kind: "payout", plan: payoutPlan, data });
    expect(await engine.run(id)).toBe("completed");
    expect(funded).toHaveLength(1);

    const out = (await engine.get(id)).steps[1]!.output as Record<string, unknown>;
    expect(out).toMatchObject({ partner: "mock", status: "completed", currency: "NGN", fiatAmount: "1071000" }); // 7 USDC × 1530
    const order = await mock.getOrder(out.orderId as string);
    const [match] = await reconcile(ledger, [partnerObservation(order)!]);
    expect(match!.status).toBe("matched");
    expect(await ledger.checkInvariants()).toEqual([]);
    // Paid out of the treasury on the hub: no egress vault in the path.
    expect((await ledger.balance(await accounts.vault("treasury", "USDC", "stellar"))).amount).toBe(430_000_000n);
  });

  it("still pays a partner that settles off Stellar, across a bridge leg", async () => {
    // Every launch currency has an on-hub partner now, so this path is
    // constructed: the plan carries a bridge hop and the partner settles on
    // Solana, as Paj does.
    const registry = new PartnerRegistry();
    const mock = new MockPartner({
      webhookSecret: SECRET,
      chains: ["SOLANA"],
      deliver: (b, h) => handlePartnerWebhook(registry, events, "mock", b, h).then(() => {}),
    });
    registry.register(mock);
    const leg = partnerPayoutLeg({
      partners: registry,
      events,
      pollMs: 5,
      fund: async ({ chain, order }) => {
        expect(chain).toBe("SOLANA");
        await mock.observeFunding(order.id, "solanaSig1");
        return "solanaSig1";
      },
    });

    const bridged = {
      ...payoutPlan,
      steps: [
        payoutPlan.steps[0]!,
        { index: 1, kind: "bridge.simulated", from: { venue: "stellar", asset: "USDC" }, to: { venue: "solana", asset: "USDC" }, referenceScope: "payout" },
        { index: 2, kind: "partner.payout", from: { venue: "solana", asset: "USDC" }, to: { venue: "partner_fiat", asset: "NGN" }, referenceScope: "payout" },
      ],
    } as typeof payoutPlan;

    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, fakeBridge, leg]);
    const id = await engine.start({ kind: "payout", plan: bridged, data: payoutData() });
    expect(await engine.run(id)).toBe("completed");

    // The USDC left the Solana egress vault the bridge leg filled.
    expect((await ledger.balance(await accounts.vault("solana-egress", "USDC", "solana"))).amount).toBe(0n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("never funds an order twice across retries", async () => {
    const registry = new PartnerRegistry();
    const mock = new MockPartner({ webhookSecret: SECRET, chains: ["STELLAR"] });
    registry.register(mock);
    let fundCalls = 0;
    const leg = partnerPayoutLeg({
      partners: registry,
      events,
      pollMs: 5,
      timeoutMs: 50,
      fund: async ({ order }) => {
        fundCalls++;
        // The partner only sees the deposit later: the first attempt times out waiting.
        setTimeout(() => void mock.observeFunding(order.id, "sigX"), 120);
        return "sigX";
      },
    });
    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, { ...leg, backoffMs: 100 }]);
    const id = await engine.start({ kind: "payout", plan: payoutPlan, data: payoutData() });
    expect(await engine.run(id)).toBe("completed");
    expect(fundCalls).toBe(1);
    expect((await engine.get(id)).steps[1]!.attempts).toBeGreaterThan(1);
  });

  it("stops for manual review, without compensating, when a funded payout fails", async () => {
    const registry = new PartnerRegistry();
    const mock = new MockPartner({ webhookSecret: SECRET, chains: ["STELLAR"], failPayouts: true });
    registry.register(mock);
    const leg = partnerPayoutLeg({
      partners: registry,
      events,
      pollMs: 5,
      fund: async ({ order }) => (await mock.observeFunding(order.id, "sigF"), "sigF"),
    });
    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, leg]);
    const id = await engine.start({ kind: "payout", plan: payoutPlan, data: payoutData() });
    expect(await engine.run(id)).toBe("manual_review");
    const view = await engine.get(id);
    expect(view.steps.map((s) => s.status)).toEqual(["done", "failed"]);
    expect(view.steps[1]!.error).toMatch(/after it was funded/);
  });

  it("rejects a payout without bank details before touching the partner", async () => {
    const registry = new PartnerRegistry().register(new MockPartner({ webhookSecret: SECRET, chains: ["STELLAR"] }));
    const leg = partnerPayoutLeg({ partners: registry, events, fund: async () => "never" });
    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, leg]);
    const id = await engine.start({ kind: "payout", plan: payoutPlan, data: payoutData({ recipient: { kind: "bank" } }) });
    expect(await engine.run(id)).toBe("compensated");
    expect((await engine.get(id)).steps[1]!.attempts).toBe(1);
  });
});

describe("collection: importer pays naira, customer's hub balance is credited", () => {
  it("opens a virtual account, waits for the payer, bridges in and credits the customer", async () => {
    const registry = new PartnerRegistry();
    const mock = new MockPartner({ webhookSecret: SECRET, chains: ["STELLAR"], deliver: (b, h) => handlePartnerWebhook(registry, events, "mock", b, h).then(() => {}) });
    registry.register(mock);
    const shown: string[] = [];
    const leg = partnerCollectLeg({
      partners: registry,
      events,
      pollMs: 5,
      ingressAddress: () => "CorridorStellarIngress",
      onCollectionOpened: async (order) => {
        shown.push(order.virtualAccount!.accountNumber);
        setTimeout(() => void mock.payerTransferred(order.id), 20); // the importer pays from their bank
      },
    });
    const plan = planRoute({
      corridor: "NGN-CNY",
      purpose: "collection",
      privacy: "public",
      source: { venue: "partner_fiat", asset: "NGN" },
      destination: { venue: "stellar", asset: "USDC" },
      env: "testnet",
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["partner.collect", "ledger.credit"]);

    const engine = await SagaEngine.open(db, ledger, accounts, [leg, ledgerCreditLeg]);
    const data: CollectionData = {
      collectionId: uuidv7(),
      customerId: "acme-imports",
      corridor: "NGN-CNY",
      currency: "NGN",
      fiatAmount: "1560000", // ₦15,600.00
      reference: ref(),
    };
    const id = await engine.start({ kind: "collection", plan, data });
    expect(await engine.run(id)).toBe("completed");
    expect(shown).toHaveLength(1);

    const balance = await ledger.balance(await accounts.customer("acme-imports", "NGN-CNY", "USDC", "stellar"));
    expect(balance.amount).toBe(100_000_000n); // ₦15,600 at 1,560 = 10 USDC, now spendable on the hub
    expect(await ledger.checkInvariants()).toEqual([]);
  });
});

describe("funding an anchor on Stellar", () => {
  // A SEP-31 anchor assigns the memo on the funding payment, so the Corridor
  // Reference cannot ride in MEMO_HASH on this leg (ADR 0003). The funder has
  // to carry the anchor's memo and still be safe to retry.
  const ANCHOR = Keypair.random().publicKey();

  function fakeTreasury() {
    const keypair = Keypair.random();
    const submitted: { memoType: string; memo: string; destination: string; amount: string }[] = [];
    const seen: StellarPaymentRecord[] = [];
    let seq = 1n;
    const client = {
      network: "testnet",
      passphrase: Networks.TESTNET,
      address: keypair.publicKey(),
      signer: localStellarSigner(keypair.secret()),
      fee: async () => "100",
      server: {
        loadAccount: async (id: string) => new SdkAccount(id, (seq++).toString()),
        async submitTransaction(tx: Transaction) {
          const op = tx.operations[0] as { destination: string; amount: string };
          const value = tx.memo.value as Uint8Array | string | null;
          submitted.push({
            memoType: tx.memo.type as string,
            memo: typeof value === "string" ? value : Buffer.from(value ?? []).toString(tx.memo.type === "hash" ? "base64" : "utf8"),
            destination: op.destination,
            amount: op.amount,
          });
          return { hash: `tx${submitted.length}`, successful: true, ledger: 500 };
        },
      },
    } as unknown as StellarClient;
    const source: PaymentSource = { async fetch(_a, cursor) { return cursor ? [] : seen; } };
    /** What Horizon would show after a payment the treasury already made. */
    const landed = (over: Partial<StellarPaymentRecord> & { memo: string; memoType: string }) => {
      const { memo, memoType, ...rest } = over;
      seen.push({
        id: "op1", paging_token: "1", type: "payment", transaction_hash: "tx1",
        created_at: "2026-10-17T09:00:00Z", asset_type: "credit_alphanum4", asset_code: "USDC",
        asset_issuer: STELLAR_ISSUERS.USDC!.testnet!, from: keypair.publicKey(), to: ANCHOR, amount: "7.0000000",
        transaction: { memo, memo_type: memoType }, ...rest,
      });
    };
    return { client, submitted, source, landed };
  }

  const order = (over: Partial<PartnerOrder> = {}): PartnerOrder => ({
    partner: "anchor", id: "tx-1", kind: "payout", status: "open", partnerStatus: "pending_sender",
    chain: "STELLAR", currency: "KES", usdcAmount: 70_000_000n, fiatAmount: 90_550n, rate: "129.5",
    fundingAddress: ANCHOR, createdAt: new Date(), ...over,
  });

  const fundWith = (t: ReturnType<typeof fakeTreasury>, o: PartnerOrder, reference = ref()) =>
    stellarAnchorFunder({ treasury: t.client, source: t.source })({ chain: "STELLAR", to: ANCHOR, usdcAmount: 70_000_000n, reference, order: o });

  it("carries the anchor's memo, not the reference", async () => {
    const t = fakeTreasury();
    await fundWith(t, order({ fundingMemo: "anchor-7f3a", fundingMemoType: "text" }));
    expect(t.submitted).toEqual([{ memoType: "text", memo: "anchor-7f3a", destination: ANCHOR, amount: "7.0000000" }]);
  });

  it("falls back to the reference as MEMO_HASH when the order names no memo", async () => {
    const t = fakeTreasury();
    const reference = ref();
    await fundWith(t, order(), reference);
    expect(t.submitted[0]!.memoType).toBe("hash");
    expect(fromStellarMemo(t.submitted[0]!.memo)).toBe(reference);
  });

  it("does not pay twice when a crash lands between sending and recording", async () => {
    const t = fakeTreasury();
    // The first attempt sent the payment; the worker died before the funding
    // reference was recorded, so the leg calls the funder again.
    t.landed({ memo: "anchor-7f3a", memoType: "text" });
    const retry = await fundWith(t, order({ fundingMemo: "anchor-7f3a", fundingMemoType: "text" }));
    expect(t.submitted).toEqual([]);  // nothing new was sent
    expect(retry).toBe("tx1:op1");    // the earlier payment is what the leg records
  });

  it("sends again when the earlier payment carried a different memo", async () => {
    const t = fakeTreasury();
    t.landed({ memo: "anchor-OTHER", memoType: "text" });
    await fundWith(t, order({ fundingMemo: "anchor-7f3a", fundingMemoType: "text" }));
    expect(t.submitted).toHaveLength(1);
  });

  it("sends again when an identical memo went to someone else", async () => {
    const t = fakeTreasury();
    t.landed({ memo: "anchor-7f3a", memoType: "text", to: Keypair.random().publicKey() });
    await fundWith(t, order({ fundingMemo: "anchor-7f3a", fundingMemoType: "text" }));
    expect(t.submitted).toHaveLength(1);
  });
});

describe("a payout funded in another asset", () => {
  it("converts on the order books, pays the anchor and closes both clearing pairs", async () => {
    const registry = new PartnerRegistry();
    const mock = new MockPartner({
      webhookSecret: SECRET,
      chains: ["STELLAR"],
      deliver: (b, h) => handlePartnerWebhook(registry, events, "mock", b, h).then(() => {}),
    });
    registry.register(mock);

    // The customer holds EURC, not the settlement asset.
    const held = 100_000_000n; // 10 EURC
    const delivered = 108_000_000n; // the books give 10.8 USDC for it
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: await accounts.vault("treasury", "EURC", "stellar"), direction: "D", money: money("EURC", held) },
        { account: await accounts.customer("eu-payco", "EUR-KES", "EURC", "stellar"), direction: "C", money: money("EURC", held) },
      ],
    });

    const data = payoutData({ corridor: "EUR-KES", asset: "EURC", amount: held.toString() });
    const client = fakeStellar(delivered, () => Buffer.from(toStellarMemo(data.reference)).toString("base64"));
    const payoutLeg = partnerPayoutLeg({
      partners: registry,
      events,
      pollMs: 5,
      fund: async ({ order }) => (await mock.observeFunding(order.id, "stellarTx1"), "stellarTx1"),
    });

    const plan = planRoute({
      corridor: "EUR-KES",
      privacy: "public",
      source: { venue: "stellar", asset: "EURC" },
      destination: { venue: "partner_fiat", asset: "KES" },
      env: "mainnet",
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["ledger.reserve", "stellar.pathPayment", "partner.payout"]);

    const engine = await SagaEngine.open(db, ledger, accounts, [
      ledgerReserveLeg,
      stellarPathPaymentLeg({ treasury: client }),
      payoutLeg,
    ]);
    const id = await engine.start({ kind: "payout", plan, data });
    expect(await engine.run(id)).toBe("completed");

    // The anchor was paid in the settlement asset, priced off what the books gave.
    const out = (await engine.get(id)).steps[2]!.output as Record<string, unknown>;
    expect(out).toMatchObject({ partner: "mock", status: "completed", currency: "KES", usdcPaid: delivered.toString() });

    // The customer's EURC is gone and the treasury's EURC went with it.
    expect((await ledger.balance(await accounts.customer("eu-payco", "EUR-KES", "EURC", "stellar"))).amount).toBe(0n);
    expect((await ledger.balance(await accounts.customerHold("eu-payco", "EUR-KES", "EURC", "stellar"))).amount).toBe(0n);
    expect((await ledger.balance(await accounts.vault("treasury", "EURC", "stellar"))).amount).toBe(0n);

    // Both clearing pairs the conversion opened are closed: nothing stranded.
    for (const asset of ["EURC", "USDC"] as const) {
      expect((await ledger.balance(await accounts.clearing("EURC-USDC", asset, "stellar"))).amount).toBe(0n);
    }
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("stops for review rather than booking a negative difference", async () => {
    // An anchor that reports taking more than the conversion produced. The
    // mock echoes what it is given, so this is its own stub.
    const greedy = {
      id: "greedy",
      payoutCurrencies: ["KES"] as const,
      collectionCurrencies: [] as const,
      chains: ["STELLAR"] as const,
      async rates() {
        return { currency: "KES" as const, onRamp: "130", offRamp: "130", at: new Date() };
      },
      async openPayout(req: { usdcAmount: bigint }) {
        return {
          partner: "greedy",
          id: "greedy-1",
          kind: "payout" as const,
          status: "completed" as const,
          partnerStatus: "COMPLETED",
          chain: "STELLAR" as const,
          currency: "KES" as const,
          // More than it was handed.
          usdcAmount: req.usdcAmount * 2n,
          fiatAmount: 1n,
          rate: "130",
          fundingAddress: Keypair.random().publicKey(),
          createdAt: new Date(),
        };
      },
      async openCollection() {
        throw new Error("not used");
      },
      async getOrder() {
        return this.openPayout({ usdcAmount: 108_000_000n });
      },
      verifyWebhook: () => false,
      parseWebhook: () => {
        throw new Error("not used");
      },
    };
    const registry = new PartnerRegistry().register(greedy as never);

    const held = 100_000_000n;
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: await accounts.vault("treasury", "EURC", "stellar"), direction: "D", money: money("EURC", held) },
        { account: await accounts.customer("eu-payco", "EUR-KES", "EURC", "stellar"), direction: "C", money: money("EURC", held) },
      ],
    });

    const data = payoutData({ corridor: "EUR-KES", asset: "EURC", amount: held.toString() });
    const client = fakeStellar(108_000_000n, () => Buffer.from(toStellarMemo(data.reference)).toString("base64"));
    const payoutLeg = partnerPayoutLeg({ partners: registry, events, pollMs: 5, fund: async () => "stellarTx1" });
    const plan = planRoute({
      corridor: "EUR-KES",
      privacy: "public",
      source: { venue: "stellar", asset: "EURC" },
      destination: { venue: "partner_fiat", asset: "KES" },
      env: "mainnet",
    });

    const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, stellarPathPaymentLeg({ treasury: client }), payoutLeg]);
    const id = await engine.start({ kind: "payout", plan, data });
    expect(await engine.run(id)).toBe("manual_review");
    expect((await engine.get(id)).steps[2]!.error).toMatch(/with only 108000000 available/);
    // Money left the vault, so nothing is unwound and the books still balance.
    expect(await ledger.checkInvariants()).toEqual([]);
  });
});
