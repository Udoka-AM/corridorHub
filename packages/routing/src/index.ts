import { isShieldedVenue, type Asset, type CorridorCode, type Fiat, type Venue } from "@corridor/core";

/**
 * Route graph. Nodes are (venue, asset) positions; edges are leg kinds the
 * saga engine can execute.
 *
 * The network is hub-and-spoke with Stellar as the settlement hub:
 *   - a **collection** brings funds from a spoke into the customer's Stellar balance
 *   - a **payout** takes funds from that balance out to a spoke
 * A cross-border flow (e.g. a Nigerian importer paying a Chinese supplier) is
 * a collection in NGN followed by a payout in CNY/USD. N spokes need N
 * integrations, not N×N corridors, and every flow is settled, held and
 * reconciled on Stellar.
 *
 * Anchors are the fiat spokes and they settle on Stellar itself, so the
 * anchor leg touches the hub directly: no bridge hop stands between a payout
 * and the beneficiary's currency. Other chains only appear as inflows, where
 * USDC arrives over CCTP and is credited on the hub.
 */

export type LegKind =
  | "ledger.reserve"
  | "ledger.credit"
  /** Payment on Stellar carrying the reference as MEMO_HASH. */
  | "stellar.transfer"
  /** Strict-receive path payment: on-ledger FX between two issued assets. */
  | "stellar.pathPayment"
  /** USDC in from Base or Solana over CCTP. */
  | "cctp.transfer"
  | "bridge.simulated"
  | "solana.transfer"
  /** Anchor spokes, over the normalised partner interface (SEP-6/24/31/38). */
  | "partner.collect"
  | "partner.payout";

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
export const HUB: Position = { venue: "stellar", asset: "USDC" };

/**
 * Where ramp partners can collect local currency (on-ramp) and pay it out
 * (off-ramp). Partner selection per currency happens in the partner registry;
 * see docs/ARCHITECTURE.md §3 for the flows and regions.
 */
export const COLLECTION_CURRENCIES: readonly Fiat[] = [
  // Africa: importers and businesses paying abroad
  "KES", "XOF", "TZS", "NGN", "GHS", "ZAR", "EGP", "UGX",
  // Diaspora and corporate senders
  "USD", "EUR", "GBP", "CAD",
];

/**
 * Payout currencies, in the order corridors open: Kenyan shilling, West
 * African franc and Tanzanian shilling first, then naira through a licensed
 * partner, then Ghana and South Africa.
 */
export const PAYOUT_CURRENCIES: readonly Fiat[] = [
  // Africa
  "KES", "XOF", "TZS", "NGN", "GHS", "ZAR", "EGP", "UGX", "RWF", "XAF", "MAD",
  // Asia and Middle East: supplier payments for imports
  "CNY", "HKD", "INR", "AED", "SGD", "TRY", "IDR", "VND", "PHP", "JPY",
  // Americas
  "USD", "CAD", "MXN", "BRL", "COP", "ARS", "CLP", "PEN",
  // Europe
  "EUR", "GBP", "CHF",
];

/**
 * Currencies reachable only through an anchor that settles off Stellar, for
 * as long as no Stellar anchor holds the licence. Naira is the case that
 * matters: it goes out over a cross-chain partner until a licensed naira
 * anchor is live on Stellar, and moving it is then one line here.
 */
export const OFF_STELLAR_PAYOUT_CURRENCIES: readonly Fiat[] = ["NGN"];

/** The same, for collections. */
export const OFF_STELLAR_COLLECTION_CURRENCIES: readonly Fiat[] = ["NGN"];

const p = (venue: Venue, asset: Asset): Position => ({ venue, asset });

/** The edges Corridor can execute. Venue-specific details live in the leg implementations. */
export const DEFAULT_EDGES: Edge[] = [
  // On-ledger FX and stablecoin swaps, through Stellar's own order books.
  { kind: "stellar.pathPayment", from: p("stellar", "EURC"), to: p("stellar", "USDC"), cost: 1 },
  { kind: "stellar.pathPayment", from: p("stellar", "USDC"), to: p("stellar", "EURC"), cost: 1 },
  { kind: "stellar.pathPayment", from: p("stellar", "MGUSD"), to: p("stellar", "USDC"), cost: 1 },
  { kind: "stellar.pathPayment", from: p("stellar", "USDC"), to: p("stellar", "MGUSD"), cost: 1 },

  // Inflows from other chains. CCTP burns and mints canonical USDC, so no
  // wrapped asset ever reaches the hub.
  { kind: "cctp.transfer", from: p("base", "USDC"), to: p("stellar", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "cctp.transfer", from: p("solana", "USDC"), to: p("stellar", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "cctp.transfer", from: p("stellar", "USDC"), to: p("base", "USDC"), cost: 2, env: ["mainnet"] },
  { kind: "cctp.transfer", from: p("stellar", "USDC"), to: p("solana", "USDC"), cost: 2, env: ["mainnet"] },
  // Same interface where CCTP is not available to us (testnet).
  { kind: "bridge.simulated", from: p("stellar", "USDC"), to: p("solana", "USDC"), cost: 3, env: ["testnet"] },
  { kind: "bridge.simulated", from: p("solana", "USDC"), to: p("stellar", "USDC"), cost: 3, env: ["testnet"] },

  // Anchor spokes: local currency in and out against USDC on the hub itself.
  ...COLLECTION_CURRENCIES.filter((c) => !OFF_STELLAR_COLLECTION_CURRENCIES.includes(c)).map(
    (c): Edge => ({ kind: "partner.collect", from: p("partner_fiat", c), to: p("stellar", "USDC"), cost: 1 }),
  ),
  // Collected on Solana by a licensed partner, then brought to the hub.
  ...OFF_STELLAR_COLLECTION_CURRENCIES.map((c): Edge => ({ kind: "partner.collect", from: p("partner_fiat", c), to: p("solana", "USDC"), cost: 1 })),
  ...PAYOUT_CURRENCIES.filter((c) => !OFF_STELLAR_PAYOUT_CURRENCIES.includes(c)).map(
    (c): Edge => ({ kind: "partner.payout", from: p("stellar", "USDC"), to: p("partner_fiat", c), cost: 1 }),
  ),
  // Currencies whose licensed partner settles on Solana: one CCTP hop out of the hub.
  ...OFF_STELLAR_PAYOUT_CURRENCIES.map((c): Edge => ({ kind: "partner.payout", from: p("solana", "USDC"), to: p("partner_fiat", c), cost: 1 })),
];

const key = (x: Position) => `${x.venue}/${x.asset}`;

export class NoRouteError extends Error {}

export function planRoute(req: RouteRequest, edges: Edge[] = DEFAULT_EDGES): RoutePlan {
  const purpose = req.purpose ?? "payout";
  validate(req, purpose);

  const usable = edges.filter((e) => !e.env || e.env.includes(req.env));
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
    throw new NoRouteError("payouts are funded from the customer's balance on the Stellar hub");
  }
  if (purpose === "collection") {
    if (!onHub(req.destination)) throw new NoRouteError("collections settle into the Stellar hub");
    if (req.privacy !== "public") throw new NoRouteError("collections are public; privacy applies to payouts");
  }
  if (req.privacy === "shielded" && !isShieldedVenue(req.destination.venue)) {
    // No shielded venue is configured yet: the confidential lane lands with
    // Stellar confidential tokens and auditor keys (ADR 0005).
    throw new NoRouteError("no shielded venue is available: the confidential lane is not live yet");
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
