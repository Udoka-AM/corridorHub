import { getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { StrKey } from "@stellar/stellar-sdk";

/**
 * One Ed25519 key, two chains.
 *
 * A Stellar account and a Solana address are the same 32-byte Ed25519 public
 * key written differently — Stellar in StrKey (`G…`), Solana in base58. So a
 * user who holds one key already has an account on both, and the key that
 * signs their Stellar transactions can sign a Solana one.
 *
 * That is what lets the Tron lane stay non-custodial. The lane has to pass
 * through Solana, because 1Click does not route Stellar and CCTP does not
 * reach Tron; something has to own the USDC in between and sign the burn.
 * Corridor holding it would be custody of a user's funds. Instead the swap
 * pays out to the user's *own* Solana address — the same key as their
 * Stellar account — and the burn is signed with that key. Corridor only
 * quotes, watches, and completes the mint it is already allowed to complete.
 */

const encoder = getAddressEncoder();
const decoder = getAddressDecoder();

/** The Solana address of the same key as this `G…` Stellar account. */
export function solanaAddressOfStellar(account: string): string {
  return decoder.decode(new Uint8Array(StrKey.decodeEd25519PublicKey(account)));
}

/** The `G…` Stellar account of the same key as this Solana address. */
export function stellarAccountOfSolana(address: string): string {
  return StrKey.encodeEd25519PublicKey(Buffer.from(encoder.encode(address as Parameters<typeof encoder.encode>[0])));
}
