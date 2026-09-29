import { isShieldedVenue, type Asset, type CorridorCode, type Fiat, type Venue } from "@corridor/core";

/**
 * Route graph. Nodes are (venue, asset) positions; edges are leg kinds the
 * saga engine can execute.
 *
 * The network is hub-and-spoke with Tempo as the settlement hub:
 *   - a **collection** brings funds from a spoke into the customer's Tempo balance
 *   - a **payout** takes funds from that balance out to a spoke
 * A cross-border flow (e.g. a Nigerian importer paying a Chinese supplier) is
 * a collection in NGN followed by a payout in CNY/USD. N spokes need N
 * integrations, not N×N corridors, and every flow is settled, held and
 * reconciled on Tempo.
 *
 * "Shielded" is a constraint on where a payout ends, not a separate subsystem.
 */

export type LegKind =
  | "ledger.reserve"
  | "ledger.credit"
  | "tempo.dexSwap"
  | "tempo.transfer"
  | "across.bridge"
  | "bridge.simulated"
  | "solana.transfer"
  | "partner.collect"
  | "partner.payout"
  | "near.swap"
  | "zcash.shieldedBatch";

export interface Position {
  venue: Venue;
  asset: Asset;
}

export type Environment = "testnet" | "mainnet";

export interface Edge {
  kind: LegKind;
  from: Position;
  to: Position;
  /** Relative cost for path selection (lower is preferred). */
  cost: number;
  /** Which environments may use this edge. */
  env?: Environment[];
}

/**
 * Which Corridor Reference a leg carries on-chain.
 * - `payout`: the flow's own reference (public lane, collections)
 * - `batch`: only the batch reference, used on the public legs of a shielded
 *   route so the funding leg never reveals individual payouts
 * - `item`: per-recipient references, only ever inside encrypted Zcash memos
 */
export type ReferenceScope = "payout" | "batch" | "item";

export interface PlannedStep {
  index: number;
  kind: LegKind;
  from: Position;
  to: Position;
  referenceScope: ReferenceScope;
}

export type Purpose = "collection" | "payout";

export interface RoutePlan {
  corridor: CorridorCode;
  purpose: Purpose;
  privacy: "public" | "shielded";
  steps: PlannedStep[];
}

export interface RouteRequest {
  corridor: CorridorCode;
  /** Defaults to "payout". */
  purpose?: Purpose;
  privacy: "public" | "shielded";
  source: Position;
  destination: Position;
  env: Environment;
}

/** The hub: customer balances are held and settled here. */
export const HUB: Position = { venue: "tempo", asset: "pathUSD" };

/**
 * Where ramp partners can collect local currency (on-ramp) and pay it out
 * (off-ramp). Partner selection per currency happens in the partner registry;
 * see docs/ARCHITECTURE.md §2.1 for candidate partners per region.
 */
export const COLLECTION_CURRENCIES: readonly Fiat[] = [
  // Africa: importers and businesses paying abroad
  "NGN", "KES", "GHS", "ZAR", "EGP", "UGX", "XOF",
  // Diaspora and corporate senders
  "USD", "EUR", "GBP", "CAD",
];

export const PAYOUT_CURRENCIES: readonly Fiat[] = [
  // Africa
  "NGN", "KES", "GHS", "ZAR", "EGP", "UGX", "TZS", "RWF", "XOF", "XAF", "MAD",
  // Asia and Middle East: supplier payments for imports
  "CNY", "HKD", "INR", "AED", "SGD", "TRY", "IDR", "VND", "PHP", "JPY",
  // Americas
  "USD", "CAD", "MXN", "BRL", "COP", "ARS", "CLP", "PEN",
  // Europe
  "EUR", "GBP", "CHF",
];

const p = (venue: Venue, asset: Asset): Position => ({ venue, asset });

/** The edges Corridor can execute. Venue-specific details live in the leg implementations. */
export const DEFAULT_EDGES: Edge[] = [
  { kind: "tempo.dexSwap", from: p("tempo", "USDC.e"), to: p("tempo", "pathUSD"), cost: 1 },

  // Hub ↔ Solana liquidity. Live Across has no direct Tempo↔Solana route: two hops via Base.
  { kind: "across.bridge", from: p("tempo", "pathUSD"), to: p("base", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "across.bridge", from: p("base", "USDC"), to: p("solana", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "across.bridge", from: p("solana", "USDC"), to: p("base", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "across.bridge", from: p("base", "USDC"), to: p("tempo", "pathUSD"), cost: 2, env: ["mainnet"] },
  // Same interface where Across has no Tempo deployment (testnet).
  { kind: "bridge.simulated", from: p("tempo", "pathUSD"), to: p("solana", "USDC"), cost: 3, env: ["testnet"] },
  { kind: "bridge.simulated", from: p("solana", "USDC"), to: p("tempo", "pathUSD"), cost: 3, env: ["testnet"] },

  // Spokes: ramp partners collect and pay out local currency against USDC on Solana.
  ...COLLECTION_CURRENCIES.map((c): Edge => ({ kind: "partner.collect", from: p("partner_fiat", c), to: p("solana", "USDC"), cost: 1 })),
  ...PAYOUT_CURRENCIES.map((c): Edge => ({ kind: "partner.payout", from: p("solana", "USDC"), to: p("partner_fiat", c), cost: 1 })),

  // Shielded spoke: into the Ironwood pool, then one batch transaction to all recipients.
  { kind: "near.swap", from: p("tempo", "pathUSD"), to: p("zcash_ironwood", "ZEC"), cost: 2 },
  { kind: "zcash.shieldedBatch", from: p("zcash_ironwood", "ZEC"), to: p("zcash_ironwood", "ZEC"), cost: 1 },
];

const key = (x: Position) => `${x.venue}/${x.asset}`;

export class NoRouteError extends Error {}

export function planRoute(req: RouteRequest, edges: Edge[] = DEFAULT_EDGES): RoutePlan {
  const purpose = req.purpose ?? "payout";
  validate(req, purpose);

  // The batch leg is appended explicitly, so keep it out of path search.
  const usable = edges.filter((e) => (!e.env || e.env.includes(req.env)) && e.kind !== "zcash.shieldedBatch");
  const path = cheapestPath(req.source, req.destination, usable);
  if (!path) {
    throw new NoRouteError(`no ${req.env} ${purpose} route from ${key(req.source)} to ${key(req.destination)}`);
  }

  let legs: Edge[];
  if (purpose === "collection") {
    // Funds arrive on the hub, then the customer's balance is credited.
    legs = [...path, { kind: "ledger.credit", from: req.destination, to: req.destination, cost: 0 }];
  } else {
    legs = [{ kind: "ledger.reserve", from: req.source, to: req.source, cost: 0 }, ...path];
    if (req.privacy === "shielded") {
      const batch = edges.find((e) => e.kind === "zcash.shieldedBatch");
      if (!batch) throw new NoRouteError("no shielded batch leg available");
      legs.push(batch);
    }
  }

  return {
    corridor: req.corridor,
    purpose,
    privacy: req.privacy,
    steps: legs.map((e, index) => ({
      index,
      kind: e.kind,
      from: e.from,
      to: e.to,
      referenceScope: scopeFor(req.privacy, e),
    })),
  };
}

function validate(req: RouteRequest, purpose: Purpose): void {
  const onHub = (x: Position) => x.venue === HUB.venue;
  if (purpose === "payout" && !onHub(req.source)) {
    throw new NoRouteError("payouts are funded from the customer's balance on the Tempo hub");
  }
  if (purpose === "collection") {
    if (!onHub(req.destination)) throw new NoRouteError("collections settle into the Tempo hub");
    if (req.privacy !== "public") throw new NoRouteError("collections are public; privacy applies to payouts");
  }
  if (req.privacy === "shielded" && !isShieldedVenue(req.destination.venue)) {
    throw new NoRouteError("a shielded payout must end in a shielded venue");
  }
  if (req.privacy === "public" && isShieldedVenue(req.destination.venue)) {
    throw new NoRouteError("a public payout cannot end in a shielded venue");
  }
}

function scopeFor(privacy: RouteRequest["privacy"], e: Edge): ReferenceScope {
  if (privacy === "public") return "payout";
  return isShieldedVenue(e.from.venue) && isShieldedVenue(e.to.venue) ? "item" : "batch";
}

/** Dijkstra over positions. Graphs are small, so a linear scan is fine. */
function cheapestPath(from: Position, to: Position, edges: Edge[]): Edge[] | null {
  const dist = new Map<string, number>([[key(from), 0]]);
  const prev = new Map<string, Edge>();
  const done = new Set<string>();

  while (true) {
    let current: string | undefined;
    for (const [k, d] of dist) {
      if (!done.has(k) && (current === undefined || d < dist.get(current)!)) current = k;
    }
    if (current === undefined) return null;
    if (current === key(to)) break;
    done.add(current);
    for (const e of edges) {
      if (key(e.from) !== current || key(e.to) === current) continue;
      const d = dist.get(current)! + e.cost;
      if (d < (dist.get(key(e.to)) ?? Infinity)) {
        dist.set(key(e.to), d);
        prev.set(key(e.to), e);
      }
    }
  }

  const path: Edge[] = [];
  for (let k = key(to); k !== key(from); ) {
    const e = prev.get(k)!;
    path.unshift(e);
    k = key(e.from);
  }
  return path;
}
