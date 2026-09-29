/**
 * Core domain model. Privacy is modelled as a venue (`zcash_ironwood`), not a
 * feature flag: shielded and public payouts are different paths through the
 * same route graph, booked in the same ledger. See docs/ARCHITECTURE.md §2.
 *
 * Corridor is a hub-and-spoke network: every flow is a collection into the
 * Tempo settlement hub or a payout out of it (§2.1). A corridor is just the
 * (funding currency, beneficiary currency) pair, so any region can be added
 * as a spoke without new corridor code.
 */

export const VENUES = ["tempo", "base", "solana", "partner_fiat", "zcash_ironwood"] as const;
export type Venue = (typeof VENUES)[number];

/**
 * Fiat currencies. `index` is Corridor's own stable one-byte code used in the
 * Corridor Reference: append-only, never renumber.
 */
export const FIAT = {
  // Americas
  USD: { index: 1, decimals: 2, region: "americas" },
  CAD: { index: 2, decimals: 2, region: "americas" },
  MXN: { index: 3, decimals: 2, region: "americas" },
  BRL: { index: 4, decimals: 2, region: "americas" },
  COP: { index: 5, decimals: 2, region: "americas" },
  ARS: { index: 6, decimals: 2, region: "americas" },
  CLP: { index: 7, decimals: 0, region: "americas" },
  PEN: { index: 8, decimals: 2, region: "americas" },
  // Europe
  EUR: { index: 20, decimals: 2, region: "europe" },
  GBP: { index: 21, decimals: 2, region: "europe" },
  CHF: { index: 22, decimals: 2, region: "europe" },
  // Africa
  NGN: { index: 40, decimals: 2, region: "africa" },
  KES: { index: 41, decimals: 2, region: "africa" },
  GHS: { index: 42, decimals: 2, region: "africa" },
  ZAR: { index: 43, decimals: 2, region: "africa" },
  EGP: { index: 44, decimals: 2, region: "africa" },
  UGX: { index: 45, decimals: 0, region: "africa" },
  TZS: { index: 46, decimals: 2, region: "africa" },
  RWF: { index: 47, decimals: 0, region: "africa" },
  XOF: { index: 48, decimals: 0, region: "africa" },
  XAF: { index: 49, decimals: 0, region: "africa" },
  MAD: { index: 50, decimals: 2, region: "africa" },
  // Asia and Middle East
  CNY: { index: 70, decimals: 2, region: "asia" },
  HKD: { index: 71, decimals: 2, region: "asia" },
  INR: { index: 72, decimals: 2, region: "asia" },
  AED: { index: 73, decimals: 2, region: "asia" },
  SGD: { index: 74, decimals: 2, region: "asia" },
  JPY: { index: 75, decimals: 0, region: "asia" },
  TRY: { index: 76, decimals: 2, region: "asia" },
  IDR: { index: 77, decimals: 2, region: "asia" },
  VND: { index: 78, decimals: 0, region: "asia" },
  PHP: { index: 79, decimals: 2, region: "asia" },
} as const;
export type Fiat = keyof typeof FIAT;
export type Region = (typeof FIAT)[Fiat]["region"];

/** On-chain assets Corridor holds or routes through. */
export const DIGITAL_ASSETS = {
  pathUSD: { decimals: 6, currency: "USD" },
  "USDC.e": { decimals: 6, currency: "USD" },
  USDC: { decimals: 6, currency: "USD" },
  USDT: { decimals: 6, currency: "USD" },
  ZEC: { decimals: 8, currency: "ZEC" },
} as const;
export type DigitalAsset = keyof typeof DIGITAL_ASSETS;

export type Asset = DigitalAsset | Fiat;

export function isFiat(asset: Asset): asset is Fiat {
  return asset in FIAT;
}

export function assetDecimals(asset: Asset): number {
  return isFiat(asset) ? FIAT[asset].decimals : DIGITAL_ASSETS[asset].decimals;
}

export function fiatFromIndex(index: number): Fiat {
  const hit = (Object.entries(FIAT) as [Fiat, (typeof FIAT)[Fiat]][]).find(([, v]) => v.index === index);
  if (!hit) throw new Error(`unknown currency index ${index}`);
  return hit[0];
}

/** Venues where value is only observable with a viewing key. */
export const SHIELDED_VENUES: ReadonlySet<Venue> = new Set(["zcash_ironwood"]);

export function isShieldedVenue(venue: Venue): boolean {
  return SHIELDED_VENUES.has(venue);
}

/**
 * A corridor is the pair (currency the customer funds in, currency the
 * beneficiary receives). "EUR-NGN" is a diaspora payout into Nigeria;
 * "NGN-CNY" is a Nigerian importer paying a Chinese supplier.
 */
export type CorridorCode = `${Fiat}-${Fiat}`;

export function corridor(source: Fiat, destination: Fiat): CorridorCode {
  return `${source}-${destination}`;
}

export function parseCorridor(code: string): { source: Fiat; destination: Fiat } {
  const [source, destination, extra] = code.split("-");
  if (extra !== undefined || !source || !destination || !(source in FIAT) || !(destination in FIAT)) {
    throw new Error(`invalid corridor "${code}"`);
  }
  return { source: source as Fiat, destination: destination as Fiat };
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
  const decimals = assetDecimals(asset);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimals for ${asset}`);
  return money(asset, BigInt(m[1]! + frac.padEnd(decimals, "0")));
}

export function formatMoney({ asset, amount }: Money): string {
  const decimals = assetDecimals(asset);
  if (decimals === 0) return `${amount} ${asset}`;
  const s = amount.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${asset}`;
}
