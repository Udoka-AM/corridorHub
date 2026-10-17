/**
 * Shared wiring for the scripts: a local ledger, the vault clients and the
 * saga engine. A deployment builds the same objects from its own config and
 * its own signer (see ./signers.ts).
 */
import { formatMoney, type Asset } from "@corridor/core";
import { Accounts, Ledger, openLocalDb, type Db } from "@corridor/ledger";
import { balanceOf, stellarClient, stellarReader, type StellarClient, type StellarNetwork } from "@corridor/chain-stellar";
import { PgCursorStore } from "@corridor/recon";
import { stellarSignerFor } from "./signers.ts";

export const NETWORK: StellarNetwork = process.env.CORRIDOR_NETWORK === "mainnet" ? "mainnet" : "testnet";

export interface Runtime {
  db: Db;
  ledger: Ledger;
  accounts: Accounts;
  cursors: PgCursorStore;
  close(): Promise<void>;
}

export async function openRuntime(): Promise<Runtime> {
  const db = await openLocalDb();
  const ledger = await Ledger.open(db);
  return {
    db,
    ledger,
    accounts: new Accounts(ledger),
    cursors: await PgCursorStore.open(db),
    close: async () => void db.close(),
  };
}

/** A signing client for a named vault key. */
export async function vault(keyName: string): Promise<StellarClient> {
  return stellarClient({ network: NETWORK, signer: await stellarSignerFor(keyName), horizonUrl: process.env.CORRIDOR_HORIZON_URL });
}

/** A key-less client, for read-only observation. */
export function reader(): StellarClient {
  return stellarReader({ network: NETWORK, horizonUrl: process.env.CORRIDOR_HORIZON_URL });
}

export async function report(client: StellarClient, label: string, address: string, assets: Asset[]): Promise<void> {
  const held: string[] = [];
  for (const asset of assets) {
    try {
      held.push(formatMoney({ asset, amount: await balanceOf(client, asset, address) }));
    } catch {
      held.push(`${asset} —`);
    }
  }
  console.log(`${label.padEnd(10)} ${address}  ${held.join("  ")}`);
}
