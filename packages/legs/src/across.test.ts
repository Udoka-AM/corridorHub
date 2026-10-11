import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RefKind, customerTag, encodeRef, money, uuidv7, type Asset, type Venue } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { MockPartner, PartnerRegistry, type PayoutRequest } from "@corridor/partners";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type PayoutData } from "@corridor/saga";
import { PartnerEventStore } from "@corridor/webhooks";
import { ArtifactStore, acrossBridgeLeg, partnerPayoutLeg, type GasCost, type Hop } from "./index.ts";

/**
 * The mainnet payout route through the saga engine, chain-free: Across's API
 * and both chains are faked, the ledger and engine are real. Amounts follow
 * the live run on 11 Oct 2026 (fees 0.003501 and 0.0001 USDC, Paj rounding
 * to cents).
 */

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;
let events: PartnerEventStore;
let artifacts: ArtifactStore;

const FEES: Record<Hop, bigint> = { "tempo-base": 3_501n, "base-solana": 100n };
const TEMPO_GAS = 362n; // pathUSD base units
const BASE_GAS = 995_513_677_000n; // wei

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  accounts = new Accounts(ledger);
  events = await PartnerEventStore.open(db);
  artifacts = await ArtifactStore.open(db);
  // The customer's deposit on the hub, and the owner's ETH float on the Base relay.
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: await accounts.vault("treasury", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", 50_000_000n) },
      { account: await accounts.customer("eu-payco", "EUR-NGN", "pathUSD", "tempo"), direction: "C", money: money("pathUSD", 50_000_000n) },
    ],
  });
  await ledger.post({
    kind: "opening",
    lines: [
      { account: await accounts.vault("base-relay", "ETH", "base"), direction: "D", money: money("ETH", 800_000_000_000_000n) },
      { account: await accounts.equity("owner-float", "ETH", "base"), direction: "C", money: money("ETH", 800_000_000_000_000n) },
    ],
  });
});
afterEach(() => db.close());

/** Across's Swap and deposit-status APIs: fills after `pendingPolls` status checks. */
function fakeAcross(pendingPolls = 0) {
  const quotes = new Map<string, { hop: Hop; out: bigint; inputToken: string }>();
  let polls = 0;
  const fetchImpl = (async (url: string) => {
    const u = new URL(url);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname.endsWith("/swap/approval")) {
      const hop: Hop = u.searchParams.get("destinationChainId") === "8453" ? "tempo-base" : "base-solana";
      const amount = BigInt(u.searchParams.get("amount")!);
      const out = amount - FEES[hop];
      const id = `q-${hop}`;
      quotes.set(id, { hop, out, inputToken: u.searchParams.get("inputToken")! });
      return json({
        id,
        inputAmount: amount.toString(),
        expectedOutputAmount: out.toString(),
        minOutputAmount: out.toString(),
        expectedFillTime: 2,
        quoteExpiryTimestamp: 0,
        fees: { total: { amount: FEES[hop].toString() } },
        approvalTxns: [{ chainId: 1, to: "0x00000000000000000000000000000000000000a1", data: "0x01" }],
        swapTx: { ecosystem: "evm", chainId: 1, to: "0x00000000000000000000000000000000000000d1", data: "0x02" },
      });
    }
    if (u.pathname.endsWith("/deposit/status")) {
      const tx = u.searchParams.get("depositTxHash")!;
      if (polls++ < pendingPolls) return json({ status: "pending" });
      return json({ status: "filled", fillTx: `fill-${tx}` });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  return { fetchImpl, quotes };
}

function harness(pendingPolls = 0) {
  const across = fakeAcross(pendingPolls);
  const sent: { hop: Hop; to: string }[] = [];
  let n = 0;
  const sender = (hop: Hop) => ({
    async sendTransaction(args: { to: `0x${string}` }) {
      sent.push({ hop, to: args.to });
      return `0x${hop.replace("-", "")}${(n++).toString().padStart(4, "0")}` as `0x${string}`;
    },
    async waitForTransactionReceipt({ hash }: { hash: `0x${string}` }) {
      return { status: "success" as const, transactionHash: hash, gasUsed: 1n, effectiveGasPrice: 1n };
    },
  });
  const leg = acrossBridgeLeg({
    env: "mainnet",
    artifacts,
    fetchImpl: across.fetchImpl,
    fillPollMs: 1,
    fillTimeoutMs: 20,
    sender,
    depositor: () => "0x0000000000000000000000000000000000000001",
    recipient: (hop) => (hop === "tempo-base" ? "0x0000000000000000000000000000000000000002" : "SolanaVault1111"),
    // What the destination chain shows arriving: the quoted output.
    received: async (hop) => [...across.quotes.values()].find((q) => q.hop === hop)!.out,
    gas: async (hop, txs): Promise<GasCost[]> => {
      const [asset, venue, vault, total]: [Asset, Venue, string, bigint] =
        hop === "tempo-base" ? ["pathUSD", "tempo", "treasury", TEMPO_GAS] : ["ETH", "base", "base-relay", BASE_GAS];
      // Split the hop's total across its transactions, as the receipts would.
      return txs.map((t, i) => ({ txHash: t.txHash, asset, venue, vault, amount: i === 0 ? total - total / 2n : total / 2n }));
    },
  });
  return { leg, sent, quotes: across.quotes };
}

/** Paj rounds orders down to whole cents. */
class RoundingPartner extends MockPartner {
  override openPayout(req: PayoutRequest) {
    return super.openPayout({ ...req, usdcAmount: (req.usdcAmount / 10_000n) * 10_000n });
  }
}

const planFrom = (asset: "pathUSD" | "USDC.e") =>
  planRoute({
    corridor: "EUR-NGN",
    privacy: "public",
    source: { venue: "tempo", asset },
    destination: { venue: "partner_fiat", asset: "NGN" },
    env: "mainnet",
  });
const plan = planFrom("pathUSD");

function data(asset: "pathUSD" | "USDC.e" = "pathUSD"): PayoutData {
  const id = uuidv7();
  return {
    payoutId: id,
    customerId: "eu-payco",
    corridor: "EUR-NGN",
    asset,
    venue: "tempo",
    amount: "7000000",
    reference: encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id, customerTag: customerTag("eu-payco", "s") }),
    recipient: { kind: "bank", bankCode: "100004", accountNumber: "0123456789" },
  };
}

async function engineWith(pendingPolls = 0) {
  const { leg, sent, quotes } = harness(pendingPolls);
  const registry = new PartnerRegistry();
  const partner = new RoundingPartner({ webhookSecret: "whsec_t" });
  registry.register(partner);
  const funded: bigint[] = [];
  const payout = partnerPayoutLeg({
    partners: registry,
    events,
    pollMs: 1,
    fund: async ({ order, usdcAmount }) => {
      funded.push(usdcAmount);
      await partner.observeFunding(order.id, "solanaFunding1");
      return "solanaFunding1";
    },
  });
  const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, { ...leg, backoffMs: 1 }, payout]);
  return { engine, sent, funded, quotes };
}

const bal = async (id: Promise<string>) => (await ledger.balance(await id)).amount;

describe("across.bridge on the mainnet payout route", () => {
  it("plans the two Across hops the live run took", () => {
    expect(plan.steps.map((s) => `${s.kind}:${s.from.venue}>${s.to.venue}`)).toEqual([
      "ledger.reserve:tempo>tempo",
      "across.bridge:tempo>base",
      "across.bridge:base>solana",
      "partner.payout:solana>partner_fiat",
    ]);
  });

  it("pays out what arrived, books fees, gas and dust, and leaves every peg at zero", async () => {
    const { engine, funded } = await engineWith();
    const id = await engine.start({ kind: "payout", plan, data: data() });
    expect(await engine.run(id)).toBe("completed");

    const steps = (await engine.get(id)).steps;
    expect(steps[1]!.output).toMatchObject({ hop: "tempo-base", amountIn: "7000000", received: "6996499", fee: "3501" });
    expect(steps[2]!.output).toMatchObject({ hop: "base-solana", amountIn: "6996499", received: "6996399", fee: "100" });
    // Paj-style rounding: the order asks for 6.99, and exactly that is sent.
    expect(funded).toEqual([6_990_000n]);
    expect(steps[3]!.output).toMatchObject({ usdcPaid: "6990000" });

    expect(await ledger.checkInvariants()).toEqual([]);
    // Vaults match what the chains would show.
    expect(await bal(accounts.vault("treasury", "pathUSD", "tempo"))).toBe(50_000_000n - 7_000_000n - TEMPO_GAS);
    expect(await bal(accounts.vault("base-relay", "USDC", "base"))).toBe(0n);
    expect(await bal(accounts.vault("base-relay", "ETH", "base"))).toBe(800_000_000_000_000n - BASE_GAS);
    expect(await bal(accounts.vault("solana-egress", "USDC", "solana"))).toBe(6_399n);
    // Both sides of the USD peg close; fees are recovered from the customer; dust is held for them.
    expect(await bal(accounts.clearing("usd-peg", "pathUSD", "tempo"))).toBe(0n);
    expect(await bal(accounts.clearing("usd-peg", "USDC", "solana"))).toBe(0n);
    expect((await bal(accounts.expense("bridge-fee", "USDC", "base"))) + (await bal(accounts.expense("bridge-fee", "USDC", "solana")))).toBe(3_601n);
    expect(await bal(accounts.revenue("bridge-fee-recovery", "USDC", "solana"))).toBe(3_601n);
    expect(await bal(accounts.clearing("payout-dust", "USDC", "solana"))).toBe(-6_399n);
    expect(await bal(accounts.customerHold("eu-payco", "EUR-NGN", "pathUSD", "tempo"))).toBe(0n);
    expect(await bal(accounts.customer("eu-payco", "EUR-NGN", "pathUSD", "tempo"))).toBe(43_000_000n);
  });

  it("pays out from a USDC.e balance too: Across takes it directly, no swap first", async () => {
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: await accounts.vault("treasury", "USDC.e", "tempo"), direction: "D", money: money("USDC.e", 10_000_000n) },
        { account: await accounts.customer("eu-payco", "EUR-NGN", "USDC.e", "tempo"), direction: "C", money: money("USDC.e", 10_000_000n) },
      ],
    });
    const route = planFrom("USDC.e");
    expect(route.steps.map((s) => `${s.kind}:${s.from.asset}`)).toEqual(["ledger.reserve:USDC.e", "across.bridge:USDC.e", "across.bridge:USDC", "partner.payout:USDC"]);
    const { engine, funded, quotes } = await engineWith();
    const id = await engine.start({ kind: "payout", plan: route, data: data("USDC.e") });
    expect(await engine.run(id)).toBe("completed");
    expect([...quotes.values()].find((q) => q.hop === "tempo-base")!.inputToken).toBe("0x20C000000000000000000000b9537d11c60E8b50");
    expect(funded).toEqual([6_990_000n]);
    expect(await ledger.checkInvariants()).toEqual([]);
    expect(await bal(accounts.vault("treasury", "USDC.e", "tempo"))).toBe(3_000_000n);
    // Gas is still paid in pathUSD, from the owner's float.
    expect(await bal(accounts.vault("treasury", "pathUSD", "tempo"))).toBe(50_000_000n - TEMPO_GAS);
    expect(await bal(accounts.clearing("usd-peg", "USDC.e", "tempo"))).toBe(0n);
    expect(await bal(accounts.clearing("usd-peg", "USDC", "solana"))).toBe(0n);
    expect(await bal(accounts.customer("eu-payco", "EUR-NGN", "USDC.e", "tempo"))).toBe(3_000_000n);
    expect(await bal(accounts.customer("eu-payco", "EUR-NGN", "pathUSD", "tempo"))).toBe(50_000_000n);
  });

  it("waits on the same deposit when a fill is slow, and never resends", async () => {
    const { engine, sent } = await engineWith(40); // pending past the first attempt's fill timeout
    const id = await engine.start({ kind: "payout", plan, data: data() });
    expect(await engine.run(id)).toBe("completed");
    // One approval and one deposit per hop, despite the retry.
    expect(sent.filter((s) => s.hop === "tempo-base")).toHaveLength(2);
    expect(sent.filter((s) => s.hop === "base-solana")).toHaveLength(2);
    expect((await engine.get(id)).steps[1]!.attempts).toBeGreaterThan(1);
  });

  it("stops for a person, without resending, if a crash left a deposit unrecorded", async () => {
    const { engine, sent } = await engineWith();
    const id = await engine.start({ kind: "payout", plan, data: data() });
    // As if a worker signed the first hop's deposit and died before recording it.
    const step = (await engine.get(id)).steps[1]!;
    await artifacts.merge(`across:${id}:${step.idx}`, { sending: true });
    expect(await engine.run(id)).toBe("manual_review");
    expect(sent).toHaveLength(0);
  });
});
