/**
 * Which signer holds each vault key. Default is a local key from .env.local
 * (development and testnet). Set CORRIDOR_SIGNER=aws-kms and
 * <KEY_NAME>_KMS_KEY_ID to sign with a key that never leaves AWS KMS; this
 * needs `@aws-sdk/client-kms` installed in the deployment.
 */
import { readFileSync } from "node:fs";
import {
  awsKmsApi,
  awsKmsSigner,
  evmAccount,
  evmAddress,
  localEd25519Signer,
  localSecp256k1Signer,
  solanaSigner,
  tempoAccount,
  type Secp256k1Signer,
} from "@corridor/signer";
import { testnetKey } from "./env.ts";

export async function secp256k1SignerFor(keyName: string): Promise<Secp256k1Signer> {
  if (process.env.CORRIDOR_SIGNER === "aws-kms") {
    const keyId = process.env[`${keyName}_KMS_KEY_ID`];
    if (!keyId) throw new Error(`CORRIDOR_SIGNER=aws-kms needs ${keyName}_KMS_KEY_ID`);
    const sdk = "@aws-sdk/client-kms";
    const kms = (await import(sdk).catch(() => {
      throw new Error(`CORRIDOR_SIGNER=aws-kms needs ${sdk}: pnpm add ${sdk}`);
    })) as { KMSClient: new (cfg: object) => { send(c: unknown): Promise<unknown> }; GetPublicKeyCommand: never; SignCommand: never };
    return awsKmsSigner(awsKmsApi(new kms.KMSClient({}), kms), keyId);
  }
  return localSecp256k1Signer(testnetKey(keyName));
}

export async function tempoAccountFor(keyName: string) {
  return tempoAccount(await secp256k1SignerFor(keyName));
}

/** A Base (EVM) account for the relay wallet, through the same signer selection. */
export async function evmAccountFor(keyName: string) {
  return evmAccount(await secp256k1SignerFor(keyName));
}

export async function evmAddressFor(keyName: string) {
  return evmAddress(await secp256k1SignerFor(keyName));
}

/**
 * A Solana transaction signer for a vault. Local keypair files are for
 * development; a deployment passes its MPC or KMS Ed25519 signer to
 * `solanaSigner` instead.
 */
export async function solanaSignerForKeypair(path: string) {
  return solanaSigner(await localEd25519Signer(new Uint8Array(JSON.parse(readFileSync(path, "utf8")))));
}
