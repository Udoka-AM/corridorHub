import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The Ramp SDK: a typed client for the hosted Ramp API.
 *
 * No dependencies. Ramp never holds your users' keys, so anything that moves
 * a user's funds comes back as an unsigned Stellar transaction; pass a
 * `signXdr` function (Privy, Stellar Wallets Kit, a passkey wallet, a local
 * keypair in tests) and the `send`/`onboard` helpers sign and submit for you.
 *
 * Amounts are integer minor units as strings: 7 decimals for the settlement
 * asset (10 USDC = "100000000"), the currency's own decimals for fiat
 * (KES 1,000.00 = "100000").
 */

export type Kind = "withdrawal" | "deposit";
export type OrderStatus = "awaiting_signature" | "awaiting_payment" | "submitted" | "processing" | "completed" | "failed";
export type Amount = string | bigint | number;

export interface Quote {
  id: string;
  kind: Kind;
  currency: string;
  asset: string;
  partner: string;
  amount: string;
  fiatAmount: string;
  fee: string;
  total: string;
  rate: string;
  expiresAt: string;
  createdAt: string;
}

export interface Beneficiary {
  bankCode: string;
  accountNumber: string;
  accountName?: string;
}

export interface Order {
  id: string;
  kind: Kind;
  status: OrderStatus;
  currency: string;
  asset: string;
  amount: string;
  fiatAmount: string;
  fee: string;
  total: string;
  rate: string;
  account: string;
  beneficiary?: Beneficiary;
  partner: string;
  partnerOrderId: string;
  partnerStatus: string;
  /** The 32-byte Corridor Reference: the same id a Hub deployment reconciles on. */
  reference: string;
  /** Present while a withdrawal waits for the user's signature. */
  transaction?: { xdr: string; hash: string };
  txHash?: string;
  virtualAccount?: { bank: string; accountNumber: string; accountName: string };
  /** Deposits: a hosted page showing the payer where to send money. */
  collectionLink?: string;
  metadata?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

export interface App {
  id: string;
  name: string;
  plan: string;
  network: "testnet" | "mainnet";
  webhookUrl: string | null;
  createdAt: string;
}

export interface SpendingPolicy {
  maxPerPayout?: Amount;
  dailyLimit?: Amount;
  currencies?: string[];
}

export interface RampEvent {
  id: string;
  type: "order.created" | "order.updated" | "account.active" | string;
  createdAt: string;
  data: unknown;
}

export interface AccountOnboarding {
  address: string;
  status: "pending" | "active";
  asset: string;
  xdr: string;
  hash: string;
}

/** Signs a base64 transaction envelope and returns the signed envelope. */
export type SignXdr = (xdr: string, ctx: { purpose: "onboard" | "withdrawal"; network: "testnet" | "mainnet" }) => Promise<string>;

export interface RampOptions {
  apiKey: string;
  /** Defaults to http://localhost:8787. */
  baseUrl?: string;
  signXdr?: SignXdr;
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /** Makes a POST safe to retry: the same key returns the first result. */
  idempotencyKey?: string;
}

export class RampApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RampApiError";
  }
}

const DEFAULT_BASE_URL = "http://localhost:8787";

export class Ramp {
  private readonly baseUrl: string;
  private readonly http: typeof fetch;
  private network?: "testnet" | "mainnet";

  constructor(private readonly opts: RampOptions) {
    if (!opts.apiKey) throw new Error("Ramp needs an apiKey");
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.http = opts.fetch ?? fetch;
  }

  /** Create a free sandbox app (testnet). Returns its secret key and webhook secret once. */
  static async signup(args: { name: string; webhookUrl?: string; baseUrl?: string; fetch?: typeof fetch }) {
    const res = await (args.fetch ?? fetch)(`${(args.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "")}/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: args.name, webhookUrl: args.webhookUrl }),
    });
    return parse<{ app: App; secretKey: string; webhookSecret: string }>(res, (b) => ({ app: b.tenant, secretKey: b.secretKey, webhookSecret: b.webhookSecret }));
  }

  me() {
    return this.request<{ app: App; key: { id: string; kind: "secret" | "agent"; policy: SpendingPolicy | null } }>("GET", "/v1/me");
  }

  readonly quotes = {
    /** `amount`: settlement minor units for a withdrawal, fiat minor units for a deposit. */
    create: (args: { kind: Kind; currency: string; amount: Amount }, o?: RequestOptions) =>
      this.request<Quote>("POST", "/v1/quotes", { ...args, amount: str(args.amount) }, o),
  };

  readonly accounts = {
    create: (args: { address: string }, o?: RequestOptions) => this.request<AccountOnboarding>("POST", "/v1/accounts", args, o),
    submit: (address: string, args: { signedXdr: string; hash: string }) =>
      this.request<{ address: string; status: "active"; txHash: string }>("POST", `/v1/accounts/${enc(address)}/submit`, args),
    get: (address: string) => this.request<{ address: string; status: string; txHash?: string }>("GET", `/v1/accounts/${enc(address)}`),
    /** Sponsored onboarding in one call: the account is created and the settlement asset enabled, with no XLM needed. */
    onboard: async (address: string, sign?: SignXdr) => {
      const pending = await this.accounts.create({ address });
      const signedXdr = await this.sign(pending.xdr, "onboard", sign);
      return this.accounts.submit(address, { signedXdr, hash: pending.hash });
    },
  };

  readonly withdrawals = {
    create: (args: { quoteId: string; account: string; beneficiary: Beneficiary; metadata?: Record<string, string> }, o?: RequestOptions) =>
      this.request<Order>("POST", "/v1/withdrawals", args, o),
    submit: (id: string, signedXdr: string) => this.request<Order>("POST", `/v1/withdrawals/${enc(id)}/submit`, { signedXdr }),
    get: (id: string) => this.request<Order>("GET", `/v1/withdrawals/${enc(id)}`),
    /**
     * Quote, open, sign and submit a payout in one call. Pass an
     * `idempotencyKey` so a retried call never opens a second payout.
     */
    send: async (
      args: { currency: string; amount: Amount; account: string; beneficiary: Beneficiary; metadata?: Record<string, string>; idempotencyKey?: string },
      sign?: SignXdr,
    ) => {
      const k = args.idempotencyKey;
      const quote = await this.quotes.create({ kind: "withdrawal", currency: args.currency, amount: args.amount }, k ? { idempotencyKey: `${k}:quote` } : undefined);
      const order = await this.withdrawals.create(
        { quoteId: quote.id, account: args.account, beneficiary: args.beneficiary, metadata: args.metadata },
        k ? { idempotencyKey: `${k}:order` } : undefined,
      );
      if (order.status !== "awaiting_signature" || !order.transaction) return order;
      const signedXdr = await this.sign(order.transaction.xdr, "withdrawal", sign);
      return this.withdrawals.submit(order.id, signedXdr);
    },
  };

  readonly deposits = {
    create: (args: { quoteId: string; account: string; metadata?: Record<string, string> }, o?: RequestOptions) =>
      this.request<Order>("POST", "/v1/deposits", args, o),
    get: (id: string) => this.request<Order>("GET", `/v1/deposits/${enc(id)}`),
    /** Quote and open a collection; share `collectionLink` with the payer. */
    collect: async (args: { currency: string; fiatAmount: Amount; account: string; metadata?: Record<string, string>; idempotencyKey?: string }) => {
      const k = args.idempotencyKey;
      const quote = await this.quotes.create({ kind: "deposit", currency: args.currency, amount: args.fiatAmount }, k ? { idempotencyKey: `${k}:quote` } : undefined);
      return this.deposits.create({ quoteId: quote.id, account: args.account, metadata: args.metadata }, k ? { idempotencyKey: `${k}:order` } : undefined);
    },
  };

  readonly orders = {
    list: async (args: { kind?: Kind; limit?: number } = {}) =>
      (await this.request<{ data: Order[] }>("GET", `/v1/orders${qs({ kind: args.kind, limit: args.limit })}`)).data,
    /** Poll until the order is completed or failed. */
    wait: async (id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}) => {
      const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
      const get = id.startsWith("dp_") ? this.deposits.get : this.withdrawals.get;
      for (;;) {
        const o = await get(id);
        if (o.status === "completed" || o.status === "failed") return o;
        if (Date.now() > deadline) throw new RampApiError(408, "timeout", `order ${id} still ${o.status}`);
        await new Promise((r) => setTimeout(r, opts.intervalMs ?? 2_000));
      }
    },
  };

  readonly keys = {
    create: (args: { kind?: "secret" | "agent"; label?: string; policy?: SpendingPolicy } = {}) =>
      this.request<{ id: string; kind: string; label?: string; key: string }>("POST", "/v1/keys", {
        ...args,
        policy: args.policy && {
          ...args.policy,
          maxPerPayout: args.policy.maxPerPayout === undefined ? undefined : str(args.policy.maxPerPayout),
          dailyLimit: args.policy.dailyLimit === undefined ? undefined : str(args.policy.dailyLimit),
        },
      }),
    list: async () => (await this.request<{ data: Array<{ id: string; kind: string; label?: string }> }>("GET", "/v1/keys")).data,
    revoke: (id: string) => this.request<{ revoked: string }>("DELETE", `/v1/keys/${enc(id)}`),
  };

  readonly webhooks = {
    set: (url: string | null) => this.request<{ url: string | null; secret: string }>("PUT", "/v1/webhook", { url }),
  };

  readonly events = {
    list: async (args: { after?: string; limit?: number } = {}) =>
      (await this.request<{ data: RampEvent[] }>("GET", `/v1/events${qs({ after: args.after, limit: args.limit })}`)).data,
  };

  usage(args: { since?: Date; until?: Date } = {}) {
    return this.request<Record<string, unknown>>("GET", `/v1/usage${qs({ since: args.since?.toISOString(), until: args.until?.toISOString() })}`);
  }

  private async sign(xdr: string, purpose: "onboard" | "withdrawal", sign?: SignXdr): Promise<string> {
    const fn = sign ?? this.opts.signXdr;
    if (!fn) throw new Error("no signXdr: pass one to the Ramp constructor or to this call");
    this.network ??= (await this.request<{ network: "testnet" | "mainnet" }>("GET", "/v1/health")).network;
    return fn(xdr, { purpose, network: this.network });
  }

  private async request<T>(method: string, path: string, body?: unknown, o?: RequestOptions): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.opts.apiKey}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (o?.idempotencyKey) headers["idempotency-key"] = o.idempotencyKey;
    const res = await this.http(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return parse<T>(res);
  }
}

async function parse<T>(res: Response, map?: (b: any) => T): Promise<T> {
  const text = await res.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new RampApiError(res.status, "bad_response", `non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new RampApiError(res.status, e.code ?? "unknown", e.message ?? `HTTP ${res.status}`, e.details);
  }
  return map ? map(body) : (body as T);
}

const MAX_WEBHOOK_AGE_SECONDS = 300;

/**
 * Verify a Ramp webhook (`x-ramp-timestamp`, `x-ramp-signature`) against the
 * app's webhook secret, and return the event, or null when it does not
 * verify. Pass the raw request body, before any JSON parsing.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  now: Date = new Date(),
): RampEvent | null {
  const get = (name: string) => {
    const k = Object.keys(headers).find((h) => h.toLowerCase() === name);
    const v = k ? headers[k] : undefined;
    return Array.isArray(v) ? v[0] : v;
  };
  const ts = get("x-ramp-timestamp");
  const sig = get("x-ramp-signature");
  if (!ts || !sig || !Number.isFinite(Number(ts)) || Math.abs(now.getTime() / 1000 - Number(ts)) > MAX_WEBHOOK_AGE_SECONDS) return null;
  const expected = createHmac("sha256", secret).update(`${ts}.${rawBody}`).digest("hex");
  const ok = sig
    .split(/[,\s]+/)
    .filter((p) => p.startsWith("v1="))
    .some((p) => p.length - 3 === expected.length && timingSafeEqual(Buffer.from(p.slice(3)), Buffer.from(expected)));
  return ok ? (JSON.parse(rawBody) as RampEvent) : null;
}

/**
 * Agent payouts: tool definitions in the shape MCP servers and most agent
 * frameworks take (name, description, JSON-schema input, handler). Create
 * the client with an agent key so the key's spending policy applies; a
 * refused payout returns the `spending_limit` details for the agent to act on.
 */
export function agentTools(ramp: Ramp, sign?: SignXdr) {
  const run = async (fn: () => Promise<unknown>) => {
    try {
      return { ok: true, result: await fn() };
    } catch (e) {
      if (e instanceof RampApiError) return { ok: false, error: { code: e.code, message: e.message, details: e.details } };
      throw e;
    }
  };
  return [
    {
      name: "ramp_quote_payout",
      description: "Price a payout of stablecoin to a local-currency bank or mobile-money account. amount is settlement minor units (7 dp).",
      inputSchema: {
        type: "object",
        properties: { currency: { type: "string", description: "ISO 4217 code, e.g. KES" }, amount: { type: "string" } },
        required: ["currency", "amount"],
      },
      handler: (i: { currency: string; amount: string }) => run(() => ramp.quotes.create({ kind: "withdrawal", currency: i.currency, amount: i.amount })),
    },
    {
      name: "ramp_send_payout",
      description: "Send a local-currency payout from a Stellar account, within this key's spending limits.",
      inputSchema: {
        type: "object",
        properties: {
          currency: { type: "string" },
          amount: { type: "string" },
          account: { type: "string", description: "Paying Stellar account (G…)" },
          bankCode: { type: "string" },
          accountNumber: { type: "string" },
          idempotencyKey: { type: "string" },
        },
        required: ["currency", "amount", "account", "bankCode", "accountNumber", "idempotencyKey"],
      },
      handler: (i: { currency: string; amount: string; account: string; bankCode: string; accountNumber: string; idempotencyKey: string }) =>
        run(() =>
          ramp.withdrawals.send(
            {
              currency: i.currency,
              amount: i.amount,
              account: i.account,
              beneficiary: { bankCode: i.bankCode, accountNumber: i.accountNumber },
              idempotencyKey: i.idempotencyKey,
            },
            sign,
          ),
        ),
    },
    {
      name: "ramp_payout_status",
      description: "Get the status of a payout by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      handler: (i: { id: string }) => run(() => ramp.withdrawals.get(i.id)),
    },
  ];
}

function str(v: Amount): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) throw new RampApiError(400, "invalid_request", "amounts are non-negative integers in minor units");
    return String(v);
  }
  return v;
}

function enc(s: string) {
  return encodeURIComponent(s);
}

function qs(params: Record<string, string | number | undefined>) {
  const p = Object.entries(params).filter(([, v]) => v !== undefined) as [string, string | number][];
  return p.length ? `?${new URLSearchParams(p.map(([k, v]) => [k, String(v)]))}` : "";
}
