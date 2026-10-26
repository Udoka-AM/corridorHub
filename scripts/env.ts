import { appendFileSync, existsSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { generatePrivateKey } from "viem/accounts";
import { Keypair } from "@stellar/stellar-sdk";
import type { Hex } from "@corridor/core";

// Some IPv6-only networks (NAT64) hand Node unreachable IPv6 addresses for
// partner APIs; curl falls back to IPv4 but Node's fetch times out. Prefer IPv4.
setDefaultResultOrder("ipv4first");

const ENV_FILE = ".env.local";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/** Read a key from .env.local, generating a fresh testnet key on first use. */
export function testnetKey(name: string): Hex {
  let v = process.env[name];
  if (!v) {
    v = generatePrivateKey();
    appendFileSync(ENV_FILE, `${name}=${v}\n`);
    process.env[name] = v;
    console.log(`generated ${name} -> ${ENV_FILE}`);
  }
  return v as Hex;
}

/**
 * Read a Stellar secret from .env.local, generating a fresh testnet keypair on
 * first use.
 *
 * It will not generate one on mainnet. A generated key is empty and, in a
 * container, different on every restart — so a missing mainnet secret is a
 * misconfiguration to stop on, not a key to invent. Supply the secret, or
 * point `CORRIDOR_SIGNER` at a key holder that never exposes one.
 */
export function testnetStellarSecret(name: string): string {
  const v = process.env[name];
  if (v) return v;
  if (process.env.CORRIDOR_NETWORK === "mainnet") {
    throw new Error(`${name} is not set. On mainnet Corridor will not generate a key: set it, or set CORRIDOR_SIGNER=turnkey with ${name.replace(/_STELLAR_SECRET$/, "")}_TURNKEY_SIGN_WITH`);
  }
  const keypair = Keypair.random();
  appendFileSync(ENV_FILE, `${name}=${keypair.secret()}\n`);
  process.env[name] = keypair.secret();
  console.log(`generated ${name} (${keypair.publicKey()}) -> ${ENV_FILE}`);
  return keypair.secret();
}
