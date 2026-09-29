import { isShieldedVenue, type Asset, type CorridorCode, type Venue } from "@corridor/core";

/**
 * Route graph. Nodes are (venue, asset) positions; edges are leg kinds that
 * the saga engine knows how to execute. A payout is a path from the
 * customer's settlement balance to its destination. "Shielded" is a
 * constraint on where the path ends, not a separate subsystem.
 */

export type LegKind =
  | "ledger.reserve"
  | "tempo.dexSwap"
  | "tempo.transfer"
  | "across.bridge"
  | "bridge.simulated"
  | "solana.transfer"
  | "partner.payout"
  | "near.swap"
  | "zcash.shieldedBatch";

export interface Position {
  venue: Venue;
  asset: Asset;
}

export interface Edge {
  kind: LegKind;
  from: Position;
  to: Position;
  /** Relative cost for path selection (lower is preferred). */
  cost: number;
  /** Which environments may use this edge. */
  env?: Environment[];
}

export type Environment = "testnet" | "mainnet";

/**
 * Which Corridor Reference a leg carries on-chain.
 * - `payout`: the payout's own reference (public lane)
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

export interface RoutePlan {
  corridor: CorridorCode;
  privacy: "public" | "shielded";
  steps: PlannedStep[];
}

export interface RouteRequest {
  corridor: CorridorCode;
  privacy: "public" | "shielded";
  /** Where the customer's funds sit, normally pathUSD on Tempo. */
  source: Position;
  /** Public payouts end at the partner's fiat venue; shielded ones in the Ironwood pool. */
  destination: Position;
  env: Environment;
}

const p = (venue: Venue, asset: Asset): Position => ({ venue, asset });

/** The edges Corridor can execute. Venue-specific details live in the leg implementations. */
export const DEFAULT_EDGES: Edge[] = [
  { kind: "tempo.dexSwap", from: p("tempo", "USDC.e"), to: p("tempo", "pathUSD"), cost: 1 },
  // Live Across: no direct Tempo↔Solana route, so two hops via Base.
  { kind: "across.bridge", from: p("tempo", "pathUSD"), to: p("base", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "across.bridge", from: p("base", "USDC"), to: p("solana", "USDC"), cost: 2, env: ["mainnet"] },
  // Same interface, used where Across has no deployment (Tempo testnet).
  { kind: "bridge.simulated", from: p("tempo", "pathUSD"), to: p("solana", "USDC"), cost: 3, env: ["testnet"] },
  { kind: "partner.payout", from: p("solana", "USDC"), to: p("partner_fiat", "NGN"), cost: 1 },
  { kind: "partner.payout", from: p("solana", "USDC"), to: p("partner_fiat", "KES"), cost: 1 },
  { kind: "near.swap", from: p("tempo", "pathUSD"), to: p("zcash_ironwood", "ZEC"), cost: 2 },
  { kind: "zcash.shieldedBatch", from: p("zcash_ironwood", "ZEC"), to: p("zcash_ironwood", "ZEC"), cost: 1 },
];

const key = (x: Position) => `${x.venue}/${x.asset}`;

export class NoRouteError extends Error {}

export function planRoute(req: RouteRequest, edges: Edge[] = DEFAULT_EDGES): RoutePlan {
  if (req.privacy === "shielded" && !isShieldedVenue(req.destination.venue)) {
    throw new NoRouteError("a shielded payout must end in a shielded venue");
  }
  if (req.privacy === "public" && isShieldedVenue(req.destination.venue)) {
    throw new NoRouteError("a public payout cannot end in a shielded venue");
  }

  const usable = edges.filter((e) => !e.env || e.env.includes(req.env));
  const path = cheapestPath(req.source, req.destination, usable);
  if (!path) {
    throw new NoRouteError(`no ${req.env} route from ${key(req.source)} to ${key(req.destination)}`);
  }

  // Shielded payouts always end with the batch leg that pays recipients inside the pool.
  if (req.privacy === "shielded") {
    const batch = usable.find((e) => e.kind === "zcash.shieldedBatch");
    if (!batch) throw new NoRouteError("no shielded batch leg available");
    path.push(batch);
  }

  const legs: Edge[] = [
    // Every route starts by holding the customer's funds in the ledger.
    { kind: "ledger.reserve", from: req.source, to: req.source, cost: 0 },
    ...path,
  ];

  return {
    corridor: req.corridor,
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

function scopeFor(privacy: RouteRequest["privacy"], e: Edge): ReferenceScope {
  if (privacy === "public") return "payout";
  return isShieldedVenue(e.from.venue) && isShieldedVenue(e.to.venue) ? "item" : "batch";
}

/** Dijkstra over positions. Graphs are tiny, so a linear scan is fine. */
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
