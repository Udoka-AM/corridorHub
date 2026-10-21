/**
 * Core domain model.
 *
 * Corridor is a hub-and-spoke network on Stellar: every flow is a collection
 * into the Stellar settlement hub or a payout out of it (docs/ARCHITECTURE.md
 * §2.1). A corridor is just the (funding currency, beneficiary currency)
 * pair, so any region can be added as a spoke without new corridor code.
 *
 * Anchors are the fiat spokes, normalised behind one partner interface
 * (SEP-10/12/6/24/31/38), so N anchors mean N integrations rather than N×N
 * corridors.
 */

export const VENUES = ["stellar", "base", "solana", "partner_fiat"] as const;
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

/**
 * On-chain assets Corridor holds, routes through or observes. Stablecoins are
 * issuer-neutral: USDC, EURC, PYUSD and MGUSD are all first-class, so a
 * customer's ledger covers whatever its anchors settle in.
 *
 * `decimals` is the ledger's minor unit, and it is the hub's own precision:
 * Stellar carries every balance to 7 decimal places, so the ledger does too
 * and a booked balance can equal an on-chain balance exactly (ADR 0008).
 * Spokes that use fewer decimals convert at the edge — USDC is 6 dp on Solana
 * and Base, which scales into 7 dp exactly. Which assets exist on which chain
 * lives in each chain package's registry.
 */
export const DIGITAL_ASSETS = {
  USDC: { decimals: 7, currency: "USD" },
  USDT: { decimals: 7, currency: "USD" },
  PYUSD: { decimals: 7, currency: "USD" },
  MGUSD: { decimals: 7, currency: "USD" },
  EURC: { decimals: 7, currency: "EUR" },
  // Native gas assets. Held only as fee float and booked to expense:gas.
  XLM: { decimals: 7, currency: "XLM" },
  SOL: { decimals: 9, currency: "SOL" },
  ETH: { decimals: 18, currency: "ETH" },
} as const;
export type DigitalAsset = keyof typeof DIGITAL_ASSETS;

export type Stablecoin = { [K in DigitalAsset]: (typeof DIGITAL_ASSETS)[K]["currency"] extends "USD" | "EUR" ? K : never }[DigitalAsset];

export const STABLECOINS = (Object.keys(DIGITAL_ASSETS) as DigitalAsset[]).filter(
  (a): a is Stablecoin => DIGITAL_ASSETS[a].currency === "USD" || DIGITAL_ASSETS[a].currency === "EUR",
);

/** The asset each venue charges network fees in. */
export const GAS_ASSET = { stellar: "XLM", base: "ETH", solana: "SOL" } as const;

export function isStablecoin(asset: Asset): asset is Stablecoin {
  return (STABLECOINS as readonly string[]).includes(asset);
}

/** The fiat currency a stablecoin tracks (USD for USDC/USDT/PYUSD/MGUSD, EUR for EURC). */
export function pegOf(asset: Stablecoin): "USD" | "EUR" {
  return DIGITAL_ASSETS[asset].currency;
}

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

/**
 * Venues where value is only observable with a viewing key. Empty for now:
 * the confidential lane arrives with Stellar confidential tokens and auditor
 * keys (ADR 0005), and the reference already reserves a flag for it.
 */
export const SHIELDED_VENUES: ReadonlySet<Venue> = new Set<Venue>();

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

/**
 * Parse a decimal string ("12.50") into minor units of `asset`. Extra decimals
 * are refused unless `truncate` is set, which rounds toward zero (used for
 * amounts a partner reports at a higher precision than the asset carries).
 */
export function parseMoney(asset: Asset, value: string, opts: { truncate?: boolean } = {}): Money {
  const decimals = assetDecimals(asset);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid amount "${value}"`);
  let frac = m[2] ?? "";
  if (frac.length > decimals) {
    if (!opts.truncate) throw new Error(`"${value}" has more than ${decimals} decimals for ${asset}`);
    frac = frac.slice(0, decimals);
  }
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

/**
 * Rescale minor units between two precisions, refusing anything that would
 * silently drop value. Spokes with fewer decimals than the hub (USDC is 6 dp
 * on Solana and Base, 7 dp on Stellar) convert through this, so a stroop of
 * dust surfaces as an error instead of disappearing.
 */
export function rescale(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  if (to > from) return amount * 10n ** BigInt(to - from);
  const divisor = 10n ** BigInt(from - to);
  if (amount % divisor !== 0n) throw new Error(`${amount} (${from} dp) does not fit in ${to} dp without losing value`);
  return amount / divisor;
}

/**
 * A non-negative decimal carried as a string ("1530.25"). Partner rates cross
 * the boundary in this form so no binary float ever touches money.
 */
export type Decimal = string;

const DECIMAL = /^\d+(?:\.\d+)?$/;

/**
 * Normalize a partner-supplied decimal. A JSON number from a vendor API is
 * accepted once, here, through its shortest round-trip string; exponent forms,
 * negatives and NaN are refused rather than guessed.
 */
export function decimal(value: string | number): Decimal {
  const s = typeof value === "number" ? String(value) : value.trim();
  if (!DECIMAL.test(s)) throw new Error(`invalid decimal "${value}"`);
  const [w, f = ""] = s.split(".");
  const whole = w!.replace(/^0+(?=\d)/, "");
  const frac = f.replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

function units(d: Decimal): { n: bigint; dp: number } {
  const [w, f = ""] = decimal(d).split(".");
  return { n: BigInt(w! + f), dp: f.length };
}

/** Minor units of `from` × `rate` → minor units of `to`, rounded down. */
export function mulRate(amount: bigint, from: Asset, rate: Decimal, to: Asset): bigint {
  const r = units(rate);
  return (amount * r.n * 10n ** BigInt(assetDecimals(to))) / 10n ** BigInt(assetDecimals(from) + r.dp);
}

/** Minor units of `from` ÷ `rate` → minor units of `to`, rounded down. */
export function divRate(amount: bigint, from: Asset, rate: Decimal, to: Asset): bigint {
  const r = units(rate);
  if (r.n === 0n) throw new Error("cannot divide by a zero rate");
  return (amount * 10n ** BigInt(r.dp + assetDecimals(to))) / (r.n * 10n ** BigInt(assetDecimals(from)));
}

/** `numerator / denominator` to `places` decimals, rounded down; "0" when the denominator is zero. */
export function ratio(numerator: Decimal, denominator: Decimal, places = 7): Decimal {
  const a = units(numerator);
  const b = units(denominator);
  if (b.n === 0n) return "0";
  const q = (a.n * 10n ** BigInt(b.dp + places)) / (b.n * 10n ** BigInt(a.dp));
  const s = q.toString().padStart(places + 1, "0");
  return decimal(`${s.slice(0, s.length - places)}.${s.slice(s.length - places)}`);
}
