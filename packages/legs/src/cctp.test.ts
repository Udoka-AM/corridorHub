import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Account, Keypair, Networks, type Transaction } from "@stellar/stellar-sdk";
import { RefKind, customerTag, encodeRef, money, uuidv7 } from "@corridor/core";
import { DOMAIN, Iris, type CctpMessage } from "@corridor/bridge-cctp";
import { localStellarSigner } from "@corridor/chain-stellar";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { SagaEngine } from "@corridor/saga";
import type { RoutePlan } from "@corridor/routing";
import { CctpMintStore, cctpTransferLeg, type CctpInboundData } from "./cctp.ts";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;
let mints: CctpMintStore;

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  accounts = new Accounts(ledger);
  mints = await CctpMintStore.open(db);
});
afterEach(() => db.close());

/** One cctp.transfer step, Solana into the hub. */
const plan = {
  corridor: "USD-KES",
  purpose: "collection",
  privacy: "public",
  steps: [
    {
      index: 0,
      kind: "cctp.transfer",
      from: { venue: "solana", asset: "USDC" },
      to: { venue: "stellar", asset: "USDC" },
      referenceScope: "payout",
    },
  ],
} as unknown as RoutePlan;

const attested: CctpMessage = { message: "0xdead", attestation: "0xbeef", status: "complete" };

function fakeIris(answers: CctpMessage[][] = [[attested]]) {
  let call = 0;
  const impl = (async () => {
    const page = answers[Math.min(call++, answers.length - 1)]!;
    return Response.json({ messages: page });
  }) as unknown as typeof fetch;
  return new Iris({ network: "testnet", fetch: impl });
}

function fakeSoroban(over: { status?: "SUCCESS" | "FAILED" | "NOT_FOUND"; failAfterSubmit?: boolean } = {}) {
  const submitted: string[] = [];
  return {
    submitted,
    server: {
      getAccount: async (address: string) => new Account(address, "7"),
      prepareTransaction: async (tx: Transaction) => tx,
      sendTransaction: async (tx: Transaction) => ({ status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), errorResult: {} }),
      getTransaction: async (hash: string) => {
        if (over.failAfterSubmit && !submitted.includes(hash)) {
          submitted.push(hash);
          return { status: "NOT_FOUND" };
        }
        return { status: over.status ?? "SUCCESS" };
      },
    } as never,
  };
}

const data = (over: Partial<CctpInboundData> = {}): CctpInboundData => ({
  sourceDomain: DOMAIN.solana,
  burnTx: "solanaBurnSig1",
  sourceAmount: "2900000", // 2.90 USDC at the spoke's 6 dp
  recipient: Keypair.random().publicKey(),
  reference: encodeRef({ kind: RefKind.Deposit, corridor: "USD-KES", shielded: false, id: uuidv7(), customerTag: customerTag("app", "s") }),
  ...over,
});

const leg = (iris: Iris, soroban: ReturnType<typeof fakeSoroban>) =>
  cctpTransferLeg({
    iris,
    mints,
    network: "testnet",
    pollMs: 1,
    mint: {
      signer: localStellarSigner(Keypair.random().secret()),
      passphrase: Networks.TESTNET,
      server: soroban.server,
      sleep: async () => {},
    },
  });

describe("inbound CCTP", () => {
  it("waits for the attestation, mints on Stellar and books both sides at 7 dp", async () => {
    const soroban = fakeSoroban();
    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), soroban)]);
    const d = data();
    const id = await engine.start({ kind: "deposit", plan, data: d });
    expect(await engine.run(id)).toBe("completed");

    const out = (await engine.get(id)).steps[0]!.output as Record<string, string>;
    expect(out).toMatchObject({ burnTx: "solanaBurnSig1", amount: "29000000", source: "external" }); // 2.9 USDC scaled 6 → 7 dp
    expect(out.mintTx).toMatch(/^[0-9a-f]{64}$/);

    // The hub's treasury holds it, and the books balance.
    expect((await ledger.balance(await accounts.vault("treasury", "USDC", "stellar"))).amount).toBe(29_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("draws down the spoke's own vault only when that vault funded the burn", async () => {
    // Corridor moving its own float: the spoke vault has to hold it first.
    const ingress = await accounts.vault("solana-ingress", "USDC", "solana");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: ingress, direction: "D", money: money("USDC", 29_000_000n) },
        { account: await accounts.equity("owner", "USDC", "solana"), direction: "C", money: money("USDC", 29_000_000n) },
      ],
    });

    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), fakeSoroban())]);
    const id = await engine.start({ kind: "deposit", plan, data: data({ source: "vault" }) });
    expect(await engine.run(id)).toBe("completed");

    expect((await ledger.balance(ingress)).amount).toBe(0n);
    expect((await ledger.balance(await accounts.vault("treasury", "USDC", "stellar"))).amount).toBe(29_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("books an external sender's deposit without touching a vault it never funded", async () => {
    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), fakeSoroban())]);
    const id = await engine.start({ kind: "deposit", plan, data: data({ source: "external" }) });
    expect(await engine.run(id)).toBe("completed");

    // Nothing was drawn from a Solana vault; the other side is a clearing
    // account for reconciliation to assign.
    expect((await ledger.balance(await accounts.vault("solana-ingress", "USDC", "solana"))).amount).toBe(0n);
    expect((await ledger.balance(await accounts.clearing("cctp-inbound", "USDC", "solana"))).amount).toBe(-29_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("books the same burn exactly once, however many times it is replayed", async () => {
    const soroban = fakeSoroban();
    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), soroban)]);
    const d = data();
    const treasury = await accounts.vault("treasury", "USDC", "stellar");

    const first = await engine.start({ kind: "deposit", plan, data: d });
    expect(await engine.run(first)).toBe("completed");
    const mintTx = ((await engine.get(first)).steps[0]!.output as Record<string, string>).mintTx;
    expect((await ledger.balance(treasury)).amount).toBe(29_000_000n);

    // The same burn again, as a replay or a duplicate notification would.
    const again = await engine.start({ kind: "deposit", plan, data: d });
    expect(await engine.run(again)).toBe("completed");

    // The ledger recognises the burn and writes nothing, so the balance holds.
    expect((await ledger.balance(treasury)).amount).toBe(29_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
    expect(((await engine.get(again)).steps[0]!.output as Record<string, string>).mintTx).toBe(mintTx);
  });

  it("re-submits a mint that was recorded but never settled", async () => {
    // A crash between submitting and settling: the first getTransaction says
    // NOT_FOUND, so the message is still unminted and the nonce is free.
    const soroban = fakeSoroban({ failAfterSubmit: true });
    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), soroban)]);
    const id = await engine.start({ kind: "deposit", plan, data: data() });
    expect(await engine.run(id)).toBe("completed");
    expect(await mints.submitted("solanaBurnSig1")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses a domain Corridor does not know, without retrying", async () => {
    const engine = await SagaEngine.open(db, ledger, accounts, [leg(fakeIris(), fakeSoroban())]);
    const id = await engine.start({ kind: "deposit", plan, data: data({ sourceDomain: 99 }) });
    expect(await engine.run(id)).toBe("compensated");
    expect((await engine.get(id)).steps[0]!.attempts).toBe(1);
  });
});
