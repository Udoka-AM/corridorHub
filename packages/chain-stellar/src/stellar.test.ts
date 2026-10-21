import { describe, expect, it } from "vitest";
import { Keypair, Memo, Networks, Operation, TransactionBuilder, Account as SdkAccount } from "@stellar/stellar-sdk";
import { RefKind, customerTag, encodeRef, fromStellarMemo, toStellarMemo, uuidv7, type Observation } from "@corridor/core";
import { STELLAR_ISSUERS, assetOf, fromStellarAmount, stellarAsset, toStellarAmount } from "./assets.ts";
import { StellarObserver, ledgerOf, normalizeRecord, type CursorStore, type PaymentSource, type StellarPaymentRecord } from "./observer.ts";
import { ed25519StellarSigner, findTransfersByMemo, fundingMemoFor, localStellarSigner } from "./index.ts";

const USDC_ISSUER = STELLAR_ISSUERS.USDC!.testnet!;

const reference = () =>
  encodeRef({ kind: RefKind.Payout, corridor: "EUR-KES", shielded: false, id: uuidv7(), customerTag: customerTag("eu-payco", "s") });

const memoOf = (ref: ReturnType<typeof reference>) => Buffer.from(toStellarMemo(ref)).toString("base64");

function payment(over: Partial<StellarPaymentRecord> = {}): StellarPaymentRecord {
  return {
    id: "op1",
    paging_token: "100",
    type: "payment",
    transaction_hash: "abc",
    created_at: "2026-10-17T09:00:00Z",
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: USDC_ISSUER,
    from: "GVAULT",
    to: "GANCHOR",
    amount: "2.9000000",
    ...over,
  };
}

/** A Horizon stand-in that pages like the real one. */
function fakeHorizon(records: StellarPaymentRecord[]): PaymentSource & { calls: (string | undefined)[] } {
  const calls: (string | undefined)[] = [];
  return {
    calls,
    async fetch(_account, cursor, limit) {
      calls.push(cursor);
      const from = cursor ? records.findIndex((r) => r.paging_token === cursor) + 1 : 0;
      return records.slice(from, from + limit);
    },
  };
}

function memoryCursors(): CursorStore & { stored: Map<string, bigint> } {
  const stored = new Map<string, bigint>();
  return {
    stored,
    async get(name) {
      return stored.get(name);
    },
    async set(name, cursor) {
      stored.set(name, cursor);
    },
  };
}

describe("Stellar amounts", () => {
  it("formats and parses the hub's 7 decimal places exactly", () => {
    expect(toStellarAmount({ asset: "USDC", amount: 29_000_000n })).toBe("2.9000000");
    expect(fromStellarAmount("USDC", "2.9000000")).toBe(29_000_000n);
    expect(fromStellarAmount("USDC", "2.9")).toBe(29_000_000n);
    expect(fromStellarAmount("XLM", "0.0000001")).toBe(1n);
  });

  it("refuses an amount with more precision than Stellar can hold", () => {
    expect(() => fromStellarAmount("USDC", "2.90000001")).toThrow(/more than 7 decimals/);
  });
});

describe("Stellar assets", () => {
  it("treats the issuer as part of the asset's identity", () => {
    const other = Keypair.random().publicKey();
    expect(assetOf(payment(), "testnet")).toBe("USDC");
    // Same code, different issuer: not the USDC Corridor settles in.
    expect(assetOf(payment({ asset_issuer: other }), "testnet")).toBeNull();
    expect(assetOf({ asset_type: "native" }, "testnet")).toBe("XLM");
  });

  it("says which issuer is missing rather than guessing one", () => {
    expect(() => stellarAsset("MGUSD", "mainnet")).toThrow(/no mainnet issuer configured for MGUSD/);
    expect(stellarAsset("USDC", "testnet").getIssuer()).toBe(USDC_ISSUER);
  });
});

describe("the reference as MEMO_HASH", () => {
  it("rides on a real transaction and comes back off it whole", async () => {
    const keypair = Keypair.fromSecret(Keypair.random().secret());
    const signer = localStellarSigner(keypair.secret());
    const ref = reference();

    const tx = new TransactionBuilder(new SdkAccount(signer.address, "1"), {
      fee: "100",
      networkPassphrase: Networks.TESTNET,
      memo: Memo.hash(Buffer.from(toStellarMemo(ref))),
    })
      .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: stellarAsset("USDC", "testnet"), amount: "2.9" }))
      .setTimeout(180)
      .build();

    // The memo on the signed transaction is the 32 reference bytes, unchanged.
    expect(fromStellarMemo(Buffer.from(tx.memo.value as Uint8Array).toString("base64"))).toBe(ref);

    // And the signer's signature over the transaction hash verifies.
    tx.addSignature(signer.address, Buffer.from(await signer.sign(tx.hash())).toString("base64"));
    const signature = (tx.signatures[0]!.signature as unknown as { value: Uint8Array }).value;
    expect(keypair.verify(tx.hash(), Buffer.from(signature))).toBe(true);
  });

  it("gives an Ed25519 key held elsewhere the same Stellar address", async () => {
    const keypair = Keypair.random();
    const held = ed25519StellarSigner(
      { kind: "kms", signBytes: async (m) => new Uint8Array(keypair.sign(Buffer.from(m))) },
      keypair.rawPublicKey(),
    );
    expect(held.address).toBe(keypair.publicKey());
    expect(keypair.verify(Buffer.from("payout"), Buffer.from(await held.sign(new Uint8Array(Buffer.from("payout")))))).toBe(true);
  });
});

describe("StellarObserver", () => {
  const observe = async (records: StellarPaymentRecord[], unreferenced = false) => {
    const source = fakeHorizon(records);
    const cursors = memoryCursors();
    const observer = new StellarObserver(source, { name: "vaults", network: "testnet", accounts: ["GVAULT"], cursors, pageSize: 2, unreferenced });
    return { seen: await observer.poll(), source, cursors };
  };

  it("joins the memo back to the reference and reports the movement", async () => {
    const ref = reference();
    const { seen } = await observe([payment({ transaction: { memo: memoOf(ref), memo_type: "hash", ledger: 42 } })]);
    expect(seen).toEqual<Observation[]>([
      {
        venue: "stellar",
        externalRef: "abc:op1",
        reference: ref,
        asset: "USDC",
        amount: 29_000_000n,
        from: "GVAULT",
        to: "GANCHOR",
        blockNumber: 42n,
        memo: { type: "hash", value: memoOf(ref) },
        observedAt: new Date("2026-10-17T09:00:00Z"),
      },
    ]);
  });

  it("pages through Horizon and resumes from the stored cursor", async () => {
    const records = [1, 2, 3, 4, 5].map((n) =>
      payment({ id: `op${n}`, paging_token: `${100 + n}`, transaction: { memo: memoOf(reference()), memo_type: "hash", ledger: n } }),
    );
    const { seen, source, cursors } = await observe(records);
    expect(seen).toHaveLength(5);
    // Pages of two, stopping on the short page.
    expect(source.calls).toEqual([undefined, "102", "104"]);
    expect(cursors.stored.get("vaults")).toBe(105n);
  });

  it("ignores a payment without a reference unless asked for unreferenced movements", async () => {
    expect(await (await observe([payment()])).seen).toEqual([]);
    const { seen } = await observe([payment()], true);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reference).toBeNull();
  });

  it("skips a look-alike asset from another issuer", async () => {
    const ref = reference();
    const { seen } = await observe([
      payment({ asset_issuer: Keypair.random().publicKey(), transaction: { memo: memoOf(ref), memo_type: "hash" } }),
    ]);
    expect(seen).toEqual([]);
  });

  it("reports account funding and the fee the transaction charged", async () => {
    const { seen } = await observe(
      [
        payment({
          type: "create_account",
          from: undefined,
          to: undefined,
          amount: undefined,
          asset_type: "native",
          asset_code: undefined,
          asset_issuer: undefined,
          funder: "GSPONSOR",
          account: "GVAULT",
          starting_balance: "1.5000000",
          transaction: { ledger: 7, source_account: "GVAULT", fee_charged: "100" },
        }),
      ],
      true,
    );
    expect(seen).toEqual([
      expect.objectContaining({ externalRef: "abc:op1", asset: "XLM", amount: 15_000_000n, from: "GSPONSOR", to: "GVAULT" }),
      expect.objectContaining({ externalRef: "abc:fee", asset: "XLM", amount: 100n, from: "GVAULT" }),
    ]);
  });

  it("drops movements from a failed transaction", async () => {
    const { seen } = await observe([payment({ transaction_successful: false, transaction: { memo: memoOf(reference()), memo_type: "hash" } })]);
    expect(seen).toEqual([]);
  });
});

describe("Horizon records", () => {
  /**
   * The SDK makes a method out of every `_links` entry, so a joined payment
   * arrives with `transaction` as a link-follower, the data in
   * `transaction_attr`, and the ledger sequence in `ledger_attr` because
   * `ledger` is a link-follower too. Getting this wrong loses every memo.
   */
  it("lifts the joined transaction out from behind the SDK's link methods", () => {
    const ref = reference();
    const raw = {
      ...payment({ paging_token: "22512088261873665" }),
      transaction: () => Promise.resolve({}),
      transaction_attr: {
        memo: memoOf(ref),
        memo_type: "hash",
        ledger: () => Promise.resolve({}),
        ledger_attr: 5_241_517,
        source_account: "GVAULT",
        fee_charged: "100",
        successful: true,
      },
    };

    const record = normalizeRecord(raw);
    expect(record.transaction).toEqual({
      memo: memoOf(ref),
      memo_type: "hash",
      ledger: 5_241_517,
      source_account: "GVAULT",
      fee_charged: "100",
      successful: true,
    });
    expect(fromStellarMemo(record.transaction!.memo!, record.transaction!.memo_type)).toBe(ref);
  });

  it("reads the ledger sequence out of an operation's TOID", () => {
    // 22512088261873665 >> 32 — the ledger this operation landed in, checked
    // against Horizon's own ledger_attr for the same operation.
    expect(ledgerOf("22512088261873665")).toBe(5_241_504n);
    expect(ledgerOf("not-a-token")).toBeUndefined();
  });

  it("falls back to the TOID when the joined transaction has no sequence", async () => {
    const source = fakeHorizon([payment({ paging_token: "22512088261873665", transaction: { memo: memoOf(reference()), memo_type: "hash" } })]);
    const observer = new StellarObserver(source, { name: "v", network: "testnet", accounts: ["GVAULT"], cursors: memoryCursors(), pageSize: 2 });
    const [seen] = await observer.poll();
    expect(seen!.blockNumber).toBe(5_241_504n);
  });
});

describe("an anchor's own memo", () => {
  // A receiving SEP-31 anchor assigns the memo on the funding payment, so on
  // that one leg the Corridor Reference cannot ride in MEMO_HASH (ADR 0003).
  const client = { network: "testnet" } as Parameters<typeof findTransfersByMemo>[0];

  it("matches a text memo, and does not mistake it for another", async () => {
    const records = [
      payment({ id: "op1", paging_token: "1", transaction: { memo: "mock-a1b2c3d4", memo_type: "text" } }),
      payment({ id: "op2", paging_token: "2", transaction: { memo: "mock-ffffffff", memo_type: "text" } }),
    ];
    const found = await findTransfersByMemo(client, {
      account: "GVAULT",
      memo: { type: "text", value: "mock-a1b2c3d4" },
      source: fakeHorizon(records),
    });
    expect(found.map((o) => o.externalRef)).toEqual(["abc:op1"]);
  });

  it("matches an id memo and leaves a hash memo alone", async () => {
    const records = [
      payment({ id: "op1", paging_token: "1", transaction: { memo: "90210", memo_type: "id" } }),
      payment({ id: "op2", paging_token: "2", transaction: { memo: memoOf(reference()), memo_type: "hash" } }),
    ];
    const byId = await findTransfersByMemo(client, { account: "GVAULT", memo: { type: "id", value: "90210" }, source: fakeHorizon(records) });
    expect(byId.map((o) => o.externalRef)).toEqual(["abc:op1"]);
    // A text memo of the same digits is a different memo.
    const byText = await findTransfersByMemo(client, { account: "GVAULT", memo: { type: "text", value: "90210" }, source: fakeHorizon(records) });
    expect(byText).toEqual([]);
  });

  it("still books the movement against the reference the chain does not carry", async () => {
    const ref = reference();
    const records = [payment({ transaction: { memo: "mock-a1b2c3d4", memo_type: "text" } })];
    const [found] = await findTransfersByMemo(client, {
      account: "GVAULT",
      memo: { type: "text", value: "mock-a1b2c3d4" },
      reference: ref,
      source: fakeHorizon(records),
    });
    // The join key on this leg is (anchor, transaction id); the reference is
    // what the ledger books it under.
    expect(found!.reference).toBe(ref);
    expect(found!.amount).toBe(29_000_000n);
  });

  it("takes the anchor's memo when the order has one, and the reference otherwise", () => {
    const ref = reference();
    expect(fundingMemoFor({ fundingMemo: "mock-a1b2c3d4", fundingMemoType: "text" }, ref)).toEqual({ type: "text", value: "mock-a1b2c3d4" });
    expect(fundingMemoFor({ fundingMemo: "90210", fundingMemoType: "id" }, ref)).toEqual({ type: "id", value: "90210" });
    // SEP-31 may name no memo type; text is the one that accepts any string.
    expect(fundingMemoFor({ fundingMemo: "mock-a1b2c3d4" }, ref)).toEqual({ type: "text", value: "mock-a1b2c3d4" });
    expect(fundingMemoFor({}, ref)).toEqual({ type: "hash", value: ref });
  });

  it("builds a transaction carrying each memo type", async () => {
    const keypair = Keypair.random();
    const signer = localStellarSigner(keypair.secret());
    const build = (memo: Memo) =>
      new TransactionBuilder(new SdkAccount(signer.address, "1"), { fee: "100", networkPassphrase: Networks.TESTNET, memo })
        .addOperation(Operation.payment({ destination: Keypair.random().publicKey(), asset: stellarAsset("USDC", "testnet"), amount: "7" }))
        .setTimeout(180)
        .build();
    expect(Buffer.from(build(Memo.text("mock-a1b2c3d4")).memo.value as Uint8Array).toString("utf8")).toBe("mock-a1b2c3d4");
    expect(build(Memo.id("90210")).memo.value).toBe("90210");
    // 28 bytes is the limit for a text memo; the SDK refuses more, which is
    // exactly why the reference rides MEMO_HASH instead.
    expect(() => Memo.text("x".repeat(29))).toThrow();
  });
});
