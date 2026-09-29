/**
 * ZIP-321 payment requests. One request can carry many payments, each with
 * its own memo, and becomes one shielded transaction with one output per
 * recipient. This is how a whole payroll or supplier batch is paid in a
 * single Ironwood transaction.
 * https://zips.z.cash/zip-0321
 */

export interface ShieldedPayment {
  /** Unified (or Sapling) address of the recipient. */
  address: string;
  /** Amount in zatoshi (1 ZEC = 100_000_000 zat). */
  zatoshi: bigint;
  /** Raw 512-byte memo (see `toZcashMemo` in @corridor/core). */
  memo?: Uint8Array;
}

export const ZATOSHI_PER_ZEC = 100_000_000n;
const MAX_MONEY = 21_000_000n * ZATOSHI_PER_ZEC;

/** Zatoshi to a ZIP-321 decimal ZEC string (no trailing zeros, max 8 decimals). */
export function formatZec(zatoshi: bigint): string {
  if (zatoshi < 0n || zatoshi > MAX_MONEY) throw new Error(`amount out of range: ${zatoshi}`);
  const whole = zatoshi / ZATOSHI_PER_ZEC;
  const frac = (zatoshi % ZATOSHI_PER_ZEC).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

export function parseZec(value: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(value);
  if (!m) throw new Error(`invalid ZEC amount "${value}"`);
  return BigInt(m[1]!) * ZATOSHI_PER_ZEC + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/** RFC 4648 §5 base64url without padding, as ZIP-321 requires for memos. */
export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
}

export function buildPaymentRequest(payments: ShieldedPayment[]): string {
  if (payments.length === 0) throw new Error("a payment request needs at least one payment");
  const params: string[] = [];
  payments.forEach((p, i) => {
    if (p.zatoshi <= 0n) throw new Error(`payment ${i} must be positive`);
    if (p.memo && p.memo.length > 512) throw new Error(`payment ${i} memo exceeds 512 bytes`);
    const suffix = i === 0 ? "" : `.${i}`;
    params.push(`address${suffix}=${encodeURIComponent(p.address)}`);
    params.push(`amount${suffix}=${formatZec(p.zatoshi)}`);
    if (p.memo) params.push(`memo${suffix}=${base64url(p.memo)}`);
  });
  return `zcash:?${params.join("&")}`;
}

export function parsePaymentRequest(uri: string): ShieldedPayment[] {
  if (!uri.startsWith("zcash:?")) throw new Error("expected a zcash:? payment request");
  const byIndex = new Map<number, Partial<ShieldedPayment>>();
  for (const pair of uri.slice("zcash:?".length).split("&")) {
    const [rawKey, rawValue = ""] = pair.split("=");
    const [name, idx] = rawKey!.split(".");
    const i = idx === undefined ? 0 : Number(idx);
    const p = byIndex.get(i) ?? {};
    const value = decodeURIComponent(rawValue);
    if (name === "address") p.address = value;
    else if (name === "amount") p.zatoshi = parseZec(value);
    else if (name === "memo") p.memo = fromBase64url(value);
    byIndex.set(i, p);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([i, p]) => {
      if (!p.address || p.zatoshi === undefined) throw new Error(`payment ${i} is incomplete`);
      return p as ShieldedPayment;
    });
}
