/**
 * Core domain model. Privacy is modelled as a venue (`zcash_ironwood`), not a
 * feature flag: shielded and public payouts are different paths through the
 * same route graph, booked in the same ledger. See docs/ARCHITECTURE.md §2.
 */

export const VENUES = ["tempo", "base", "solana", "partner_fiat", "zcash_ironwood"] as const;
export type Venue = (typeof VENUES)[number];

export const ASSETS = {
  pathUSD: { decimals: 6, currency: "USD" },
  "USDC.e": { decimals: 6, currency: "USD" },
  USDC: { decimals: 6, currency: "USD" },
  ZEC: { decimals: 8, currency: "ZEC" },
  NGN: { decimals: 2, currency: "NGN" },
  KES: { decimals: 2, currency: "KES" },
  EUR: { decimals: 2, currency: "EUR" },
} as const;
export type Asset = keyof typeof ASSETS;

/** Venues where value is only observable with a viewing key. */
export const SHIELDED_VENUES: ReadonlySet<Venue> = new Set(["zcash_ironwood"]);

export function isShieldedVenue(venue: Venue): boolean {
  return SHIELDED_VENUES.has(venue);
}

/** Corridor ids are packed into one byte of the Corridor Reference. */
export const CORRIDORS = {
  "EUR-NGN": 0x01,
  "USD-NGN": 0x02,
  "USD-KES": 0x03,
  "USD-SHIELDED": 0x10,
} as const;
export type CorridorCode = keyof typeof CORRIDORS;

export function corridorFromId(id: number): CorridorCode {
  const hit = (Object.entries(CORRIDORS) as [CorridorCode, number][]).find(([, v]) => v === id);
  if (!hit) throw new Error(`unknown corridor id 0x${id.toString(16)}`);
  return hit[0];
}

/** Amounts are always integer minor units of the asset. */
export interface Money {
  asset: Asset;
  amount: bigint;
}

export function money(asset: Asset, amount: bigint): Money {
  if (amount < 0n) throw new Error("money amounts are non-negative; direction lives on the posting");
  return { asset, amount };
}

/** Parse a decimal string ("12.50") into minor units of `asset`. */
export function parseMoney(asset: Asset, value: string): Money {
  const { decimals } = ASSETS[asset];
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals for ${asset}`);
  return money(asset, BigInt(m[1]! + frac.padEnd(decimals, "0")));
}

export function formatMoney({ asset, amount }: Money): string {
  const { decimals } = ASSETS[asset];
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${asset}`;
}
