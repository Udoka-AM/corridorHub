/**
 * The two testnet accounts the local anchor needs, created and funded with
 * the repo's own Stellar tooling so this example does not also need the
 * Stellar CLI installed.
 *
 *   - the SEP-10 signing key, which signs the challenge Corridor verifies;
 *   - the distribution account, which receives the funding payment.
 *
 * Writes .env (gitignored), which docker compose reads on its own, so
 * `docker compose` commands work without re-running up.sh. Existing keys are
 * reused.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { fundFromFriendbot, stellarClient } from "@corridor/chain-stellar";

const FILE = new URL("./.env", import.meta.url).pathname;
const existing = existsSync(FILE) ? Object.fromEntries(readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string])) : {};

const client = stellarClient({ network: "testnet" });

async function account(name: string): Promise<{ secret: string; address: string }> {
  const secret = existing[name] ?? Keypair.random().secret();
  const address = Keypair.fromSecret(secret).publicKey();
  try {
    await client.server.loadAccount(address);
    console.log(`${name.padEnd(28)} ${address}  (already funded)`);
  } catch {
    await fundFromFriendbot(client, address);
    console.log(`${name.padEnd(28)} ${address}  (funded from Friendbot)`);
  }
  return { secret, address };
}

const sep10 = await account("HOST_SEP10_SECRET_KEY");
const distribution = await account("DISTRIBUTION_ACCOUNT_SECRET_KEY");

writeFileSync(
  FILE,
  [
    `HOST_SEP10_SECRET_KEY=${sep10.secret}`,
    `HOST_SEP10_ACCOUNT=${sep10.address}`,
    `DISTRIBUTION_ACCOUNT_SECRET_KEY=${distribution.secret}`,
    `DISTRIBUTION_ACCOUNT=${distribution.address}`,
    "",
  ].join("\n"),
);
console.log(`\nwrote ${FILE}`);
