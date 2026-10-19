import type { Asset, Fiat, Hex } from "@corridor/core";
import type { Db } from "@corridor/ledger";
import type { Beneficiary, VirtualAccount } from "@corridor/partners";
import type { PlanId } from "./fees.ts";
import { policyFromJson, policyToJson, type KeyKind, type SpendingPolicy } from "./keys.ts";

/**
 * Ramp's own tables, next to the ledger in the same database. One database
 * serves every app; each row is scoped by `tenant_id`, and every query below
 * filters on it, so one app can never read another's orders.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ramp_tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL,
  network TEXT NOT NULL,
  webhook_url TEXT,
  webhook_secret TEXT NOT NULL,
  ref_secret TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ramp_api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES ramp_tenants(id),
  hash TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  label TEXT,
  policy JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ramp_quotes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES ramp_tenants(id),
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS ramp_accounts (
  tenant_id TEXT NOT NULL REFERENCES ramp_tenants(id),
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  tx_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address)
);
CREATE TABLE IF NOT EXISTS ramp_orders (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES ramp_tenants(id),
  key_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  partner TEXT NOT NULL,
  partner_order_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (partner, partner_order_id)
);
CREATE INDEX IF NOT EXISTS ramp_orders_tenant ON ramp_orders (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS ramp_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES ramp_tenants(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS ramp_events_tenant ON ramp_events (tenant_id, created_at);
CREATE TABLE IF NOT EXISTS ramp_idempotency (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INT NOT NULL,
  body JSONB NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
`;

export interface Tenant {
  id: string;
  name: string;
  plan: PlanId;
  network: "testnet" | "mainnet";
  webhookUrl?: string;
  webhookSecret: string;
  /** Keys the customer tag inside each Corridor Reference this app's orders carry. */
  refSecret: string;
  createdAt: Date;
}

export interface ApiKey {
  id: string;
  tenantId: string;
  kind: KeyKind;
  label?: string;
  policy?: SpendingPolicy;
}

export type OrderKind = "withdrawal" | "deposit";

export interface Quote {
  id: string;
  tenantId: string;
  kind: OrderKind;
  currency: Fiat;
  /** The Stellar asset the user holds and settles in. */
  asset: Asset;
  partner: string;
  /** Settlement minor units: what the anchor receives (withdrawal) or delivers (deposit). */
  amount: bigint;
  /** Fiat minor units: what the beneficiary receives (withdrawal) or the payer sends (deposit). */
  fiatAmount: bigint;
  /** Ramp's fee in settlement minor units. */
  fee: bigint;
  /** Settlement units the user sends (withdrawal) or receives (deposit), fee included. */
  total: bigint;
  rate: string;
  expiresAt: Date;
  createdAt: Date;
}

export type OrderStatus =
  | "awaiting_signature"
  | "awaiting_payment"
  | "submitted"
  | "processing"
  | "completed"
  | "failed";

export interface RampOrder {
  id: string;
  tenantId: string;
  keyId: string;
  kind: OrderKind;
  status: OrderStatus;
  currency: Fiat;
  asset: Asset;
  amount: bigint;
  fiatAmount: bigint;
  fee: bigint;
  total: bigint;
  rate: string;
  /** The end user's Stellar account: the source of a withdrawal, the recipient of a deposit. */
  account: string;
  beneficiary?: Beneficiary;
  partner: string;
  partnerOrderId: string;
  partnerStatus: string;
  reference: Hex;
  /** Unsigned funding transaction for the user to sign (withdrawals). */
  unsignedXdr?: string;
  /** Hash of that transaction; a submitted transaction must match it. */
  xdrHash?: string;
  txHash?: string;
  virtualAccount?: VirtualAccount;
  metadata?: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

export interface RampEvent {
  id: string;
  type: string;
  createdAt: Date;
  data: unknown;
}

const BIGINT_FIELDS = ["amount", "fiatAmount", "fee", "total"] as const;

export function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

function revive<T extends object>(row: Record<string, unknown>, dates: string[]): T {
  const out: Record<string, unknown> = { ...row };
  for (const f of BIGINT_FIELDS) if (typeof out[f] === "string") out[f] = BigInt(out[f] as string);
  for (const f of dates) if (out[f]) out[f] = new Date(out[f] as string);
  return out as T;
}

export class RampStore {
  private constructor(readonly db: Db) {}

  static async open(db: Db): Promise<RampStore> {
    await db.exec(SCHEMA);
    return new RampStore(db);
  }

  async createTenant(t: Tenant): Promise<void> {
    await this.db.query(
      `INSERT INTO ramp_tenants (id, name, plan, network, webhook_url, webhook_secret, ref_secret, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [t.id, t.name, t.plan, t.network, t.webhookUrl ?? null, t.webhookSecret, t.refSecret, t.createdAt],
    );
  }

  async tenant(id: string): Promise<Tenant | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(`SELECT * FROM ramp_tenants WHERE id = $1`, [id]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id as string,
      name: r.name as string,
      plan: r.plan as PlanId,
      network: r.network as Tenant["network"],
      webhookUrl: (r.webhook_url as string | null) ?? undefined,
      webhookSecret: r.webhook_secret as string,
      refSecret: r.ref_secret as string,
      createdAt: new Date(r.created_at as string),
    };
  }

  async updateWebhook(tenantId: string, url: string | null): Promise<void> {
    await this.db.query(`UPDATE ramp_tenants SET webhook_url = $2 WHERE id = $1`, [tenantId, url]);
  }

  async addKey(k: ApiKey & { hash: string }): Promise<void> {
    await this.db.query(`INSERT INTO ramp_api_keys (id, tenant_id, hash, kind, label, policy) VALUES ($1,$2,$3,$4,$5,$6)`, [
      k.id,
      k.tenantId,
      k.hash,
      k.kind,
      k.label ?? null,
      k.policy ? JSON.stringify(policyToJson(k.policy)) : null,
    ]);
  }

  async keyByHash(hash: string): Promise<ApiKey | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, tenant_id, kind, label, policy FROM ramp_api_keys WHERE hash = $1 AND revoked_at IS NULL`,
      [hash],
    );
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id as string,
      tenantId: r.tenant_id as string,
      kind: r.kind as KeyKind,
      label: (r.label as string | null) ?? undefined,
      policy: policyFromJson(r.policy),
    };
  }

  async listKeys(tenantId: string): Promise<ApiKey[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, tenant_id, kind, label, policy FROM ramp_api_keys WHERE tenant_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      kind: r.kind as KeyKind,
      label: (r.label as string | null) ?? undefined,
      policy: policyFromJson(r.policy),
    }));
  }

  async revokeKey(tenantId: string, id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE ramp_api_keys SET revoked_at = now() WHERE tenant_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING id`,
      [tenantId, id],
    );
    return rows.length > 0;
  }

  async saveQuote(q: Quote): Promise<void> {
    await this.db.query(`INSERT INTO ramp_quotes (id, tenant_id, data, expires_at) VALUES ($1,$2,$3,$4)`, [
      q.id,
      q.tenantId,
      JSON.stringify(toJson(q)),
      q.expiresAt,
    ]);
  }

  async quote(tenantId: string, id: string): Promise<(Quote & { usedAt?: Date }) | undefined> {
    const { rows } = await this.db.query<{ data: Record<string, unknown>; used_at: string | null }>(
      `SELECT data, used_at FROM ramp_quotes WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    const r = rows[0];
    if (!r) return undefined;
    const q = revive<Quote>(r.data, ["expiresAt", "createdAt"]);
    return r.used_at ? { ...q, usedAt: new Date(r.used_at) } : q;
  }

  /** Spend a quote exactly once. False when another request already used it. */
  async useQuote(tenantId: string, id: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE ramp_quotes SET used_at = now() WHERE tenant_id = $1 AND id = $2 AND used_at IS NULL RETURNING id`,
      [tenantId, id],
    );
    return rows.length > 0;
  }

  async releaseQuote(tenantId: string, id: string): Promise<void> {
    await this.db.query(`UPDATE ramp_quotes SET used_at = NULL WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  }

  async upsertAccount(tenantId: string, address: string, status: "pending" | "active", txHash?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ramp_accounts (tenant_id, address, status, tx_hash) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, address) DO UPDATE SET status = EXCLUDED.status, tx_hash = COALESCE(EXCLUDED.tx_hash, ramp_accounts.tx_hash)`,
      [tenantId, address, status, txHash ?? null],
    );
  }

  async account(tenantId: string, address: string): Promise<{ address: string; status: string; txHash?: string } | undefined> {
    const { rows } = await this.db.query<{ address: string; status: string; tx_hash: string | null }>(
      `SELECT address, status, tx_hash FROM ramp_accounts WHERE tenant_id = $1 AND address = $2`,
      [tenantId, address],
    );
    const r = rows[0];
    return r ? { address: r.address, status: r.status, ...(r.tx_hash ? { txHash: r.tx_hash } : {}) } : undefined;
  }

  async insertOrder(o: RampOrder): Promise<void> {
    await this.db.query(
      `INSERT INTO ramp_orders (id, tenant_id, key_id, kind, partner, partner_order_id, created_at, data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [o.id, o.tenantId, o.keyId, o.kind, o.partner, o.partnerOrderId, o.createdAt, JSON.stringify(toJson(o))],
    );
  }

  async updateOrder(o: RampOrder): Promise<void> {
    await this.db.query(`UPDATE ramp_orders SET data = $3 WHERE tenant_id = $1 AND id = $2`, [o.tenantId, o.id, JSON.stringify(toJson(o))]);
  }

  async order(tenantId: string, id: string): Promise<RampOrder | undefined> {
    const { rows } = await this.db.query<{ data: Record<string, unknown> }>(`SELECT data FROM ramp_orders WHERE tenant_id = $1 AND id = $2`, [
      tenantId,
      id,
    ]);
    return rows[0] ? revive<RampOrder>(rows[0].data, ["createdAt", "updatedAt"]) : undefined;
  }

  async orderByPartner(partner: string, partnerOrderId: string): Promise<RampOrder | undefined> {
    const { rows } = await this.db.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ramp_orders WHERE partner = $1 AND partner_order_id = $2`,
      [partner, partnerOrderId],
    );
    return rows[0] ? revive<RampOrder>(rows[0].data, ["createdAt", "updatedAt"]) : undefined;
  }

  async orders(tenantId: string, opts: { since?: Date; until?: Date; kind?: OrderKind; limit?: number } = {}): Promise<RampOrder[]> {
    const { rows } = await this.db.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ramp_orders WHERE tenant_id = $1
         AND ($2::timestamptz IS NULL OR created_at >= $2) AND ($3::timestamptz IS NULL OR created_at < $3)
         AND ($4::text IS NULL OR kind = $4)
       ORDER BY created_at DESC LIMIT $5`,
      [tenantId, opts.since ?? null, opts.until ?? null, opts.kind ?? null, opts.limit ?? 1000],
    );
    return rows.map((r) => revive<RampOrder>(r.data, ["createdAt", "updatedAt"]));
  }

  /** Settlement units this key has committed to payouts since `since`, failed payouts excluded. */
  async spentByKey(keyId: string, since: Date): Promise<bigint> {
    const { rows } = await this.db.query<{ data: Record<string, unknown> }>(
      `SELECT data FROM ramp_orders WHERE key_id = $1 AND kind = 'withdrawal' AND created_at >= $2`,
      [keyId, since],
    );
    return rows.map((r) => r.data).filter((d) => d.status !== "failed").reduce((s, d) => s + BigInt(d.amount as string), 0n);
  }

  async addEvent(tenantId: string, e: RampEvent): Promise<void> {
    await this.db.query(`INSERT INTO ramp_events (id, tenant_id, type, payload, created_at) VALUES ($1,$2,$3,$4,$5)`, [
      e.id,
      tenantId,
      e.type,
      JSON.stringify(toJson(e)),
      e.createdAt,
    ]);
  }

  async events(tenantId: string, opts: { after?: string; limit?: number } = {}): Promise<RampEvent[]> {
    const { rows } = await this.db.query<{ payload: RampEvent }>(
      `SELECT payload FROM ramp_events WHERE tenant_id = $1 AND ($2::text IS NULL OR id > $2) ORDER BY id LIMIT $3`,
      [tenantId, opts.after ?? null, opts.limit ?? 100],
    );
    return rows.map((r) => r.payload);
  }

  async undelivered(limit = 100): Promise<Array<{ tenantId: string; event: RampEvent; attempts: number }>> {
    const { rows } = await this.db.query<{ tenant_id: string; payload: RampEvent; attempts: number }>(
      `SELECT tenant_id, payload, attempts FROM ramp_events WHERE delivered_at IS NULL ORDER BY id LIMIT $1`,
      [limit],
    );
    return rows.map((r) => ({ tenantId: r.tenant_id, event: r.payload, attempts: r.attempts }));
  }

  async markDelivery(id: string, error?: string): Promise<void> {
    await this.db.query(
      error
        ? `UPDATE ramp_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`
        : `UPDATE ramp_events SET attempts = attempts + 1, delivered_at = now(), last_error = NULL WHERE id = $1`,
      error ? [id, error] : [id],
    );
  }

  async idempotent(tenantId: string, key: string): Promise<{ requestHash: string; status: number; body: unknown } | undefined> {
    const { rows } = await this.db.query<{ request_hash: string; status: number; body: unknown }>(
      `SELECT request_hash, status, body FROM ramp_idempotency WHERE tenant_id = $1 AND key = $2`,
      [tenantId, key],
    );
    const r = rows[0];
    return r ? { requestHash: r.request_hash, status: r.status, body: r.body } : undefined;
  }

  async saveIdempotent(tenantId: string, key: string, requestHash: string, status: number, body: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO ramp_idempotency (tenant_id, key, request_hash, status, body) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [tenantId, key, requestHash, status, JSON.stringify(body)],
    );
  }
}
