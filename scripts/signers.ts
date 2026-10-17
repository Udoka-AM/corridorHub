/**
 * Which signer holds each vault key. Default is a local key from .env.local
 * (development and testnet). In a customer deployment:
 *
 * - CORRIDOR_SIGNER=aws-kms with <KEY_NAME>_KMS_KEY_ID: a key that never
 *   leaves AWS KMS (needs `@aws-sdk/client-kms` installed);
 * - CORRIDOR_SIGNER=turnkey with TURNKEY_ORGANIZATION_ID,
 *   TURNKEY_API_PRIVATE_KEY and <KEY_NAME>_TURNKEY_SIGN_WITH (the wallet
 *   account address, or SOLANA_VAULT_TURNKEY_ADDRESS for the Solana vault).
 *
 * Stellar and Solana share Ed25519, so one held key serves both: the Turnkey
 * or MPC signer is wrapped by `ed25519StellarSigner` with its raw public key.
 */
import { readFileSync } from "node:fs";
import {
  TurnkeyApi,
  awsKmsApi,
  awsKmsSigner,
  ed25519PublicKeyBytes,
  turnkeyEd25519Signer,
  turnkeySecp256k1Signer,
  evmAccount,
  evmAddress,
  localEd25519Signer,
  localSecp256k1Signer,
  solanaSigner,
  type Secp256k1Signer,
} from "@corridor/signer";
import { ed25519StellarSigner, localStellarSigner, type StellarSigner } from "@corridor/chain-stellar";
import { testnetKey, testnetStellarSecret } from "./env.ts";

let turnkey: TurnkeyApi | undefined;
function turnkeyApi(): TurnkeyApi {
  const organizationId = process.env.TURNKEY_ORGANIZATION_ID;
  const apiPrivateKey = process.env.TURNKEY_API_PRIVATE_KEY;
  if (!organizationId || !apiPrivateKey) throw new Error("CORRIDOR_SIGNER=turnkey needs TURNKEY_ORGANIZATION_ID and TURNKEY_API_PRIVATE_KEY");
  return (turnkey ??= new TurnkeyApi({ organizationId, apiPrivateKey }));
}

export async function secp256k1SignerFor(keyName: string): Promise<Secp256k1Signer> {
  if (process.env.CORRIDOR_SIGNER === "turnkey") {
    const signWith = process.env[`${keyName}_TURNKEY_SIGN_WITH`];
    if (!signWith) throw new Error(`CORRIDOR_SIGNER=turnkey needs ${keyName}_TURNKEY_SIGN_WITH`);
    return turnkeySecp256k1Signer(turnkeyApi(), signWith);
  }
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

/**
 * The Stellar signer for a vault. A deployment points CORRIDOR_SIGNER at its
 * own Ed25519 key holder; locally it is a Stellar secret in .env.local.
 */
export async function stellarSignerFor(keyName: string): Promise<StellarSigner> {
  if (process.env.CORRIDOR_SIGNER === "turnkey") {
    const signWith = process.env[`${keyName}_TURNKEY_SIGN_WITH`];
    if (!signWith) throw new Error(`CORRIDOR_SIGNER=turnkey needs ${keyName}_TURNKEY_SIGN_WITH`);
    const signer = turnkeyEd25519Signer(turnkeyApi(), signWith);
    return ed25519StellarSigner(signer, ed25519PublicKeyBytes(signer));
  }
  return localStellarSigner(testnetStellarSecret(`${keyName}_STELLAR_SECRET`));
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
  if (process.env.CORRIDOR_SIGNER === "turnkey") {
    const address = process.env.SOLANA_VAULT_TURNKEY_ADDRESS;
    if (!address) throw new Error("CORRIDOR_SIGNER=turnkey needs SOLANA_VAULT_TURNKEY_ADDRESS");
    return solanaSigner(turnkeyEd25519Signer(turnkeyApi(), address));
  }
  return solanaSigner(await localEd25519Signer(new Uint8Array(JSON.parse(readFileSync(path, "utf8")))));
}
