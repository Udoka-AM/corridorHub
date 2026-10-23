import { Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { FIAT, decimal, parseMoney, ratio, type Decimal, type Fiat, type Hex } from "@corridor/core";
import { PartnerError, type Beneficiary, type CollectionRequest, type OrderStatus, type PartnerChain, type PartnerOrder, type PayoutRequest, type RampPartner, type Rates } from "./types.ts";

/**
 * A Stellar anchor as a Corridor spoke, over the SEPs rather than a bespoke
 * REST API:
 *
 * - **SEP-1**  `stellar.toml` discovery: which endpoints and currencies the anchor serves
 * - **SEP-10** authentication: a challenge transaction signed by the vault key, exchanged for a JWT
 * - **SEP-12** customer records, when the anchor needs KYC on sender or receiver
 * - **SEP-38** a firm quote for USDC → local currency before anything moves
 * - **SEP-31** the cross-border payment itself: the anchor pays the beneficiary
 *
 * Because every anchor speaks the same SEPs, adding a corridor is
 * configuration — a domain and an asset — rather than an integration. That is
 * what makes the spokes additive (ADR 0002).
 */

/** SEP-12 customer statuses. */
export type CustomerStatus = "ACCEPTED" | "PROCESSING" | "NEEDS_INFO" | "REJECTED";

/** One field in a SEP-12 `fields` or `provided_fields` map. */
export interface CustomerField {
  type?: "string" | "binary" | "number" | "date";
  description?: string;
  choices?: string[];
  optional?: boolean;
  /** `provided_fields` only. */
  status?: "ACCEPTED" | "PROCESSING" | "REJECTED" | "VERIFICATION_REQUIRED";
  error?: string;
}

export interface CustomerRecord {
  id?: string;
  status: CustomerStatus;
  /** What the anchor still needs, when the status is NEEDS_INFO. */
  fields?: Record<string, CustomerField>;
  providedFields?: Record<string, CustomerField>;
  message?: string;
}

/** Just enough of a Stellar signer to answer a SEP-10 challenge. */
export interface ChallengeSigner {
  readonly address: string;
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export interface SepAnchorOptions {
  /**
   * The anchor's home domain, e.g. "anchor.example.com". This is also the
   * `home_domain` SEP-10 is asked to sign for, so it stays the domain even
   * when `baseUrl` points somewhere else.
   */
  domain: string;
  /**
   * Where to fetch `stellar.toml` from. Defaults to `https://{domain}`.
   * Set it to reach an anchor that is not served over HTTPS at its domain —
   * a local Anchor Platform on `http://localhost:8080`, or a tunnel.
   */
  baseUrl?: string;
  id?: string;
  /**
   * The asset Corridor funds payouts in, as it appears in the anchor's toml.
   * `issuer` is required for an issued asset and omitted for native XLM
   * (`code: "native"`).
   */
  asset?: { code: string; issuer?: string };
  network?: "testnet" | "mainnet";
  payoutCurrencies?: readonly Fiat[];
  collectionCurrencies?: readonly Fiat[];
  signer: ChallengeSigner;
  /**
   * How Corridor funds the order, as the anchor names it in `GET
   * /sep31/info`. Discovered from the anchor when not set.
   */
  fundingMethod?: string;
  /** SEP-12 customer ids, when the anchor already knows the parties. */
  senderId?: string;
  receiverId?: string;
  fetch?: typeof fetch;
  /** Clock skew allowance when checking a challenge, in seconds. */
  now?: () => Date;
  /** How long to wait for a new order's receiving account. Default 30s. */
  openTimeoutMs?: number;
  /** How often to re-ask for it. Default 1s. */
  pollMs?: number;
}

interface StellarToml {
  WEB_AUTH_ENDPOINT?: string;
  TRANSFER_SERVER?: string;
  DIRECT_PAYMENT_SERVER?: string;
  ANCHOR_QUOTE_SERVER?: string;
  KYC_SERVER?: string;
  SIGNING_KEY?: string;
  NETWORK_PASSPHRASE?: string;
}

/** SEP-31 transaction statuses, mapped onto Corridor's four. */
const SEP31_STATUS: Record<string, OrderStatus> = {
  pending_sender: "open",
  pending_stellar: "processing",
  pending_customer_info_update: "processing",
  pending_transaction_info_update: "processing",
  pending_receiver: "processing",
  pending_external: "processing",
  completed: "completed",
  refunded: "failed",
  expired: "failed",
  error: "failed",
};

export class SepAnchor implements RampPartner {
  readonly id: string;
  readonly chains: readonly PartnerChain[] = ["STELLAR"];
  readonly payoutCurrencies: readonly Fiat[];
  readonly collectionCurrencies: readonly Fiat[];

  private toml?: StellarToml;
  private info?: Sep31Info;
  private token?: { jwt: string; expiresAt: number };
  private readonly http: typeof fetch;

  constructor(private readonly opts: SepAnchorOptions) {
    this.id = opts.id ?? opts.domain;
    this.payoutCurrencies = opts.payoutCurrencies ?? [];
    this.collectionCurrencies = opts.collectionCurrencies ?? [];
    this.http = opts.fetch ?? fetch;
  }

  private get passphrase(): string {
    return this.opts.network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
  }

  /** SEP-1: the anchor's own description of what it serves. */
  async discover(): Promise<StellarToml> {
    if (this.toml) return this.toml;
    const base = (this.opts.baseUrl ?? `https://${this.opts.domain}`).replace(/\/$/, "");
    const res = await this.http(`${base}/.well-known/stellar.toml`);
    if (!res.ok) throw new PartnerError(`no stellar.toml at ${base}`, this.id, res.status);
    return (this.toml = parseToml(await res.text()));
  }

  /**
   * SEP-10: the anchor hands back a challenge transaction, Corridor's vault
   * key signs it, and the anchor returns a JWT. The challenge is checked
   * before signing — it must be built by the anchor's own signing key and
   * name this vault — so a stray endpoint cannot get the vault to sign
   * something else.
   */
  async authenticate(): Promise<string> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (this.token && this.token.expiresAt > now + 30_000) return this.token.jwt;

    const toml = await this.discover();
    const endpoint = toml.WEB_AUTH_ENDPOINT;
    if (!endpoint) throw new PartnerError(`${this.id} publishes no WEB_AUTH_ENDPOINT`, this.id);

    const url = new URL(endpoint);
    url.searchParams.set("account", this.opts.signer.address);
    url.searchParams.set("home_domain", this.opts.domain);
    const challengeRes = await this.http(url);
    if (!challengeRes.ok) throw new PartnerError(`SEP-10 challenge refused`, this.id, challengeRes.status);
    const { transaction, network_passphrase } = (await challengeRes.json()) as { transaction: string; network_passphrase?: string };
    const passphrase = network_passphrase ?? toml.NETWORK_PASSPHRASE ?? this.passphrase;

    const challenge = TransactionBuilder.fromXDR(transaction, passphrase) as Transaction;
    this.assertChallenge(challenge, toml);
    challenge.addSignature(
      this.opts.signer.address,
      Buffer.from(await this.opts.signer.sign(challenge.hash())).toString("base64"),
    );

    const tokenRes = await this.http(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transaction: challenge.toXDR() }),
    });
    if (!tokenRes.ok) throw new PartnerError(`SEP-10 token refused`, this.id, tokenRes.status);
    const { token } = (await tokenRes.json()) as { token: string };
    this.token = { jwt: token, expiresAt: now + 10 * 60_000 };
    return token;
  }

  /** A challenge is only safe to sign if the anchor built it for this account. */
  private assertChallenge(challenge: Transaction, toml: StellarToml): void {
    if (toml.SIGNING_KEY && challenge.source !== toml.SIGNING_KEY) {
      throw new PartnerError(`SEP-10 challenge was not built by ${this.id}'s signing key`, this.id);
    }
    const [first] = challenge.operations;
    if (!first || first.type !== "manageData") throw new PartnerError("SEP-10 challenge is not a manageData transaction", this.id);
    if (first.source !== this.opts.signer.address) {
      throw new PartnerError(`SEP-10 challenge names ${first.source}, not this vault`, this.id);
    }
  }

  private async call<T>(url: string, init?: RequestInit): Promise<T> {
    const jwt = await this.authenticate();
    const res = await this.http(url, {
      ...init,
      headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers, authorization: `Bearer ${jwt}` },
    });
    if (!res.ok) throw new PartnerError(`${init?.method ?? "GET"} ${url} failed: ${await res.text()}`, this.id, res.status);
    return (await res.json()) as T;
  }

  private async endpoint(key: keyof StellarToml, sep: string): Promise<string> {
    const toml = await this.discover();
    const url = toml[key];
    if (!url) throw new PartnerError(`${this.id} publishes no ${key}, so it does not serve ${sep}`, this.id);
    return url.replace(/\/$/, "");
  }

  /**
   * SEP-31 `GET /info`: which assets the anchor receives, and how it expects
   * to be funded for each.
   */
  private async sep31Info(): Promise<Sep31Info> {
    if (this.info) return this.info;
    const payments = await this.endpoint("DIRECT_PAYMENT_SERVER", "SEP-31");
    return (this.info = await this.call<Sep31Info>(`${payments}/info`));
  }

  /**
   * The funding method to open the order with. SEP-31 requires one, and the
   * anchor publishes what it accepts, so ask rather than guess.
   */
  private async fundingMethod(code: string): Promise<string | undefined> {
    if (this.opts.fundingMethod) return this.opts.fundingMethod;
    const info = await this.sep31Info();
    const methods = info.receive?.[code]?.funding_methods;
    if (!methods?.length) return undefined;
    return methods[0];
  }

  private async fundingAsset(): Promise<{ code: string; issuer?: string }> {
    if (this.opts.asset) return this.opts.asset;
    throw new PartnerError(`${this.id} needs the funding asset configured (code and issuer)`, this.id);
  }

  /**
   * SEP-38 asset identification: `stellar:CODE:ISSUER` for an issued asset,
   * `stellar:native` for XLM, and `iso4217:XXX` for fiat. An issued asset
   * without an issuer is the mistake [ADR 0007] exists to prevent, so it is
   * refused rather than guessed.
   */
  private async assetIds(currency: Fiat): Promise<{ sell: string; buy: string }> {
    const { code, issuer } = await this.fundingAsset();
    const native = code === "native" || code === "XLM";
    if (!native && !issuer) throw new PartnerError(`${this.id}: ${code} needs an issuer to be identified to the anchor`, this.id);
    return { sell: native ? "stellar:native" : `stellar:${code}:${issuer}`, buy: `iso4217:${currency}` };
  }

  /** SEP-38 indicative prices, as a rate per USD. */
  async rates(currency: Fiat): Promise<Rates> {
    const quotes = await this.endpoint("ANCHOR_QUOTE_SERVER", "SEP-38");
    const { sell, buy } = await this.assetIds(currency);
    const url = new URL(`${quotes}/prices`);
    url.searchParams.set("sell_asset", sell);
    url.searchParams.set("sell_amount", "1");
    const body = await this.call<{ buy_assets: { asset: string; price: string }[] }>(url.toString());
    const hit = body.buy_assets.find((a) => a.asset === buy);
    if (!hit) throw new PartnerError(`${this.id} quotes no price for ${currency}`, this.id);
    const price = decimal(hit.price);
    return { currency, onRamp: price, offRamp: price, at: this.opts.now?.() ?? new Date() };
  }

  /** SEP-38 firm quote: the rate is held for the life of the quote. */
  private async quote(currency: Fiat, sellAmount: string): Promise<{ id: string; price: Decimal; buyAmount: string }> {
    const quotes = await this.endpoint("ANCHOR_QUOTE_SERVER", "SEP-38");
    const { sell, buy } = await this.assetIds(currency);
    const q = await this.call<{ id: string; price: string; buy_amount: string }>(`${quotes}/quote`, {
      method: "POST",
      body: JSON.stringify({ sell_asset: sell, buy_asset: buy, sell_amount: sellAmount, context: "sep31" }),
    });
    return { id: q.id, price: decimal(q.price), buyAmount: q.buy_amount };
  }

  // ── SEP-12 customers ────────────────────────────────────────────────
  //
  // An anchor will not accept a payment until it knows the parties, and it
  // decides what knowing them means: it publishes a customer *type* per
  // direction and a field list per type. Corridor passes through whatever the
  // caller supplies and reports back what is still missing, rather than
  // modelling any one anchor's form.

  /** The customer types this anchor wants for an asset, from its SEP-31 info. */
  async sep12Types(code: string): Promise<{ sender?: string; receiver?: string }> {
    const info = await this.sep31Info();
    const asset = info.receive?.[code];
    return { sender: asset?.sender_sep12_type, receiver: asset?.receiver_sep12_type };
  }

  /** SEP-12 `GET /customer`: what the anchor knows, and what it still wants. */
  async customer(args: { id?: string; type?: string; transactionId?: string; lang?: string } = {}): Promise<CustomerRecord> {
    const kyc = await this.endpoint("KYC_SERVER", "SEP-12");
    const url = new URL(`${kyc}/customer`);
    for (const [k, v] of [
      ["id", args.id],
      ["type", args.type],
      ["transaction_id", args.transactionId],
      ["lang", args.lang],
    ] as const) {
      if (v) url.searchParams.set(k, v);
    }
    const body = await this.call<{
      id?: string;
      status: CustomerStatus;
      fields?: Record<string, CustomerField>;
      provided_fields?: Record<string, CustomerField>;
      message?: string;
    }>(url.toString());
    return { id: body.id, status: body.status, fields: body.fields, providedFields: body.provided_fields, message: body.message };
  }

  /** SEP-12 `PUT /customer`: hand the anchor what it asked for. Returns its customer id. */
  async putCustomer(args: { id?: string; type?: string; transactionId?: string; fields?: Record<string, string> }): Promise<string> {
    const kyc = await this.endpoint("KYC_SERVER", "SEP-12");
    const body = await this.call<{ id: string }>(`${kyc}/customer`, {
      method: "PUT",
      body: JSON.stringify({
        ...(args.id ? { id: args.id } : {}),
        ...(args.type ? { type: args.type } : {}),
        ...(args.transactionId ? { transaction_id: args.transactionId } : {}),
        ...args.fields,
      }),
    });
    return body.id;
  }

  /** SEP-12 `DELETE /customer/{account}`: forget a customer. */
  async deleteCustomer(account: string, memo?: string): Promise<void> {
    const kyc = await this.endpoint("KYC_SERVER", "SEP-12");
    await this.call<unknown>(`${kyc}/customer/${encodeURIComponent(account)}`, {
      method: "DELETE",
      ...(memo ? { body: JSON.stringify({ memo }) } : {}),
    });
  }

  /**
   * The customer id to put on a transaction for one side of it.
   *
   * A configured id is used as-is. Otherwise the fields the caller supplied
   * are registered and the anchor's verdict is checked: `NEEDS_INFO` is a
   * refusal that names the outstanding fields, so a caller can ask for
   * exactly those and retry, and `REJECTED` is final.
   */
  private async customerId(side: "sender" | "receiver", type: string | undefined, fields: Record<string, string> | undefined): Promise<string | undefined> {
    const configured = side === "sender" ? this.opts.senderId : this.opts.receiverId;
    if (configured) return configured;
    if (!type) return undefined; // this anchor does not ask for this side

    const id = await this.putCustomer({ type, fields });
    const record = await this.customer({ id, type });
    if (record.status === "REJECTED") {
      throw new PartnerError(`${this.id} rejected the ${side}`, this.id, undefined, { side, message: record.message });
    }
    if (record.status === "NEEDS_INFO") {
      const missing = Object.entries(record.fields ?? {})
        .filter(([, f]) => !f.optional)
        .map(([name]) => name);
      throw new PartnerError(
        `${this.id} needs more about the ${side}: ${missing.join(", ") || "unspecified fields"}`,
        this.id,
        undefined,
        { side, customerType: type, missing, fields: record.fields, message: record.message },
      );
    }
    return id;
  }

  /**
   * SEP-31: ask the receiving anchor to pay the beneficiary, then fund the
   * transaction on Stellar. The anchor returns the account *and the memo* to
   * pay to; that memo is the anchor's, so the funding leg must use
   * `fundingMemo` rather than the Corridor Reference.
   */
  async openPayout(req: PayoutRequest): Promise<PartnerOrder> {
    if (!this.payoutCurrencies.includes(req.currency)) throw new PartnerError(`${this.id} does not pay out ${req.currency}`, this.id);
    if (req.chain !== "STELLAR") throw new PartnerError(`${this.id} settles on Stellar, not ${req.chain}`, this.id);

    const payments = await this.endpoint("DIRECT_PAYMENT_SERVER", "SEP-31");
    const { code, issuer } = await this.fundingAsset();
    const sellAmount = formatDecimal(req.usdcAmount, 7);
    const quote = await this.quote(req.currency, sellAmount);

    // The anchor will not take the payment until it knows both parties.
    const types = await this.sep12Types(code);
    const senderId = await this.customerId("sender", types.sender, req.sender);
    const receiverId = await this.customerId("receiver", types.receiver, req.receiver);

    const created = await this.call<{
      id: string;
      stellar_account_id: string;
      stellar_memo?: string;
      stellar_memo_type?: "hash" | "text" | "id";
    }>(`${payments}/transactions`, {
      method: "POST",
      body: JSON.stringify({
        amount: sellAmount,
        asset_code: code,
        asset_issuer: issuer,
        destination_asset: `iso4217:${req.currency}`,
        funding_method: await this.fundingMethod(code),
        quote_id: quote.id,
        sender_id: senderId,
        receiver_id: receiverId,
        // The Corridor Reference cannot ride in the memo here, so it travels
        // as the sending anchor's own transaction id.
        fields: { transaction: { ...beneficiaryFields(req.beneficiary), reference: req.reference } },
      }),
    });

    const order: PartnerOrder = {
      partner: this.id,
      id: created.id,
      kind: "payout",
      status: "open",
      partnerStatus: "pending_sender",
      chain: "STELLAR",
      currency: req.currency,
      usdcAmount: req.usdcAmount,
      fiatAmount: parseMoney(req.currency, quote.buyAmount, { truncate: true }).amount,
      rate: quote.price,
      fundingAddress: created.stellar_account_id,
      fundingMemo: created.stellar_memo,
      fundingMemoType: created.stellar_memo_type,
      reference: req.reference,
      createdAt: this.opts.now?.() ?? new Date(),
    };

    // SEP-31 lets the anchor return the receiving account and its memo on
    // `GET /transactions/{id}` rather than in the POST response, and an
    // anchor may take a moment to assign them. Without them there is nothing
    // to fund, so wait for them before handing the order back.
    if (!order.fundingAddress) {
      const deadline = Date.now() + (this.opts.openTimeoutMs ?? 30_000);
      while (!order.fundingAddress) {
        const fetched = await this.getOrder(created.id);
        if (fetched.status === "failed") throw new PartnerError(`${this.id} rejected order ${created.id} before it could be funded`, this.id);
        order.fundingAddress = fetched.fundingAddress;
        order.fundingMemo = fetched.fundingMemo;
        order.fundingMemoType = fetched.fundingMemoType;
        if (order.fundingAddress) break;
        if (Date.now() > deadline) {
          throw new PartnerError(`${this.id} opened ${created.id} but assigned no receiving account`, this.id);
        }
        await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1_000));
      }
    }
    return order;
  }

  /**
   * Collections are a SEP-6 deposit, not SEP-31: the payer puts local
   * currency in and the anchor delivers USDC to Corridor's wallet. Left
   * unimplemented until the first collecting anchor is signed, rather than
   * guessed at.
   */
  async openCollection(_req: CollectionRequest): Promise<PartnerOrder> {
    await this.endpoint("TRANSFER_SERVER", "SEP-6");
    throw new PartnerError(`${this.id}: SEP-6 collections are not implemented yet`, this.id);
  }

  async getOrder(id: string): Promise<PartnerOrder> {
    const payments = await this.endpoint("DIRECT_PAYMENT_SERVER", "SEP-31");
    const { transaction: t } = await this.call<{ transaction: Sep31Transaction }>(`${payments}/transactions/${id}`);
    return this.normalise(t);
  }

  private normalise(t: Sep31Transaction): PartnerOrder {
    const inAmount = amountOf(t.amount_in);
    const outAmount = amountOf(t.amount_out);
    // Anchors report the paid-out asset in one of three places.
    const currency = ((t.amount_out_asset ?? assetOf(t.amount_out) ?? t.destination_asset)?.split(":")[1] ?? "") as Fiat;
    return {
      partner: this.id,
      id: t.id,
      kind: "payout",
      status: SEP31_STATUS[t.status] ?? "processing",
      partnerStatus: t.status,
      chain: "STELLAR",
      currency,
      usdcAmount: inAmount ? parseMoney("USDC", inAmount, { truncate: true }).amount : 0n,
      fiatAmount: outAmount && currency in FIAT ? parseMoney(currency, outAmount, { truncate: true }).amount : 0n,
      rate: outAmount && inAmount ? ratio(outAmount, inAmount) : "0",
      fundingAddress: t.stellar_account_id,
      fundingMemo: t.stellar_memo,
      fundingMemoType: t.stellar_memo_type,
      txSignature: t.stellar_transaction_id,
      createdAt: new Date(t.started_at ?? Date.now()),
    };
  }

  /**
   * SEP-31 has no webhook: the sending anchor polls
   * `GET /transactions/{id}`. The saga's wait loop does exactly that, so
   * there is nothing to verify and nothing to parse.
   */
  verifyWebhook(): boolean {
    return false;
  }

  parseWebhook(): PartnerOrder {
    throw new PartnerError(`${this.id}: SEP-31 anchors are polled, not pushed`, this.id);
  }
}

interface Sep31Info {
  receive?: Record<
    string,
    { enabled?: boolean; funding_methods?: string[]; sender_sep12_type?: string; receiver_sep12_type?: string } | undefined
  >;
}

interface Sep31Amount {
  amount?: string;
  asset?: string;
}

interface Sep31Transaction {
  id: string;
  status: string;
  /** A plain amount with a companion `_asset`, or the nested `{ amount, asset }`. */
  amount_in?: string | Sep31Amount;
  amount_in_asset?: string;
  amount_out?: string | Sep31Amount;
  amount_out_asset?: string;
  /** What the order was opened with, when the anchor does not echo amounts. */
  destination_asset?: string;
  stellar_account_id?: string;
  stellar_memo?: string;
  stellar_memo_type?: "hash" | "text" | "id";
  stellar_transaction_id?: string;
  started_at?: string;
}

/** SEP-31 amounts are `{ amount, asset }` today and were plain strings before. */
function amountOf(a: string | Sep31Amount | undefined): string | undefined {
  return typeof a === "string" ? a : a?.amount;
}

function assetOf(a: string | Sep31Amount | undefined): string | undefined {
  return typeof a === "string" ? undefined : a?.asset;
}

/**
 * SEP-31 field names for a bank beneficiary. Anchors publish the fields they
 * need, and these are the two every bank payout anchor asks for.
 */
function beneficiaryFields(b: Beneficiary): Record<string, string> {
  return { receiver_account_number: b.accountNumber, receiver_routing_number: b.bankCode };
}

function formatDecimal(minor: bigint, decimals: number): string {
  const s = minor.toString().padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/**
 * A small SEP-1 reader. Every field Corridor needs is a top-level string, so
 * this reads those and stops at the first table: a `code` inside
 * `[[CURRENCIES]]` is not the document's `code`.
 */
export function parseToml(text: string): StellarToml {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break; // into the tables; nothing top-level follows
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (!(key in out)) out[key] = value;
  }
  return out as StellarToml;
}

/** A Corridor Reference as an anchor-facing string, for SEP fields. */
export const referenceField = (ref: Hex): string => `corridor:${ref.slice(2)}`;
