import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Observation } from "@corridor/core";
import type { Db } from "@corridor/ledger";
import type { OrderStatus, PartnerOrder, PartnerRegistry } from "@corridor/partners";

/**
 * Partner webhook ingest. Every delivery is authenticated against the
 * partner's signing secret on the raw body, stored exactly once per
 * (partner, order, status), and turned into an Observation for the shared
 * reconciliation engine. Legs waiting on a partner read the stored status
 * first and only poll the partner's API as a fallback.
 */

const SCHEMA = /* sql */ `
create table if not exists partner_events (
  partner     text not null,
  order_id    text not null,
  status      text not null,
  kind        text not null,
  reference   text,
  body        jsonb not null,
  received_at timestamptz not null default now(),
  primary key (partner, order_id, status)
);
create index if not exists partner_events_reference on partner_events (reference);

-- Which partner order a saga step opened, and whether Corridor already funded it.
-- Makes funding exactly-once across retries and crashes.
create table if not exists partner_order_links (
  idempotency_key text primary key,
  partner         text not null,
  order_id        text not null,
  funding_address text,
  funding_ref     text,
  created_at      timestamptz not null default now()
);
`;

const RANK: Record<OrderStatus, number> = { open: 0, processing: 1, completed: 2, failed: 2 };

export class PartnerEventStore {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<PartnerEventStore> {
    await db.exec(SCHEMA);
    return new PartnerEventStore(db);
  }

  /** Returns false when this exact status for this order was already recorded (a redelivery). */
  async record(order: PartnerOrder): Promise<boolean> {
    const { rows } = await this.db.query(
      `insert into partner_events (partner, order_id, status, kind, reference, body)
       values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning order_id`,
      [
        order.partner,
        order.id,
        order.status,
        order.kind,
        order.reference ?? null,
        JSON.stringify(order, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      ],
    );
    return rows.length === 1;
  }

  async linkOrder(key: string, partner: string, orderId: string, fundingAddress?: string): Promise<void> {
    await this.db.query(
      `insert into partner_order_links (idempotency_key, partner, order_id, funding_address) values ($1,$2,$3,$4)
       on conflict (idempotency_key) do nothing`,
      [key, partner, orderId, fundingAddress ?? null],
    );
  }

  async markFunded(key: string, fundingRef: string): Promise<void> {
    await this.db.query(`update partner_order_links set funding_ref = $2 where idempotency_key = $1`, [key, fundingRef]);
  }

  async linkedOrder(key: string): Promise<{ partner: string; orderId: string; fundingAddress?: string; fundingRef?: string } | undefined> {
    const { rows } = await this.db.query<{ partner: string; order_id: string; funding_address: string | null; funding_ref: string | null }>(
      `select partner, order_id, funding_address, funding_ref from partner_order_links where idempotency_key = $1`,
      [key],
    );
    const r = rows[0];
    return r && { partner: r.partner, orderId: r.order_id, fundingAddress: r.funding_address ?? undefined, fundingRef: r.funding_ref ?? undefined };
  }

  /** Most advanced status seen for an order (webhooks can arrive out of order). */
  async latest(partner: string, orderId: string): Promise<OrderStatus | undefined> {
    const { rows } = await this.db.query<{ status: OrderStatus }>(
      `select status from partner_events where partner = $1 and order_id = $2`,
      [partner, orderId],
    );
    return rows.map((r) => r.status).sort((a, b) => RANK[b] - RANK[a])[0];
  }
}

/** A completed partner order, as seen by reconciliation: the USDC that left (payout) or arrived (collection). */
export function partnerObservation(order: PartnerOrder): Observation | null {
  if (order.status !== "completed") return null;
  return {
    venue: "partner_fiat",
    externalRef: `${order.partner}:${order.id}`,
    reference: order.reference ?? null,
    asset: "USDC",
    amount: order.usdcAmount,
    to: order.kind === "collection" ? order.recipient : undefined,
    observedAt: new Date(),
  };
}

export interface WebhookResult {
  status: number;
  body: string;
  order?: PartnerOrder;
  fresh?: boolean;
}

export async function handlePartnerWebhook(
  registry: PartnerRegistry,
  store: PartnerEventStore,
  partnerId: string,
  rawBody: string,
  headers: Record<string, string | undefined>,
  onEvent?: (order: PartnerOrder, fresh: boolean) => Promise<void>,
): Promise<WebhookResult> {
  let partner;
  try {
    partner = registry.get(partnerId);
  } catch {
    return { status: 404, body: "unknown partner" };
  }
  if (!partner.verifyWebhook(rawBody, headers)) return { status: 401, body: "invalid signature" };
  let order: PartnerOrder;
  try {
    order = partner.parseWebhook(rawBody);
  } catch {
    return { status: 400, body: "unparseable payload" };
  }
  const fresh = await store.record(order);
  await onEvent?.(order, fresh);
  // 200 on redelivery too, so the partner stops retrying.
  return { status: 200, body: fresh ? "recorded" : "duplicate", order, fresh };
}

/** Minimal HTTP server: POST /webhooks/:partner. */
export function webhookServer(
  registry: PartnerRegistry,
  store: PartnerEventStore,
  onEvent?: (order: PartnerOrder, fresh: boolean) => Promise<void>,
): Server {
  return createServer(async (req, res) => {
    const m = /^\/webhooks\/([a-z0-9_-]+)\/?$/.exec(req.url ?? "");
    if (req.method !== "POST" || !m) {
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const raw = await readBody(req);
      const r = await handlePartnerWebhook(registry, store, m[1]!, raw, req.headers as Record<string, string>, onEvent);
      res.writeHead(r.status, { "content-type": "text/plain" }).end(r.body);
    } catch (err) {
      res.writeHead(500).end("error");
      console.error("webhook handling failed", err);
    }
  });
}

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("payload too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
