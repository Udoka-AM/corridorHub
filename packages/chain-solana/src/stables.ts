import { address, type Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Stablecoin } from "@corridor/core";

export type SolanaCluster = "mainnet" | "devnet";

export const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

export interface SolanaStable {
  mint: Address;
  decimals: number;
  /** SPL Token or Token-2022; ATAs and transfers must use the mint's own program. */
  tokenProgram: Address;
}

/**
 * Stablecoins Corridor moves and observes on Solana. Issuer-neutral on
 * purpose: payout partners and treasury desks settle in USDC, USDT, PYUSD or
 * EURC, and the ledger books each in its own asset. Add a mint here and every
 * watcher and transfer picks it up.
 */
export const SOLANA_STABLES: Record<SolanaCluster, Partial<Record<Stablecoin, SolanaStable>>> = {
  mainnet: {
    USDC: { mint: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    USDT: { mint: address("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
    PYUSD: { mint: address("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"), decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    EURC: { mint: address("HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr"), decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
  },
  devnet: {
    USDC: { mint: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"), decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS },
  },
};

export function solanaStable(cluster: SolanaCluster, asset: Stablecoin): SolanaStable {
  const s = SOLANA_STABLES[cluster][asset];
  if (!s) throw new Error(`${asset} is not configured on Solana ${cluster}`);
  return s;
}

/** Reverse lookup: which stablecoin is this mint, if any. */
export function stableByMint(cluster: SolanaCluster, mint: string): Stablecoin | undefined {
  for (const [asset, s] of Object.entries(SOLANA_STABLES[cluster]) as [Stablecoin, SolanaStable][]) {
    if (s.mint === mint) return asset;
  }
  return undefined;
}
