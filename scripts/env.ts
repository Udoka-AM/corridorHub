import { appendFileSync, existsSync } from "node:fs";
import { setDefaultResultOrder } from "node:dns";
import { generatePrivateKey } from "viem/accounts";
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
