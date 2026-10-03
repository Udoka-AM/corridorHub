import { describe, expect, it } from "vitest";
import { hashMessage, keccak256, parseTransaction, recoverAddress, recoverMessageAddress, serializeTransaction, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Account as TempoAccount, PublicKey, Secp256k1 } from "viem/tempo";
import type { Hex } from "@corridor/core";
import {
  awsKmsSigner,
  evmAccount,
  evmAddress,
  localSecp256k1Signer,
  parseDerSignature,
  solanaSigner,
  tempoAccount,
  toViemSignature,
  uncompressedFromSpki,
  type KmsApi,
} from "./index.ts";

const KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" as Hex;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SPKI_HEADER = "3056301006072a8648ce3d020106052b8104000a034200";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

function derInt(v: bigint): string {
  let h = v.toString(16);
  if (h.length % 2) h = "0" + h;
  if (parseInt(h.slice(0, 2), 16) >= 0x80) h = "00" + h;
  return "02" + (h.length / 2).toString(16).padStart(2, "0") + h;
}

/** A KMS stand-in: real secp256k1 signatures, DER-encoded, with high-s half the time, no recovery bit. */
function fakeKms(privateKey: Hex): KmsApi {
  let flip = false;
  return {
    async getPublicKey() {
      return bytes(SPKI_HEADER + PublicKey.toHex(Secp256k1.getPublicKey({ privateKey })).slice(2));
    },
    async signDigest(_keyId, digest) {
      const { r, s } = Secp256k1.sign({ payload: toHex(digest), privateKey });
      flip = !flip;
      const body = derInt(r) + derInt(flip ? N - s : s);
      return bytes("30" + (body.length / 2).toString(16).padStart(2, "0") + body);
    },
  };
}

describe("signer", () => {
  const expectedAddress = privateKeyToAccount(KEY).address;

  it("parses DER signatures and SPKI public keys", () => {
    const sig = parseDerSignature(bytes("3006020101020102"));
    expect(sig).toEqual({ r: 1n, s: 2n });
    const pub = PublicKey.toHex(Secp256k1.getPublicKey({ privateKey: KEY }));
    expect(uncompressedFromSpki(bytes(SPKI_HEADER + pub.slice(2)))).toBe(pub);
  });

  it("derives the same address from local and KMS signers", async () => {
    expect(await evmAddress(localSecp256k1Signer(KEY))).toBe(expectedAddress);
    expect(await evmAddress(awsKmsSigner(fakeKms(KEY), "alias/corridor-tempo-vault"))).toBe(expectedAddress);
  });

  it("normalises KMS signatures to low-s with the right recovery bit", async () => {
    const signer = awsKmsSigner(fakeKms(KEY), "k");
    for (let i = 0; i < 4; i++) {
      const digest = keccak256(toHex(`payout ${i}`));
      const sig = await signer.signDigest(digest);
      expect(sig.s <= N / 2n).toBe(true);
      expect(await recoverAddress({ hash: digest, signature: toViemSignature(sig) })).toBe(expectedAddress);
    }
  });

  it("signs Base transactions and messages through a KMS-backed viem account", async () => {
    const account = await evmAccount(awsKmsSigner(fakeKms(KEY), "k"));
    const tx = { chainId: 8453, type: "eip1559", nonce: 0, to: expectedAddress, value: 1n, gas: 21_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n } as const;
    const signed = await account.signTransaction(tx);
    const parsed = parseTransaction(signed);
    const digest = keccak256(serializeTransaction(tx));
    expect(await recoverAddress({ hash: digest, signature: { r: parsed.r!, s: parsed.s!, yParity: parsed.yParity! } })).toBe(expectedAddress);
    const message = "corridor";
    const signature = await account.signMessage({ message });
    expect(await recoverMessageAddress({ message, signature })).toBe(expectedAddress);
  });

  it("gives a Tempo account the same address and signatures as viem/tempo's own local account", async () => {
    const local = TempoAccount.fromSecp256k1(KEY);
    const viaSigner = await tempoAccount(localSecp256k1Signer(KEY));
    expect(viaSigner.address).toBe(local.address);
    const hash = hashMessage("tempo");
    expect(await viaSigner.sign({ hash })).toBe(await local.sign({ hash }));
    const viaKms = await tempoAccount(awsKmsSigner(fakeKms(KEY), "k"));
    expect(viaKms.address).toBe(local.address);
  });

  it("wraps an Ed25519 signer as a Solana transaction signer", async () => {
    const seen: Uint8Array[] = [];
    const signer = solanaSigner({
      kind: "test",
      address: "GNaeRSd8Q2LRsTVubmdBF3NzHX8KTSeLUV2rMxN2oMHL",
      async signBytes(message) {
        seen.push(message);
        return new Uint8Array(64).fill(7);
      },
    });
    const [dict] = await signer.signTransactions([{ messageBytes: new Uint8Array([1, 2, 3]), signatures: {} } as never]);
    expect(seen[0]).toEqual(new Uint8Array([1, 2, 3]));
    expect(dict![signer.address]).toEqual(new Uint8Array(64).fill(7));
  });
});
