import { Asset as StellarSdkAsset } from "@stellar/stellar-sdk";
import { assetDecimals, type Asset, type Money } from "@corridor/core";

export type StellarNetwork = "testnet" | "mainnet";

/**
 * The classic assets Corridor settles in on Stellar, by issuer.
 *
 * Issuers are identity: a "USDC" from any other issuer is a different asset
 * and is never booked as USDC (see `assetOf`). Entries left unset are not
 * configured in code on purpose — verify an issuer against the issuer's own
 * published `stellar.toml` and set it here, or supply it at deploy time
 * through `CORRIDOR_STELLAR_ISSUER_<CODE>_<NETWORK>`.
 */
export const STELLAR_ISSUERS: Partial<Record<Asset, Partial<Record<StellarNetwork, string>>>> = {
  USDC: {
    mainnet: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    testnet: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  },
  EURC: {
    mainnet: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2",
  },
  // MGUSD, PYUSD and USDT: issuer not verified here yet. Set the env override
  // or add the issuer once it has been checked against its stellar.toml.
  MGUSD: {},
  PYUSD: {},
  USDT: {},
};

/** XLM is the native asset: no issuer, and the only asset fees are charged in. */
export const NATIVE: Asset = "XLM";

export function issuerOf(asset: Asset, network: StellarNetwork): string | undefined {
  const code = assetCode(asset);
  return process.env[`CORRIDOR_STELLAR_ISSUER_${code}_${network.toUpperCase()}`] ?? STELLAR_ISSUERS[asset]?.[network];
}

function assetCode(asset: Asset): string {
  return asset;
}

/** The SDK asset for a Corridor asset, or a clear error when no issuer is configured. */
export function stellarAsset(asset: Asset, network: StellarNetwork): StellarSdkAsset {
  if (asset === NATIVE) return StellarSdkAsset.native();
  const issuer = issuerOf(asset, network);
  if (!issuer) {
    throw new Error(
      `no ${network} issuer configured for ${asset}: set CORRIDOR_STELLAR_ISSUER_${assetCode(asset)}_${network.toUpperCase()} or add it to STELLAR_ISSUERS`,
    );
  }
  return new StellarSdkAsset(assetCode(asset), issuer);
}

/** Which Corridor asset a Horizon record refers to, matching code *and* issuer. Null for anything else. */
export function assetOf(
  record: { asset_type: string; asset_code?: string; asset_issuer?: string },
  network: StellarNetwork,
): Asset | null {
  if (record.asset_type === "native") return NATIVE;
  if (!record.asset_code || !record.asset_issuer) return null;
  for (const asset of Object.keys(STELLAR_ISSUERS) as Asset[]) {
    if (assetCode(asset) !== record.asset_code) continue;
    if (issuerOf(asset, network) === record.asset_issuer) return asset;
  }
  return null;
}

/**
 * Stellar carries amounts as decimal strings with 7 places. The ledger keeps
 * the same precision (ADR 0012), so this is a formatting step and never a
 * rounding one.
 */
export const STELLAR_DECIMALS = 7;

export function toStellarAmount({ asset, amount }: Money): string {
  const decimals = assetDecimals(asset);
  if (decimals !== STELLAR_DECIMALS) throw new Error(`${asset} is kept at ${decimals} dp; Stellar needs ${STELLAR_DECIMALS}`);
  const s = amount.toString().padStart(STELLAR_DECIMALS + 1, "0");
  return `${s.slice(0, -STELLAR_DECIMALS)}.${s.slice(-STELLAR_DECIMALS)}`;
}

/** Minor units from a Horizon amount string. Throws on more precision than Stellar can hold. */
export function fromStellarAmount(asset: Asset, value: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`invalid Stellar amount "${value}"`);
  const frac = m[2] ?? "";
  if (frac.length > STELLAR_DECIMALS) throw new Error(`"${value}" has more than ${STELLAR_DECIMALS} decimals`);
  const decimals = assetDecimals(asset);
  if (decimals !== STELLAR_DECIMALS) throw new Error(`${asset} is kept at ${decimals} dp; Stellar gives ${STELLAR_DECIMALS}`);
  return BigInt(m[1]! + frac.padEnd(STELLAR_DECIMALS, "0"));
}
