import { hashMessage, hashTypedData, keccak256, numberToHex, recoverPublicKey, serializeSignature, serializeTransaction, type Address } from "viem";
import { publicKeyToAddress } from "viem/utils";
import { privateKeyToAccount, sign as secp256k1Sign, toAccount, type LocalAccount } from "viem/accounts";
import {
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  signBytes as ed25519Sign,
  type Address as SolanaAddress,
  type SignatureBytes,
  type TransactionPartialSigner,
} from "@solana/kit";
import type { Hex } from "@corridor/core";

/**
 * Signing is behind one interface so Corridor never needs to hold a customer's
 * keys. A payment company runs Corridor inside its own environment and plugs
 * in the signer it already uses: a local key for development, a cloud KMS, or
 * an MPC provider. The saga engine, routing and ledger never see key material.
 *
 * Two key families cover every venue Corridor moves money on:
 * - secp256k1 for Base and other EVM chains,
 * - Ed25519 for Stellar and Solana, which share the curve: one key can hold
 *   both, and `ed25519PublicKeyBytes` gives the raw key that
 *   `@corridor/chain-stellar` encodes as a G… address.
 */

/** An ECDSA signature over a 32-byte digest, normalised to low-s with its recovery bit. */
export interface EcdsaSignature {
  r: bigint;
  s: bigint;
  yParity: 0 | 1;
}

export interface Secp256k1Signer {
  /** Where the key lives, for logs and the console: "local", "aws-kms", "fireblocks", … */
  readonly kind: string;
  /** Uncompressed public key, 0x04-prefixed (65 bytes). */
  publicKey(): Promise<Hex>;
  /** Sign a 32-byte digest. The digest is computed by Corridor; the signer never sees transaction semantics. */
  signDigest(digest: Hex): Promise<EcdsaSignature>;
}

export interface Ed25519Signer {
  readonly kind: string;
  /** Base58 Solana address of the key. */
  readonly address: string;
  /** Sign raw bytes (a Solana transaction message). Returns the 64-byte signature. */
  signBytes(message: Uint8Array): Promise<Uint8Array>;
}

/* ------------------------------------------------------------------ */
/* Adapters onto the chain SDKs                                        */
/* ------------------------------------------------------------------ */

/** The viem signature shape (hex r and s). */
export function toViemSignature({ r, s, yParity }: EcdsaSignature) {
  return { r: numberToHex(r, { size: 32 }), s: numberToHex(s, { size: 32 }), yParity };
}

export async function evmAddress(signer: Secp256k1Signer): Promise<Address> {
  return publicKeyToAddress(await signer.publicKey());
}

/** A viem account for Base (or any EVM chain) backed by any secp256k1 signer. */
export async function evmAccount(signer: Secp256k1Signer): Promise<LocalAccount> {
  const address = await evmAddress(signer);
  const sign = async (digest: Hex) => serializeSignature(toViemSignature(await signer.signDigest(digest)));
  return toAccount({
    address,
    async signMessage({ message }) {
      return sign(hashMessage(message));
    },
    async signTypedData(typedData) {
      return sign(hashTypedData(typedData as Parameters<typeof hashTypedData>[0]));
    },
    async signTransaction(transaction, options) {
      const serializer = options?.serializer ?? serializeTransaction;
      const signature = await signer.signDigest(keccak256(await serializer(transaction)));
      return serializer(transaction, toViemSignature(signature));
    },
  });
}

/**
 * The signer's raw 32-byte Ed25519 public key. Solana writes that key in
 * base58 and Stellar in StrKey, so this is how one KMS or MPC key serves
 * both: pass it to `ed25519StellarSigner` for the G… address.
 */
export function ed25519PublicKeyBytes(signer: Ed25519Signer): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(signer.address as SolanaAddress));
}

/** A @solana/kit transaction signer backed by any Ed25519 signer (KMS, MPC or local). */
export function solanaSigner(signer: Ed25519Signer): TransactionPartialSigner {
  const address = signer.address as SolanaAddress;
  return {
    address,
    async signTransactions(transactions) {
      return Promise.all(
        transactions.map(async (tx) => ({ [address]: (await signer.signBytes(Uint8Array.from(tx.messageBytes))) as SignatureBytes })),
      );
    },
  };
}

/* ------------------------------------------------------------------ */
/* Local adapter (development and tests)                               */
/* ------------------------------------------------------------------ */

export function localSecp256k1Signer(privateKey: Hex): Secp256k1Signer {
  const publicKey = privateKeyToAccount(privateKey).publicKey as Hex;
  return {
    kind: "local",
    async publicKey() {
      return publicKey;
    },
    async signDigest(digest) {
      const { r, s, yParity } = await secp256k1Sign({ hash: digest, privateKey });
      return { r: BigInt(r), s: BigInt(s), yParity: yParity as 0 | 1 };
    },
  };
}

/**
 * Local Ed25519 key from a solana-keygen secret (64 bytes: seed + public key).
 * Development and testnet only; production uses an MPC or KMS signer.
 */
export async function localEd25519Signer(secretKey: Uint8Array): Promise<Ed25519Signer> {
  const { address, keyPair } = await createKeyPairSignerFromBytes(secretKey);
  return {
    kind: "local",
    address,
    async signBytes(message) {
      return new Uint8Array(await ed25519Sign(keyPair.privateKey, message));
    },
  };
}

/* ------------------------------------------------------------------ */
/* AWS KMS adapter                                                     */
/* ------------------------------------------------------------------ */

/**
 * The two KMS calls the adapter needs. Corridor does not bundle the AWS SDK;
 * wrap a `KMSClient` with {@link awsKmsApi}, or supply any service that
 * speaks the same shapes (a KMS emulator, an HSM gateway).
 */
export interface KmsApi {
  /** DER-encoded SubjectPublicKeyInfo of an ECC_SECG_P256K1 key. */
  getPublicKey(keyId: string): Promise<Uint8Array>;
  /** DER-encoded ECDSA signature of a 32-byte digest (MessageType DIGEST, ECDSA_SHA_256). */
  signDigest(keyId: string, digest: Uint8Array): Promise<Uint8Array>;
}

/**
 * Adapts an AWS SDK v3 `KMSClient` to {@link KmsApi}. Pass the command
 * classes from `@aws-sdk/client-kms` so this package stays dependency-free:
 *
 * ```ts
 * import { KMSClient, GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
 * const kms = awsKmsApi(new KMSClient({ region }), { GetPublicKeyCommand, SignCommand });
 * ```
 */
export function awsKmsApi(
  client: { send(command: unknown): Promise<unknown> },
  commands: { GetPublicKeyCommand: new (input: object) => unknown; SignCommand: new (input: object) => unknown },
): KmsApi {
  return {
    async getPublicKey(keyId) {
      const out = (await client.send(new commands.GetPublicKeyCommand({ KeyId: keyId }))) as { PublicKey?: Uint8Array };
      if (!out.PublicKey) throw new Error(`KMS returned no public key for ${keyId}`);
      return out.PublicKey;
    },
    async signDigest(keyId, digest) {
      const out = (await client.send(
        new commands.SignCommand({ KeyId: keyId, Message: digest, MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
      )) as { Signature?: Uint8Array };
      if (!out.Signature) throw new Error(`KMS returned no signature for ${keyId}`);
      return out.Signature;
    },
  };
}

/** secp256k1 group order. */
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * A secp256k1 signer whose key never leaves AWS KMS (key spec
 * ECC_SECG_P256K1). KMS returns DER signatures without a recovery bit and
 * without low-s normalisation; both are fixed here so the result is a valid
 * Ethereum signature.
 */
export function awsKmsSigner(kms: KmsApi, keyId: string): Secp256k1Signer {
  let cached: Hex | undefined;
  const publicKey = async () => (cached ??= uncompressedFromSpki(await kms.getPublicKey(keyId)));
  return {
    kind: "aws-kms",
    publicKey,
    async signDigest(digest) {
      const expected = await publicKey();
      const der = await kms.signDigest(keyId, hexToBytes(digest));
      const { r, s: rawS } = parseDerSignature(der);
      const s = rawS > N / 2n ? N - rawS : rawS;
      for (const yParity of [0, 1] as const) {
        const recovered = await recoverPublicKey({ hash: digest, signature: serializeSignature(toViemSignature({ r, s, yParity })) });
        if (recovered.toLowerCase() === expected.toLowerCase()) return { r, s, yParity };
      }
      throw new Error(`KMS signature for ${keyId} does not match its public key`);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Minimal DER helpers                                                 */
/* ------------------------------------------------------------------ */

function readLength(bytes: Uint8Array, at: number): { length: number; next: number } {
  const first = bytes[at]!;
  if (first < 0x80) return { length: first, next: at + 1 };
  const n = first & 0x7f;
  let length = 0;
  for (let i = 0; i < n; i++) length = (length << 8) | bytes[at + 1 + i]!;
  return { length, next: at + 1 + n };
}

function readInteger(bytes: Uint8Array, at: number): { value: bigint; next: number } {
  if (bytes[at] !== 0x02) throw new Error("DER: expected INTEGER");
  const { length, next } = readLength(bytes, at + 1);
  let value = 0n;
  for (let i = 0; i < length; i++) value = (value << 8n) | BigInt(bytes[next + i]!);
  return { value, next: next + length };
}

/** ECDSA-Sig-Value ::= SEQUENCE { r INTEGER, s INTEGER } */
export function parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
  if (der[0] !== 0x30) throw new Error("DER: expected SEQUENCE");
  const { next } = readLength(der, 1);
  const r = readInteger(der, next);
  const s = readInteger(der, r.next);
  return { r: r.value, s: s.value };
}

/** The subjectPublicKey BIT STRING of an EC SubjectPublicKeyInfo ends with the 65-byte uncompressed point. */
export function uncompressedFromSpki(spki: Uint8Array): Hex {
  const point = spki.slice(spki.length - 65);
  if (point[0] !== 0x04) throw new Error("expected an uncompressed secp256k1 public key");
  return bytesToHex(point);
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.slice(2);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}
export { TurnkeyApi, TurnkeyError, turnkeyEd25519Signer, turnkeySecp256k1Signer, type TurnkeyConfig } from "./turnkey.ts";
