import { createHash, randomBytes } from "node:crypto";
import type { Fiat } from "@corridor/core";
import { RampError } from "./errors.ts";

/**
 * API keys. `secret` keys belong to the app's backend; `agent` keys are
 * handed to an AI agent and carry a spending policy. Only the SHA-256 of a
 * key is stored, so a database leak does not leak usable keys.
 */
export type KeyKind = "secret" | "agent";

export function newApiKey(kind: KeyKind, network: "testnet" | "mainnet"): string {
  const env = network === "mainnet" ? "live" : "test";
  return `rk_${env}_${kind === "agent" ? "agent_" : ""}${randomBytes(24).toString("base64url")}`;
}

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

/** Limits on what an agent key may pay out. Amounts are settlement minor units. */
export interface SpendingPolicy {
  maxPerPayout?: bigint;
  dailyLimit?: bigint;
  currencies?: Fiat[];
}

/**
 * Check one payout against a key's policy. A refusal says which limit was hit
 * and what is still allowed, so the agent can retry within it.
 */
export function checkSpend(policy: SpendingPolicy | undefined, req: { amount: bigint; currency: Fiat; spentToday: bigint }): void {
  if (!policy) return;
  if (policy.currencies && !policy.currencies.includes(req.currency)) {
    throw new RampError("spending_limit", `this key may not pay out ${req.currency}`, { limit: "currencies", allowed: policy.currencies });
  }
  if (policy.maxPerPayout !== undefined && req.amount > policy.maxPerPayout) {
    throw new RampError("spending_limit", `payout exceeds this key's per-payout limit`, {
      limit: "maxPerPayout",
      max: policy.maxPerPayout.toString(),
      requested: req.amount.toString(),
    });
  }
  if (policy.dailyLimit !== undefined && req.spentToday + req.amount > policy.dailyLimit) {
    const remaining = policy.dailyLimit > req.spentToday ? policy.dailyLimit - req.spentToday : 0n;
    throw new RampError("spending_limit", `payout exceeds this key's daily limit`, {
      limit: "dailyLimit",
      max: policy.dailyLimit.toString(),
      spentToday: req.spentToday.toString(),
      remaining: remaining.toString(),
      requested: req.amount.toString(),
    });
  }
}

export function policyToJson(p: SpendingPolicy | undefined) {
  if (!p) return undefined;
  return {
    ...(p.maxPerPayout !== undefined ? { maxPerPayout: p.maxPerPayout.toString() } : {}),
    ...(p.dailyLimit !== undefined ? { dailyLimit: p.dailyLimit.toString() } : {}),
    ...(p.currencies ? { currencies: p.currencies } : {}),
  };
}

export function policyFromJson(j: unknown): SpendingPolicy | undefined {
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  return {
    ...(o.maxPerPayout !== undefined ? { maxPerPayout: BigInt(o.maxPerPayout as string) } : {}),
    ...(o.dailyLimit !== undefined ? { dailyLimit: BigInt(o.dailyLimit as string) } : {}),
    ...(Array.isArray(o.currencies) ? { currencies: o.currencies as Fiat[] } : {}),
  };
}
