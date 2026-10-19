import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Fiat } from "@corridor/core";
import { RampError } from "./errors.ts";
import type { PlanId } from "./fees.ts";
import type { SpendingPolicy } from "./keys.ts";
import { orderView, quoteView, tenantView, type Caller, type RampService } from "./service.ts";
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
  pattern: RegExp;
  handler: Handler;
  /** Responses are stored against Idempotency-Key. */
  idempotent?: boolean;
}

export function rampHandler(ramp: RampService, opts: RampServerOptions = {}) {
  const routes: Route[] = [];
  const on = (method: string, path: string, handler: Handler, idempotent = method === "POST") =>
    routes.push({ method, pattern: new RegExp(`^${path.replace(/:[a-zA-Z]+/g, "([^/]+)")}$`), handler, idempotent });

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
    }),
  }));
  on("GET", "/v1/keys", async ({ caller }) => ({ data: await ramp.listKeys(await caller()) }));
  on("DELETE", "/v1/keys/:id", async ({ caller, params }) => {
    await ramp.revokeKey(await caller(), params[0]!);
    return { revoked: params[0] };
  });

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

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    try {
      const url = new URL(req.url ?? "/", "http://ramp.local");
      if (req.method === "GET" && url.pathname.startsWith("/pay/")) return await payPage(ramp, decodeURIComponent(url.pathname.slice(5)), req, res);
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
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
      const caller = async () => (cached ??= await ramp.authenticate(bearer(req)));
      const ctx: Ctx = { req, params, query: url.searchParams, raw, body, caller };

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
        return send(res, out.status, out.body);
      }
      const out = normalize(await route.handler(ctx));
      return send(res, out.status, out.body);
    } catch (e) {
      if (e instanceof RampError) return send(res, e.status, e.toJSON());
      console.error("ramp: unhandled error", e);
      return send(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  };
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
