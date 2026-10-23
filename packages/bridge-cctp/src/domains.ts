/**
 * Circle's Cross-Chain Transfer Protocol: USDC is burned on the source chain
 * and minted on the destination against an attestation, so canonical USDC
 * arrives on the hub and no wrapped asset is ever booked.
 *
 * Domains are Circle's own numbering and are not chain ids. Values here are
 * from Circle's supported-chains reference and its Stellar contract
 * reference, checked 22 October 2026; verify an address against those pages
 * before a mainnet deployment uses it.
 */

export const DOMAIN = {
  ethereum: 0,
  solana: 5,
  base: 6,
  stellar: 27,
} as const;

export type CctpChain = keyof typeof DOMAIN;
export type CctpNetwork = "testnet" | "mainnet";

export function domainOf(chain: CctpChain): number {
  return DOMAIN[chain];
}

export function chainOfDomain(domain: number): CctpChain {
  const hit = (Object.entries(DOMAIN) as [CctpChain, number][]).find(([, d]) => d === domain);
  if (!hit) throw new Error(`no CCTP chain for domain ${domain}`);
  return hit[0];
}

/**
 * The Soroban contracts CCTP runs through on Stellar.
 *
 * `cctpForwarder` is the one Corridor cares about on the way in: CCTP treats
 * `mintRecipient` as a *contract* address, so a payment aimed straight at a
 * G… account never arrives and cannot be recovered. The forwarder is the
 * mint recipient, and the real beneficiary rides in the hook data.
 */
export const STELLAR_CONTRACTS: Record<CctpNetwork, { tokenMessengerMinter: string; messageTransmitter: string; cctpForwarder: string }> = {
  mainnet: {
    tokenMessengerMinter: "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    messageTransmitter: "CACMENFFJPJMSDAJQLX4R7K3SFZIW2LJSE3R2UMLGSWHFHS353FVXAZV",
    cctpForwarder: "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T",
  },
  testnet: {
    tokenMessengerMinter: "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP",
    messageTransmitter: "CBJ6MTCKKZG73PMDZCJMSFRD7DQEMI4FKDH7CGDSV4W6FHCRBCQAVVJY",
    cctpForwarder: "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ",
  },
};

/** USDC on the chains Corridor burns from. 6 decimals on both; the hub keeps 7. */
export const SOURCE_USDC_DECIMALS = 6;

/**
 * Circle's V2 contracts on the EVM spokes. The burn happens at
 * `tokenMessenger`; `messageTransmitter` is here for completeness, since
 * Corridor only receives on Stellar.
 *
 * From Circle's EVM contract reference, checked 22 October 2026.
 */
export const EVM_CONTRACTS: Record<"base" | "base-sepolia", { tokenMessenger: `0x${string}`; messageTransmitter: `0x${string}` }> = {
  base: {
    tokenMessenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d",
    messageTransmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64",
  },
  "base-sepolia": {
    tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
    messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  },
};
