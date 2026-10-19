import { FIAT, type Fiat } from "@corridor/core";
import { RampError } from "./errors.ts";

/**
 * Ramp's price list (plan §Economics): a monthly platform fee plus a cut of
 * routed volume, and a per-call fee for agent payouts. Volume fees are basis
 * points on the settlement amount in integer minor units; nothing here is
 * floating point.
 */
export type PlanId = "sandbox" | "growth" | "merchant" | "agent";

export interface Plan {
  id: PlanId;
  /** Basis points of routed volume. */
  bps: number;
  /** Flat fee per payout, in settlement-asset minor units (7 dp). */
  perCall: bigint;
  /** Monthly platform fee in USD cents. Invoiced, not charged on-chain. */
  monthlyUsdCents: number;
  /** The free sandbox runs on testnet only. */
  testnetOnly: boolean;
}

export const PLANS: Record<PlanId, Plan> = {
  sandbox: { id: "sandbox", bps: 0, perCall: 0n, monthlyUsdCents: 0, testnetOnly: true },
  growth: { id: "growth", bps: 35, perCall: 0n, monthlyUsdCents: 300_00, testnetOnly: false },
  merchant: { id: "merchant", bps: 40, perCall: 0n, monthlyUsdCents: 0, testnetOnly: false },
  agent: { id: "agent", bps: 50, perCall: 500_000n, monthlyUsdCents: 0, testnetOnly: false },
};

export function planOf(id: string): Plan {
  const plan = PLANS[id as PlanId];
  if (!plan) throw new RampError("invalid_request", `unknown plan ${id}`, { plans: Object.keys(PLANS) });
  return plan;
}

/** Ramp's fee on `amount`, rounded down: the user is never charged a fraction more than the schedule. */
export function rampFee(plan: Plan, amount: bigint, kind: "withdrawal" | "deposit"): bigint {
  const volume = (amount * BigInt(plan.bps)) / 10_000n;
  return kind === "withdrawal" ? volume + plan.perCall : volume;
}

/** Partner rates arrive as decimals; they are fixed to this many places once, at the boundary. */
export const RATE_DP = 7;
const RATE_SCALE = 10n ** BigInt(RATE_DP);
const SETTLEMENT_SCALE = 10n ** 7n;

/** `1530.25` → 15302500000n. Refuses exponent forms rather than guessing. */
export function scaleRate(rate: number | string): bigint {
  const s = String(rate);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RampError("partner_error", `unusable rate ${s}`);
  const frac = (m[2] ?? "").slice(0, RATE_DP).padEnd(RATE_DP, "0");
  const scaled = BigInt(m[1]! + frac);
  if (scaled === 0n) throw new RampError("partner_error", "partner quoted a zero rate");
  return scaled;
}

export function formatRate(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = (scaled % RATE_SCALE).toString().padStart(RATE_DP, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Settlement minor units (7 dp) → fiat minor units at `rate`, rounded down. */
export function toFiat(settlement: bigint, rate: bigint, currency: Fiat): bigint {
  return (settlement * rate * 10n ** BigInt(FIAT[currency].decimals)) / (SETTLEMENT_SCALE * RATE_SCALE);
}

/** Fiat minor units → settlement minor units (7 dp) at `rate`, rounded down. */
export function toSettlement(fiat: bigint, rate: bigint, currency: Fiat): bigint {
  return (fiat * SETTLEMENT_SCALE * RATE_SCALE) / (10n ** BigInt(FIAT[currency].decimals) * rate);
}
