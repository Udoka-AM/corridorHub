import type { Address } from "viem";
import { Addresses } from "viem/tempo";
import type { Asset } from "@corridor/core";

/** USD TIP-20s Corridor handles. pathUSD is the canonical settlement unit (ARCHITECTURE §0.1). */
export const TEMPO_TOKENS: Partial<Record<Asset, Address>> = {
  pathUSD: Addresses.pathUsd,
  "USDC.e": "0x20C000000000000000000000b9537d11c60E8b50",
};

export function tokenAddress(asset: Asset): Address {
  const addr = TEMPO_TOKENS[asset];
  if (!addr) throw new Error(`${asset} is not a Tempo TIP-20 Corridor settles in`);
  return addr;
}
