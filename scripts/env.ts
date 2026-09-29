import { appendFileSync, existsSync } from "node:fs";
import { generatePrivateKey } from "viem/accounts";
import type { Hex } from "@corridor/core";

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
