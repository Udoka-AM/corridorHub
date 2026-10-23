import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { RefKind, customerTag, encodeRef, money, toStellarMemo, uuidv7, type Hex } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { SagaEngine } from "@corridor/saga";
import type { RoutePlan } from "@corridor/routing";
import { stellarPathPaymentLeg, type FxData } from "./fx.ts";

// EURC has no testnet issuer in the registry on purpose — an unverified issuer
// is never guessed (ADR 0007) — so the test supplies one the way a deployment
// would.
process.env.CORRIDOR_STELLAR_ISSUER_EURC_TESTNET = "GB3Q6QDZYTHWT7E5PVS3W7FUT5GVAFC5KSZFFLPU25GO7VTC3NM2ZTVO";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  accounts = new Accounts(ledger);
  // The treasury holds EURC to convert.
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: await accounts.vault("treasury", "EURC", "stellar"), direction: "D", money: money("EURC", 100_000_000n) },
      { account: await accounts.equity("owner", "EURC", "stellar"), direction: "C", money: money("EURC", 100_000_000n) },
    ],
  });
});
afterEach(() => db.close());

const plan = {
  corridor: "EUR-KES",
  purpose: "payout",
  privacy: "public",
  steps: [
    {
      index: 0,
      kind: "stellar.pathPayment",
      from: { venue: "stellar", asset: "EURC" },
      to: { venue: "stellar", asset: "USDC" },
      referenceScope: "payout",
    },
  ],
} as unknown as RoutePlan;

const newRef = (): Hex =>
  encodeRef({ kind: RefKind.Sweep, corridor: "EUR-KES", shielded: false, id: uuidv7(), customerTag: customerTag("treasury", "s") });

const data = (reference: Hex, over: Partial<FxData> = {}): FxData => ({
  sourceAmount: "100000000", // 10 EURC at 7 dp
  reference,
  ...over,
});

/**
 * A Stellar that prices and settles offline: the quote and the delivered
 * amount are set by the test, and submission records instead of sending.
 */
function fakeStellar(over: { quoted?: bigint; delivered?: bigint; paths?: unknown[]; reference?: Hex } = {}) {
  const signer = Keypair.random();
  const quoted = over.quoted ?? 108_000_000n; // 10 EURC buys 10.8 USDC
  const delivered = over.delivered ?? quoted;
  const submitted: { destMin: string; sendAmount: string }[] = [];
  const client = {
    network: "testnet" as const,
    passphrase: "Test SDF Network ; September 2015",
    address: signer.publicKey(),
    signer: { kind: "local", address: signer.publicKey(), sign: async (hash: Uint8Array) => new Uint8Array(signer.sign(Buffer.from(hash))) },
    fee: async () => "100",
    server: {
      strictSendPaths: () => ({
        call: async () => ({
          records:
            over.paths ??
            [
              {
                destination_amount: (Number(quoted) / 1e7).toFixed(7),
                source_amount: "10.0000000",
                path: [],
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
              },
            ],
        }),
      }),
      loadAccount: async () => ({ accountId: () => signer.publicKey(), sequenceNumber: () => "7", incrementSequenceNumber: () => {} }),
      submitTransaction: async () => ({ hash: "a".repeat(64), successful: true, ledger: 42 }),
      payments: () => ({
        forAccount: () => ({
          join: () => ({
            order: () => ({
              limit: () => ({
                cursor: () => ({ call: async () => ({ records: [] }) }),
                call: async () => ({
                  records: [
                    {
                      id: "op1",
                      paging_token: "1",
                      type: "path_payment_strict_send",
                      transaction_hash: "a".repeat(64),
                      created_at: "2026-10-23T09:00:00Z",
                      asset_type: "credit_alphanum4",
                      asset_code: "USDC",
                      asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
                      from: signer.publicKey(),
                      to: signer.publicKey(),
                      amount: (Number(delivered) / 1e7).toFixed(7),
                      transaction_attr: {
                        memo: over.reference ? Buffer.from(toStellarMemo(over.reference)).toString("base64") : "",
                        memo_type: "hash",
                        ledger_attr: 42,
                        successful: true,
                      },
                    },
                  ],
                }),
              }),
            }),
          }),
        }),
      }),
    },
  };
  return { client: client as never, submitted };
}

describe("on-ledger FX", () => {
  it("converts the treasury's EURC into USDC and books both sides", async () => {
    const reference = newRef();
    const { client } = fakeStellar({ reference });
    const engine = await SagaEngine.open(db, ledger, accounts, [stellarPathPaymentLeg({ treasury: client })]);
    const id = await engine.start({ kind: "fx", plan, data: data(reference) });
    expect(await engine.run(id)).toBe("completed");

    const out = (await engine.get(id)).steps[0]!.output as Record<string, string>;
    expect(out).toMatchObject({ sourceAmount: "100000000", quoted: "108000000", destMin: "107460000" }); // 0.5% below the quote
    // `received` is the key a following leg reads.
    expect(out.received).toBe("108000000");

    expect((await ledger.balance(await accounts.vault("treasury", "EURC", "stellar"))).amount).toBe(0n);
    expect((await ledger.balance(await accounts.vault("treasury", "USDC", "stellar"))).amount).toBe(108_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("sets the slippage floor from the quote", async () => {
    const reference = newRef();
    const { client } = fakeStellar({ quoted: 200_000_000n, reference });
    const engine = await SagaEngine.open(db, ledger, accounts, [stellarPathPaymentLeg({ treasury: client, maxSlippageBps: 100 })]);
    const id = await engine.start({ kind: "fx", plan, data: data(reference) });
    expect(await engine.run(id)).toBe("completed");
    const out = (await engine.get(id)).steps[0]!.output as Record<string, string>;
    expect(out.destMin).toBe("198000000"); // 1% below 20 USDC
  });

  it("books what actually arrived, not what was quoted", async () => {
    // The order books moved between quote and fill, within the bound.
    const reference = newRef();
    const { client } = fakeStellar({ quoted: 108_000_000n, delivered: 107_500_000n, reference });
    const engine = await SagaEngine.open(db, ledger, accounts, [stellarPathPaymentLeg({ treasury: client })]);
    const id = await engine.start({ kind: "fx", plan, data: data(reference) });
    expect(await engine.run(id)).toBe("completed");

    expect((await ledger.balance(await accounts.vault("treasury", "USDC", "stellar"))).amount).toBe(107_500_000n);
    // The spread shows up on the pair's clearing accounts rather than vanishing.
    expect((await ledger.balance(await accounts.clearing("EURC-USDC", "USDC", "stellar"))).amount).toBe(-107_500_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("refuses when no path exists, without retrying", async () => {
    const { client } = fakeStellar({ paths: [] });
    const engine = await SagaEngine.open(db, ledger, accounts, [stellarPathPaymentLeg({ treasury: client })]);
    const id = await engine.start({ kind: "fx", plan, data: data(newRef()) });
    expect(await engine.run(id)).toBe("compensated");
    const step = (await engine.get(id)).steps[0]!;
    expect(step.attempts).toBe(1);
    expect(step.error).toMatch(/no EURC → USDC path/);
  });

  it("refuses to convert an asset into itself", async () => {
    const { client } = fakeStellar();
    const same = { ...plan, steps: [{ ...plan.steps[0]!, to: { venue: "stellar", asset: "EURC" } }] } as RoutePlan;
    const engine = await SagaEngine.open(db, ledger, accounts, [stellarPathPaymentLeg({ treasury: client })]);
    const id = await engine.start({ kind: "fx", plan: same, data: data(newRef()) });
    expect(await engine.run(id)).toBe("compensated");
    expect((await engine.get(id)).steps[0]!.error).toMatch(/two different assets/);
  });
});
