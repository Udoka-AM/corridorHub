/**
 * The assets Corridor routes through NEAR Intents, by their 1Click ids.
 *
 * 1Click names an asset by the NEAR omnibus contract that fronts it, not by
 * chain and symbol, and it will not quote a pair it does not know — so the
 * ids are recorded here rather than assembled from a chain name at the call
 * site, where a typo would read as "no route".
 *
 * Stellar is deliberately absent. 1Click does not route it in either
 * direction, which is the whole reason the Tron lane is two hops: Tron USDT
 * to Solana USDC here, then Solana to Stellar over CCTP.
 */

export interface IntentAsset {
  /** 1Click's own id, sent as `originAsset` / `destinationAsset`. */
  id: string;
  chain: "tron" | "solana";
  symbol: "USDT" | "USDC";
  decimals: number;
}

export const INTENT_ASSETS = {
  "tron:USDT": {
    id: "nep141:tron-d28a265909efecdcee7c5028585214ea0b96f015.omft.near",
    chain: "tron",
    symbol: "USDT",
    decimals: 6,
  },
  "solana:USDC": {
    id: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
    chain: "solana",
    symbol: "USDC",
    decimals: 6,
  },
} as const satisfies Record<string, IntentAsset>;

export type IntentAssetKey = keyof typeof INTENT_ASSETS;

export function intentAsset(key: IntentAssetKey): IntentAsset {
  return INTENT_ASSETS[key];
}

/**
 * The smallest swap 1Click will price, in US dollars.
 *
 * Checked before quoting so a user who asks for less gets a number they can
 * act on instead of a 400. The server is the authority, and it calls the
 * limit "temporary" — so when it refuses anyway, its own message is passed
 * through rather than replaced with this one.
 */
export const MIN_SWAP_USD = 100;
