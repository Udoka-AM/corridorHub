import { StrKey } from "@stellar/stellar-sdk";

/**
 * Addressing across the CCTP boundary.
 *
 * CCTP message fields are 32 bytes, which fits a Stellar contract id exactly
 * but says nothing about how to name an *account*. Circle's answer on Stellar
 * is the forwarder: the message is minted to the `CctpForwarder` contract,
 * and the account to pay out to travels in hook data as a strkey.
 */

export const HOOK_VERSION = 0;
const HEADER_BYTES = 32;

/** A Stellar contract id (C…) as the 32 bytes a CCTP `mintRecipient` carries. */
export function contractToBytes32(contractId: string): Uint8Array {
  if (!StrKey.isValidContract(contractId)) throw new Error(`not a Stellar contract id: ${contractId}`);
  return new Uint8Array(StrKey.decodeContract(contractId));
}

export function bytes32ToContract(bytes: Uint8Array): string {
  if (bytes.length !== 32) throw new Error("a CCTP address field is 32 bytes");
  return StrKey.encodeContract(Buffer.from(bytes));
}

/** An EVM address as a left-padded 32-byte CCTP address field. */
export function evmToBytes32(address: string): Uint8Array {
  const hex = address.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{40}$/.test(hex)) throw new Error(`not an EVM address: ${address}`);
  const out = new Uint8Array(32);
  out.set(Uint8Array.from(Buffer.from(hex, "hex")), 12);
  return out;
}

/**
 * Hook data for the Stellar forwarder: a 32-byte header, then the recipient's
 * strkey as UTF-8.
 *
 *   bytes 0–23   zero
 *   bytes 24–27  hook version (uint32 big-endian)
 *   bytes 28–31  strkey length in bytes (uint32 big-endian)
 *   bytes 32+    the strkey, UTF-8
 *
 * The recipient may be an account (G…), a contract (C…) or a muxed account
 * (M…). An account must already hold a USDC trustline or the mint fails —
 * which is what Ramp's sponsored onboarding exists to guarantee.
 */
export function encodeForwardHook(recipient: string, version = HOOK_VERSION): Uint8Array {
  assertRecipient(recipient);
  const strkey = Buffer.from(recipient, "utf8");
  const out = Buffer.alloc(HEADER_BYTES + strkey.length);
  out.writeUInt32BE(version, 24);
  out.writeUInt32BE(strkey.length, 28);
  strkey.copy(out, HEADER_BYTES);
  return new Uint8Array(out);
}

export function decodeForwardHook(hook: Uint8Array): { version: number; recipient: string } {
  if (hook.length < HEADER_BYTES) throw new Error("hook data is shorter than its header");
  const buf = Buffer.from(hook);
  if (buf.subarray(0, 24).some((b) => b !== 0)) throw new Error("hook header is not zero-padded");
  const version = buf.readUInt32BE(24);
  const length = buf.readUInt32BE(28);
  if (buf.length !== HEADER_BYTES + length) throw new Error(`hook says ${length} recipient bytes, carries ${buf.length - HEADER_BYTES}`);
  const recipient = buf.subarray(HEADER_BYTES).toString("utf8");
  assertRecipient(recipient);
  return { version, recipient };
}

function assertRecipient(recipient: string): void {
  const ok = StrKey.isValidEd25519PublicKey(recipient) || StrKey.isValidContract(recipient) || StrKey.isValidMed25519PublicKey(recipient);
  if (!ok) throw new Error(`not a Stellar account, contract or muxed address: ${recipient}`);
}
