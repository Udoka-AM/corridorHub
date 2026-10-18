import { describe, expect, it } from "vitest";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { RefKind, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { PartnerError } from "./types.ts";
import { SepAnchor, parseToml } from "./sep.ts";

const anchorKey = Keypair.random();
const vault = Keypair.random();
const USDC = { code: "USDC", issuer: Keypair.random().publicKey() };

const ref = () =>
  encodeRef({ kind: RefKind.Payout, corridor: "EUR-KES", shielded: false, id: uuidv7(), customerTag: customerTag("eu-payco", "s") });

const TOML = `
# the anchor's own description
NETWORK_PASSPHRASE="${Networks.TESTNET}"
SIGNING_KEY="${anchorKey.publicKey()}"
WEB_AUTH_ENDPOINT="https://anchor.test/auth"
DIRECT_PAYMENT_SERVER="https://anchor.test/sep31"
ANCHOR_QUOTE_SERVER="https://anchor.test/sep38"
KYC_SERVER="https://anchor.test/kyc"

[[CURRENCIES]]
code = "KES"
`;

/** A challenge the way a SEP-10 server builds one: its key signs, the client account is the op source. */
function challenge(opts: { source?: Keypair; clientAccount?: string } = {}): string {
  const server = opts.source ?? anchorKey;
  const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.manageData({
        name: "anchor.test auth",
        value: Buffer.alloc(48, 1).toString("base64"),
        source: opts.clientAccount ?? vault.publicKey(),
      }),
    )
    .setTimeout(300)
    .build();
  tx.sign(server);
  return tx.toXDR();
}

interface StubOptions {
  challengeXdr?: string;
  onPost?: (url: string, body: unknown) => void;
  /** SEP-31 lets the receiving account arrive on GET rather than in the POST reply. */
  accountOnGetOnly?: boolean;
  /** The newer `amount_out_asset` shape instead of `destination_asset`. */
  amountAssetFields?: boolean;
}

function stubAnchor(opts: StubOptions = {}) {
  const calls: { url: string; method: string; auth?: string }[] = [];
  const http = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, auth: (init?.headers as Record<string, string> | undefined)?.authorization });

    if (url.endsWith("/.well-known/stellar.toml")) return new Response(TOML);
    if (url.startsWith("https://anchor.test/auth") && method === "GET") {
      return Response.json({ transaction: opts.challengeXdr ?? challenge(), network_passphrase: Networks.TESTNET });
    }
    if (url === "https://anchor.test/auth" && method === "POST") return Response.json({ token: "jwt-token" });
    if (url.startsWith("https://anchor.test/sep38/prices")) {
      return Response.json({ buy_assets: [{ asset: "iso4217:KES", price: "129.5" }] });
    }
    if (url === "https://anchor.test/sep38/quote") {
      return Response.json({ id: "quote-1", price: "129.5", buy_amount: "905.50" });
    }
    if (url === "https://anchor.test/sep31/info") {
      return Response.json({ receive: { native: { enabled: true, funding_methods: ["bank_account"] }, USDC: { enabled: true, funding_methods: ["bank_account"] } } });
    }
    if (url === "https://anchor.test/sep31/transactions" && method === "POST") {
      opts.onPost?.(url, JSON.parse(String(init?.body)));
      return Response.json(
        opts.accountOnGetOnly ? { id: "tx-1" } : { id: "tx-1", stellar_account_id: "GANCHORRECEIVE", stellar_memo: "AAAA", stellar_memo_type: "hash" },
      );
    }
    if (url === "https://anchor.test/sep31/transactions/tx-1") {
      return Response.json({
        transaction: {
          id: "tx-1",
          status: "pending_receiver",
          amount_in: "7.0000000",
          amount_out: "905.50",
          ...(opts.amountAssetFields
            ? { amount_in_asset: "stellar:native", amount_out_asset: "iso4217:KES" }
            : { destination_asset: "iso4217:KES" }),
          stellar_account_id: "GANCHORRECEIVE",
          stellar_memo: "17",
          stellar_memo_type: "id",
          stellar_transaction_id: "deadbeef",
          started_at: "2026-10-17T09:00:00Z",
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const anchor = new SepAnchor({
    domain: "anchor.test",
    id: "minisend",
    asset: USDC,
    network: "testnet",
    payoutCurrencies: ["KES"],
    signer: { address: vault.publicKey(), sign: async (hash) => new Uint8Array(vault.sign(Buffer.from(hash))) },
    fetch: http,
    now: () => new Date("2026-10-17T09:00:00Z"),
  });
  return { anchor, calls };
}

describe("SEP-1 toml", () => {
  it("reads the endpoints Corridor needs and ignores table sections", () => {
    const toml = parseToml(TOML);
    expect(toml.SIGNING_KEY).toBe(anchorKey.publicKey());
    expect(toml.DIRECT_PAYMENT_SERVER).toBe("https://anchor.test/sep31");
    expect((toml as Record<string, string>).code).toBeUndefined();
  });
});

describe("SEP-10 authentication", () => {
  it("signs the challenge once and reuses the token", async () => {
    const { anchor, calls } = stubAnchor();
    expect(await anchor.authenticate()).toBe("jwt-token");
    expect(await anchor.authenticate()).toBe("jwt-token");
    expect(calls.filter((c) => c.url.startsWith("https://anchor.test/auth") && c.method === "POST")).toHaveLength(1);
  });

  it("refuses a challenge that is not signed by the anchor's own key", async () => {
    const { anchor } = stubAnchor({ challengeXdr: challenge({ source: Keypair.random() }) });
    await expect(anchor.authenticate()).rejects.toThrow(/not built by minisend's signing key/);
  });

  it("refuses a challenge that names another account", async () => {
    const { anchor } = stubAnchor({ challengeXdr: challenge({ clientAccount: Keypair.random().publicKey() }) });
    await expect(anchor.authenticate()).rejects.toThrow(/not this vault/);
  });
});

describe("SEP-31 payout", () => {
  it("quotes, opens the transaction and returns the anchor's own memo", async () => {
    let posted: Record<string, unknown> = {};
    const { anchor, calls } = stubAnchor({ onPost: (_u, body) => (posted = body as Record<string, unknown>) });
    const reference = ref();
    const order = await anchor.openPayout({
      currency: "KES",
      chain: "STELLAR",
      usdcAmount: 70_000_000n, // 7 USDC at the hub's 7 dp
      beneficiary: { bankCode: "01", accountNumber: "0123456789" },
      reference,
    });

    expect(order).toMatchObject({
      partner: "minisend",
      id: "tx-1",
      status: "open",
      chain: "STELLAR",
      currency: "KES",
      fundingAddress: "GANCHORRECEIVE",
      fundingMemo: "AAAA",
      fundingMemoType: "hash",
      fiatAmount: 90_550n, // KES 905.50
      rate: 129.5,
    });
    expect(posted).toMatchObject({ amount: "7.0000000", asset_code: "USDC", destination_asset: "iso4217:KES", quote_id: "quote-1" });
    // The reference cannot ride in the memo on a SEP-31 leg, so it goes in the fields.
    expect((posted.fields as { transaction: Record<string, string> }).transaction).toMatchObject({
      receiver_account_number: "0123456789",
      reference,
    });
    expect(calls.every((c) => c.method === "GET" || c.auth === "Bearer jwt-token" || c.url.endsWith("/auth"))).toBe(true);
  });

  it("maps SEP-31 statuses onto Corridor's own", async () => {
    const { anchor } = stubAnchor();
    const order = await anchor.getOrder("tx-1");
    expect(order).toMatchObject({ status: "processing", partnerStatus: "pending_receiver", usdcAmount: 70_000_000n, fiatAmount: 90_550n });
    expect(order.txSignature).toBe("deadbeef");
  });

  it("reads the paid-out currency from amount_out_asset as well as destination_asset", async () => {
    const legacy = await stubAnchor().anchor.getOrder("tx-1");
    const current = await stubAnchor({ amountAssetFields: true }).anchor.getOrder("tx-1");
    for (const order of [legacy, current]) {
      expect(order.currency).toBe("KES");
      expect(order.fiatAmount).toBe(90_550n);
    }
  });

  it("opens the order with a funding method the anchor publishes", async () => {
    let body: { funding_method?: string } = {};
    const { anchor } = stubAnchor({ onPost: (_u, b) => (body = b as typeof body) });
    await anchor.openPayout({
      currency: "KES",
      chain: "STELLAR",
      usdcAmount: 70_000_000n,
      beneficiary: { bankCode: "01", accountNumber: "0123456789" },
      reference: ref(),
    });
    // SEP-31 requires one, and GET /sep31/info says which, so it is read
    // rather than guessed.
    expect(body.funding_method).toBe("bank_account");
  });

  it("fetches the receiving account when the order reply leaves it out", async () => {
    const { anchor } = stubAnchor({ accountOnGetOnly: true });
    const order = await anchor.openPayout({
      currency: "KES",
      chain: "STELLAR",
      usdcAmount: 70_000_000n,
      beneficiary: { bankCode: "01", accountNumber: "0123456789" },
      reference: ref(),
    });
    // The amounts stay the ones the quote priced; only the funding fields
    // come from the follow-up read.
    expect(order).toMatchObject({
      fundingAddress: "GANCHORRECEIVE",
      fundingMemo: "17",
      fundingMemoType: "id",
      currency: "KES",
      fiatAmount: 90_550n,
    });
  });

  it("identifies the native asset as stellar:native, and refuses an issued asset with no issuer", async () => {
    const quotes: string[] = [];
    const { anchor } = stubAnchor();
    // The stub records every URL; the SEP-38 price call carries the sell asset.
    await anchor.rates("KES");
    void quotes;
    const noIssuer = new SepAnchor({
      domain: "anchor.test",
      asset: { code: "USDC" },
      payoutCurrencies: ["KES"],
      signer: { address: vault.publicKey(), sign: async (h) => new Uint8Array(vault.sign(Buffer.from(h))) },
      fetch: (async () => new Response(TOML)) as unknown as typeof fetch,
    });
    await expect(noIssuer.rates("KES")).rejects.toThrow(/needs an issuer/);
  });

  it("refuses a currency it does not serve, and a chain it does not settle on", async () => {
    const { anchor } = stubAnchor();
    const payout = { usdcAmount: 10n, beneficiary: { bankCode: "1", accountNumber: "2" }, reference: ref() };
    await expect(anchor.openPayout({ ...payout, currency: "NGN", chain: "STELLAR" })).rejects.toThrow(PartnerError);
    await expect(anchor.openPayout({ ...payout, currency: "KES", chain: "SOLANA" })).rejects.toThrow(/settles on Stellar/);
  });

  it("is polled rather than pushed", async () => {
    const { anchor } = stubAnchor();
    expect(anchor.verifyWebhook()).toBe(false);
    expect(() => anchor.parseWebhook()).toThrow(/polled, not pushed/);
  });

  it("returns the receiving account and the anchor's own memo", async () => {
    const { anchor } = stubAnchor();
    const order = await anchor.openPayout({
      currency: "KES",
      chain: "STELLAR",
      usdcAmount: 70_000_000n,
      beneficiary: { bankCode: "01", accountNumber: "0123456789" },
      reference: ref(),
    });
    // The funding payment has to carry this memo, not the Corridor Reference.
    expect(order).toMatchObject({ fundingAddress: "GANCHORRECEIVE", fundingMemo: "AAAA", fundingMemoType: "hash" });
  });

  it("fetches stellar.toml from baseUrl when the anchor is not served over HTTPS at its domain", async () => {
    // A local Anchor Platform on http://localhost:8080. The home domain stays
    // the domain, because that is what SEP-10 is asked to sign for.
    const seen: string[] = [];
    const http = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(TOML);
    }) as unknown as typeof fetch;
    const anchor = new SepAnchor({
      domain: "anchor.test",
      baseUrl: "http://localhost:8080/",
      signer: { address: vault.publicKey(), sign: async (h) => new Uint8Array(vault.sign(Buffer.from(h))) },
      fetch: http,
    });
    await anchor.discover();
    expect(seen).toEqual(["http://localhost:8080/.well-known/stellar.toml"]);
  });

  it("defaults to https at the domain", async () => {
    const seen: string[] = [];
    const http = (async (input: string | URL) => {
      seen.push(String(input));
      return new Response(TOML);
    }) as unknown as typeof fetch;
    const anchor = new SepAnchor({
      domain: "anchor.test",
      signer: { address: vault.publicKey(), sign: async (h) => new Uint8Array(vault.sign(Buffer.from(h))) },
      fetch: http,
    });
    await anchor.discover();
    expect(seen).toEqual(["https://anchor.test/.well-known/stellar.toml"]);
  });

  it("says where it looked when there is no stellar.toml there", async () => {
    const http = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const anchor = new SepAnchor({
      domain: "anchor.test",
      baseUrl: "http://localhost:8080",
      signer: { address: vault.publicKey(), sign: async (h) => new Uint8Array(vault.sign(Buffer.from(h))) },
      fetch: http,
    });
    await expect(anchor.discover()).rejects.toThrow(/no stellar.toml at http:\/\/localhost:8080/);
  });
});
