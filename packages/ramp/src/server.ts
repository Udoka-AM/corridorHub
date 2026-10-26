import { X402Charger, type X402Options } from "./x402.ts";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Fiat } from "@corridor/core";
import { RampError } from "./errors.ts";
import type { PlanId } from "./fees.ts";
import type { SpendingPolicy } from "./keys.ts";
import { orderView, quoteView, tenantView, tronView, type Caller, type RampService } from "./service.ts";
import { toJson, type RampOrder } from "./store.ts";

/**
 * Ramp's HTTP API, `/v1`. JSON in and out; amounts are integer strings in
 * minor units. Authenticate with `Authorization: Bearer <api key>`. Any POST
 * may carry an `Idempotency-Key`; a retry with the same key and body gets
 * the first response back instead of a second order.
 */
export interface RampServerOptions {
  /** Operator token for creating paid-plan apps. Omit to disable `POST /v1/tenants`. */
  adminToken?: string;
  /** Let anyone create a free sandbox app with `POST /v1/signup` (testnet only). */
  selfServeSignup?: boolean;
  bodyLimit?: number;
  /** Per-API-key request budget (token bucket). Default 600/min; `false` disables it. */
  rateLimit?: { requestsPerMinute: number } | false;
  /**
   * Charge agents per call over x402. Omitted, every route is free and no
   * payment header is looked at.
   */
  x402?: X402Options;
  /**
   * One structured line per request. It carries the route template, status,
   * timing and the caller's app and key ids: never headers, bodies, query
   * strings or path values, so no API key, signed transaction or bank detail
   * can reach the logs.
   */
  log?: (entry: RequestLog) => void;
}

export interface RequestLog {
  at: string;
  requestId: string;
  method: string;
  /** The matched route template (`/v1/withdrawals/:id`), not the raw path. */
  route: string;
  status: number;
  ms: number;
  tenantId?: string;
  keyId?: string;
}

/** Token bucket per key: `requestsPerMinute` capacity, refilled continuously. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(id: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const t = this.now();
    const rate = this.perMinute / 60_000;
    const b = this.buckets.get(id) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    this.buckets.set(id, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    return { ok: false, retryAfterSeconds: Math.ceil((1 - b.tokens) / rate / 1000) };
  }
}

type Handler = (ctx: Ctx) => Promise<{ status?: number; body: unknown } | unknown>;

interface Ctx {
  req: IncomingMessage;
  params: string[];
  query: URLSearchParams;
  raw: string;
  body: Record<string, unknown>;
  caller: () => Promise<Caller>;
}

interface Route {
  method: string;
  path: string;
  pattern: RegExp;
  handler: Handler;
  /** Responses are stored against Idempotency-Key. */
  idempotent?: boolean;
}

export function rampHandler(ramp: RampService, opts: RampServerOptions = {}) {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler, idempotent = method === "POST") =>
    routes.push({ method, path, pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`), handler, idempotent });
  const limiter = opts.rateLimit === false ? undefined : new RateLimiter(opts.rateLimit?.requestsPerMinute ?? 600);
  const charger = opts.x402 ? new X402Charger(opts.x402) : undefined;

  on("GET", "/v1/health", async () => ({ ok: true, network: ramp.network, asset: ramp.asset }));

  on(
    "POST",
    "/v1/signup",
    async ({ body }) => {
      if (!opts.selfServeSignup) throw new RampError("forbidden", "self-serve signup is disabled");
      return { status: 201, body: await ramp.createTenant({ name: str(body.name, "name"), plan: "sandbox", webhookUrl: optStr(body.webhookUrl) }) };
    },
    false,
  );

  on(
    "POST",
    "/v1/tenants",
    async ({ req, body }) => {
      if (!opts.adminToken || bearer(req) !== opts.adminToken) throw new RampError("unauthorized", "operator token required");
      const plan = (optStr(body.plan) ?? "sandbox") as PlanId;
      return { status: 201, body: await ramp.createTenant({ name: str(body.name, "name"), plan, webhookUrl: optStr(body.webhookUrl) }) };
    },
    false,
  );

  on("GET", "/v1/me", async ({ caller }) => {
    const c = await caller();
    return { app: tenantView(c.tenant), key: { id: c.key.id, kind: c.key.kind, policy: c.key.policy ?? null } };
  });

  on("POST", "/v1/keys", async ({ caller, body }) => ({
    status: 201,
    body: await ramp.createKey(await caller(), {
      kind: (optStr(body.kind) as "secret" | "agent" | undefined) ?? "agent",
      label: optStr(body.label),
      policy: policy(body.policy),
      expiresInSeconds: body.expiresInSeconds === undefined ? undefined : Number(body.expiresInSeconds),
    }),
  }));
  on("POST", "/v1/keys/:id/rotate", async ({ caller, params, body }) => ({
    status: 201,
    body: await ramp.rotateKey(await caller(), params[0]!, { graceSeconds: body.graceSeconds === undefined ? undefined : Number(body.graceSeconds) }),
  }));
  on("GET", "/v1/keys", async ({ caller }) => ({ data: await ramp.listKeys(await caller()) }));
  on("DELETE", "/v1/keys/:id", async ({ caller, params }) => {
    await ramp.revokeKey(await caller(), params[0]!);
    return { revoked: params[0] };
  });

  on("GET", "/v1/webhook/dead-letters", async ({ caller }) => ({ data: await ramp.deadLetters(await caller()) }));
  on("POST", "/v1/webhook/dead-letters/:id/redeliver", async ({ caller, params }) => ramp.redeliver(await caller(), params[0]!));

  on("PUT", "/v1/webhook", async ({ caller, body }) => ramp.setWebhook(await caller(), body.url === null ? null : str(body.url, "url")));

  on("POST", "/v1/quotes", async ({ caller, body }) => ({
    status: 201,
    body: quoteView(
      await ramp.quote(await caller(), { kind: str(body.kind, "kind") as "withdrawal" | "deposit", currency: str(body.currency, "currency"), amount: amount(body.amount) }),
    ),
  }));

  on("POST", "/v1/accounts", async ({ caller, body }) => ({ status: 201, body: await ramp.createAccount(await caller(), { address: str(body.address, "address") }) }));
  on("POST", "/v1/accounts/:address/submit", async ({ caller, params, body }) =>
    ramp.submitAccount(await caller(), { address: params[0]!, signedXdr: str(body.signedXdr, "signedXdr"), hash: str(body.hash, "hash") }),
  );
  on("GET", "/v1/accounts/:address", async ({ caller, params }) => ramp.getAccount(await caller(), params[0]!));

  on("POST", "/v1/withdrawals", async ({ caller, body }) => {
    const b = obj(body.beneficiary, "beneficiary");
    const o = await ramp.createWithdrawal(await caller(), {
      quoteId: str(body.quoteId, "quoteId"),
      account: str(body.account, "account"),
      beneficiary: { bankCode: str(b.bankCode, "beneficiary.bankCode"), accountNumber: str(b.accountNumber, "beneficiary.accountNumber") },
      metadata: meta(body.metadata),
    });
    return { status: 201, body: orderView(o) };
  });
  on("POST", "/v1/withdrawals/:id/submit", async ({ caller, params, body }) =>
    orderView(await ramp.submitWithdrawal(await caller(), params[0]!, str(body.signedXdr, "signedXdr"))),
  );
  on("GET", "/v1/withdrawals/:id", async ({ caller, params }) => orderView(await kindOf(await ramp.getOrder(await caller(), params[0]!), "withdrawal")));

  // The Tron lane is registered before the generic deposit routes: the first
  // matching pattern wins, and `/v1/deposits/:id` would otherwise swallow
  // `/v1/deposits/tron`.
  on("POST", "/v1/deposits/tron/quotes", async ({ caller, body }) => ({
    status: 200,
    body: await ramp.quoteTron(await caller(), {
      account: str(body.account, "account"),
      amount: amount(body.amount),
      refundTo: str(body.refundTo, "refundTo"),
    }),
  }));

  on("POST", "/v1/deposits/tron", async ({ caller, body }) => ({
    status: 201,
    body: tronView(
      await ramp.createTronDeposit(await caller(), {
        account: str(body.account, "account"),
        amount: amount(body.amount),
        refundTo: str(body.refundTo, "refundTo"),
      }),
    ),
  }));

  on("GET", "/v1/deposits/tron", async ({ caller, query }) => ({
    data: (await ramp.listTronDeposits(await caller(), Math.min(Number(query.get("limit") ?? 25), 100))).map(tronView),
  }));

  on("GET", "/v1/deposits/tron/:id", async ({ caller, params }) => tronView(await ramp.getTronDeposit(await caller(), params[0]!)));

  on("POST", "/v1/deposits", async ({ caller, body }) => {
    const o = await ramp.createDeposit(await caller(), { quoteId: str(body.quoteId, "quoteId"), account: str(body.account, "account"), metadata: meta(body.metadata) });
    return { status: 201, body: depositView(ramp, o) };
  });
  on("GET", "/v1/deposits/:id", async ({ caller, params }) => depositView(ramp, kindOf(await ramp.getOrder(await caller(), params[0]!), "deposit")));

  on("GET", "/v1/orders", async ({ caller, query }) => {
    const kind = query.get("kind") as "withdrawal" | "deposit" | null;
    const limit = Math.min(Number(query.get("limit") ?? 50) || 50, 500);
    return { data: (await ramp.listOrders(await caller(), { kind: kind ?? undefined, limit })).map(orderView) };
  });

  on("GET", "/v1/usage", async ({ caller, query }) =>
    ramp.usage(await caller(), { since: date(query.get("since")), until: date(query.get("until")) }),
  );

  on("GET", "/v1/events", async ({ caller, query }) => ({
    data: await ramp.events(await caller(), { after: query.get("after") ?? undefined, limit: Math.min(Number(query.get("limit") ?? 100) || 100, 500) }),
  }));

  on(
    "POST",
    "/v1/partners/:id/webhook",
    async ({ req, params, raw }) => ramp.handlePartnerWebhook(params[0]!, raw, req.headers as Record<string, string | undefined>),
    false,
  );

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const started = performance.now();
    const supplied = headerOf(req, "x-request-id");
    const requestId = supplied && /^[\w.-]{1,64}$/.test(supplied) ? supplied : randomUUID();
    res.setHeader("x-request-id", requestId);
    let matched = "unmatched";
    let who: Caller | undefined;
    if (opts.log) {
      const log = opts.log;
      res.on("finish", () =>
        log({
          at: new Date().toISOString(),
          requestId,
          method: req.method ?? "",
          route: matched,
          status: res.statusCode,
          ms: Math.round(performance.now() - started),
          ...(who ? { tenantId: who.tenant.id, keyId: who.key.id } : {}),
        }),
      );
    }
    try {
      const url = new URL(req.url ?? "/", "http://ramp.local");
      if (req.method === "GET" && url.pathname.startsWith("/pay/")) {
        matched = "/pay/:id";
        return await payPage(ramp, decodeURIComponent(url.pathname.slice(5)), req, res);
      }
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
      if (route) matched = route.path;
      if (!route) {
        const known = routes.some((r) => r.pattern.test(url.pathname));
        throw new RampError(known ? "invalid_request" : "not_found", known ? `method ${req.method} not allowed` : `no route ${url.pathname}`);
      }
      const params = route.pattern.exec(url.pathname)!.slice(1).map(decodeURIComponent);
      const raw = req.method === "GET" || req.method === "DELETE" ? "" : await readBody(req, opts.bodyLimit ?? 1_000_000);
      let body: Record<string, unknown> = {};
      if (raw && route.pattern.source !== "^/v1/partners/([^/]+)/webhook$") {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new RampError("invalid_request", "body must be JSON");
        }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new RampError("invalid_request", "body must be a JSON object");
      }
      let cached: Caller | undefined;
      const caller = async () => {
        if (cached) return cached;
        const c = await ramp.authenticate(bearer(req));
        who = c;
        const verdict = limiter?.take(c.key.id);
        if (verdict && !verdict.ok) {
          throw new RampError("rate_limited", `rate limit exceeded; retry in ${verdict.retryAfterSeconds}s`, { retryAfterSeconds: verdict.retryAfterSeconds });
        }
        return (cached = c);
      };
      const ctx: Ctx = { req, params, query: url.searchParams, raw, body, caller };

      // x402: verify before the work. A route with no price stays free.
      let settle: (() => Promise<Record<string, string>>) | undefined;
      const price = charger?.priceOf(req.method!, route.path);
      if (charger && price !== undefined) {
        const outcome = await charger.charge({
          method: req.method!,
          path: route.path,
          price,
          signatureHeader: headerOf(req, "payment-signature"),
        });
        if (!outcome.paid) return send(res, outcome.status, outcome.body, outcome.headers);
        settle = outcome.settle;
      }
      // Settling only after the handler returns means a payout that failed is
      // not charged for.
      const settled = async () => (settle ? await settle() : undefined);

      const idemKey = route.idempotent ? headerOf(req, "idempotency-key") : undefined;
      if (idemKey) {
        const c = await caller();
        const requestHash = createHash("sha256").update(`${req.method} ${url.pathname}\n${raw}`).digest("hex");
        const prior = await ramp.store.idempotent(c.tenant.id, idemKey);
        if (prior) {
          if (prior.requestHash !== requestHash) throw new RampError("conflict", "Idempotency-Key was already used with a different request");
          return send(res, prior.status, prior.body, { "idempotent-replayed": "true" });
        }
        const out = normalize(await route.handler(ctx));
        await ramp.store.saveIdempotent(c.tenant.id, idemKey, requestHash, out.status, out.body);
        return send(res, out.status, out.body, await settled());
      }
      const out = normalize(await route.handler(ctx));
      return send(res, out.status, out.body, await settled());
    } catch (e) {
      if (e instanceof RampError) {
        const retry = e.code === "rate_limited" ? { "retry-after": String(e.details?.retryAfterSeconds ?? 60) } : undefined;
        return send(res, e.status, e.toJSON(), retry);
      }
      // The error object only: never the request, which may carry keys or signed transactions.
      console.error(`ramp: unhandled error (request ${requestId})`, e);
      return send(res, 500, { error: { code: "internal", message: "internal error", requestId } });
    }
  }
  /** The routes this handler serves, for the OpenAPI spec check. */
  handle.routes = routes.map((r) => ({ method: r.method, path: r.path }));
  return handle;
}

export function rampServer(ramp: RampService, opts: RampServerOptions = {}): Server {
  const handle = rampHandler(ramp, opts);
  return createServer((req, res) => void handle(req, res));
}

function normalize(out: unknown): { status: number; body: unknown } {
  if (out && typeof out === "object" && "body" in out && "status" in out) {
    const o = out as { status?: number; body: unknown };
    return { status: o.status ?? 200, body: toJson(o.body) };
  }
  return { status: 200, body: toJson(out) };
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function depositView(ramp: RampService, o: RampOrder) {
  return { ...orderView(o), collectionLink: ramp.collectionLink(o) };
}

function kindOf(o: RampOrder, kind: RampOrder["kind"]): RampOrder {
  if (o.kind !== kind) throw new RampError("not_found", `no ${kind} ${o.id}`);
  return o;
}

async function payPage(ramp: RampService, id: string, req: IncomingMessage, res: ServerResponse) {
  const page = await ramp.collectionPage(id);
  if ((headerOf(req, "accept") ?? "").includes("application/json")) return send(res, 200, toJson(page));
  const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const decimals = 2;
  const whole = page.fiatAmount / 10n ** BigInt(decimals);
  const frac = (page.fiatAmount % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pay ${esc(page.merchant)}</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem">
<h1>Pay ${esc(page.merchant)}</h1>
<p><strong>${esc(page.currency)} ${esc(`${whole}.${frac}`)}</strong></p>
${page.bank ? `<p>Transfer to:<br>${esc(page.bank.bank)}<br>Account ${esc(page.bank.accountNumber)}<br>${esc(page.bank.accountName)}</p>` : "<p>Bank details are not available yet.</p>"}
<p>Status: ${esc(page.status)}</p></body>`);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = headerOf(req, "authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : undefined;
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new RampError("invalid_request", `${field} is required`);
  return v;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function obj(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new RampError("invalid_request", `${field} is required`);
  return v as Record<string, unknown>;
}

/** Amounts are integer minor units, as a string (or a safe integer). */
export function amount(v: unknown, field = "amount"): bigint {
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new RampError("invalid_request", `${field} must be an integer string in minor units`);
}

function policy(v: unknown): SpendingPolicy | undefined {
  if (v === undefined || v === null) return undefined;
  const p = obj(v, "policy");
  return {
    ...(p.maxPerPayout !== undefined ? { maxPerPayout: amount(p.maxPerPayout, "policy.maxPerPayout") } : {}),
    ...(p.dailyLimit !== undefined ? { dailyLimit: amount(p.dailyLimit, "policy.dailyLimit") } : {}),
    ...(p.currencies !== undefined ? { currencies: currencies(p.currencies) } : {}),
  };
}

function currencies(v: unknown): Fiat[] {
  if (!Array.isArray(v) || v.some((c) => typeof c !== "string")) throw new RampError("invalid_request", "policy.currencies must be a list of currency codes");
  return v as Fiat[];
}

function meta(v: unknown): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  const m = obj(v, "metadata");
  if (Object.values(m).some((x) => typeof x !== "string")) throw new RampError("invalid_request", "metadata values must be strings");
  return m as Record<string, string>;
}

function date(v: string | null): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new RampError("invalid_request", `bad date ${v}`);
  return d;
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new RampError("invalid_request", "body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
