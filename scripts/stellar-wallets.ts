/**
 * Create the vault accounts this repo's scripts use, and show what they hold.
 * On testnet the accounts are funded by Friendbot; on mainnet they must
 * already exist, so this only reports.
 *
 *   pnpm stellar:wallets
 */
import { fundFromFriendbot } from "@corridor/chain-stellar";
import { NETWORK, report, vault } from "./runtime.ts";

const VAULTS = ["TREASURY", "ESCROW"] as const;

for (const name of VAULTS) {
  const client = await vault(name);
  const address = client.address;
  if (NETWORK === "testnet") {
    try {
      await client.server.loadAccount(address);
    } catch {
      console.log(`funding ${name} from Friendbot…`);
      await fundFromFriendbot(client, address);
    }
  }
  await report(client, name, address, ["XLM", "USDC"]);
}
console.log(`\nnetwork: ${NETWORK}`);
