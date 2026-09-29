/**
 * Shared wiring for the testnet demos: Tempo Moderato vaults, the ledger, the
 * partner webhook server (real HTTP, signed deliveries), a Paj-shaped mock
 * partner, optional real Solana devnet funding, and the saga engine with every
 * leg registered.
 */
import { existsSync, mkdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { parseMoney, type Hex } from "@corridor/core";
import { TempoObserver, balanceOf, fundFromFaucet, tempoClient, type TempoClient } from "@corridor/chain-tempo";
import { SolanaVault, explorerTx as solanaTx, signerFromKeypairFile } from "@corridor/chain-solana";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { ledgerCreditLeg, ledgerReserveLeg, partnerCollectLeg, partnerPayoutLeg, simulatedBridgeLeg } from "@corridor/legs";
import { MockPartner, PartnerRegistry, type PartnerOrder } from "@corridor/partners";
import { PgCursorStore } from "@corridor/recon";
import { SagaEngine } from "@corridor/saga";
import { PartnerEventStore, webhookServer } from "@corridor/webhooks";
import { testnetKey } from "./env.ts";

export async function startRuntime(opts: { onCollectionOpened?: (order: PartnerOrder, mock: MockPartner) => Promise<void> } = {}) {
  const customer = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_CUSTOMER_KEY") });
  const treasury = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_VAULT_KEY") });
  const escrow = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_BRIDGE_ESCROW_KEY") });
  for (const [c, label] of [[customer, "customer"], [treasury, "treasury"], [escrow, "bridge escrow"]] as [TempoClient, string][]) {
    if ((await balanceOf(c, "pathUSD", c.account.address)) < parseMoney("pathUSD", "20").amount) {
      console.log(`funding ${label} from the Tempo faucet…`);
      await fundFromFaucet(c, c.account.address);
    }
  }

  mkdirSync(".data", { recursive: true });
  const db = await openLocalDb(".data/ledger");
  const ledger = await Ledger.open(db);
  const accounts = new Accounts(ledger);
  const cursors = await PgCursorStore.open(db);
  const events = await PartnerEventStore.open(db);

  // Solana devnet vault: real memo-tagged funding when it holds devnet USDC.
  const keypair = ".keys/solana-devnet-vault.json";
  const solana = existsSync(keypair) ? new SolanaVault(await signerFromKeypairFile(keypair), "devnet") : undefined;

  // Partner webhooks arrive over HTTP and are verified before they count.
  const registry = new PartnerRegistry();
  const server = webhookServer(registry, events).listen(0);
  await new Promise((r) => server.once("listening", r));
  const webhookUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/mock`;
  const mock = new MockPartner({
    webhookSecret: testnetKey("MOCK_PARTNER_WEBHOOK_SECRET"),
    deliver: async (body, headers) => {
      const res = await fetch(webhookUrl, { method: "POST", headers, body });
      if (res.status !== 200) throw new Error(`webhook rejected: ${res.status}`);
    },
  });
  registry.register(mock);

  const fund = async ({ to, usdcAmount, reference, order }: { to: string; usdcAmount: bigint; reference: Hex; order: PartnerOrder }) => {
    let ref: string;
    if (solana && (await solana.tokenBalance()) >= usdcAmount) {
      ref = await solana.transferWithReference({ toOwner: to, amount: usdcAmount, reference });
      console.log(`      funded partner on Solana devnet: ${solanaTx("devnet", ref)}`);
    } else {
      ref = `sim:solana:${order.id}`;
      console.log(`      funded partner (simulated: no devnet USDC in the vault yet)`);
    }
    await mock.observeFunding(order.id, ref); // the partner sees the deposit
    return ref;
  };

  const legOpts = {
    partners: registry,
    events,
    fund,
    ingressAddress: () => solana?.address ?? "CorridorSolanaIngress",
    webhookUrl,
    pollMs: 500,
    timeoutMs: 120_000,
  };
  const engine = await SagaEngine.open(db, ledger, accounts, [
    ledgerReserveLeg,
    simulatedBridgeLeg({ treasury, escrow }),
    partnerPayoutLeg(legOpts),
    partnerCollectLeg({ ...legOpts, onCollectionOpened: async (order) => opts.onCollectionOpened?.(order, mock) }),
    ledgerCreditLeg,
  ]);

  const startBlock = await treasury.getBlockNumber();
  const observer = new TempoObserver(treasury, {
    name: `tempo-moderato-vaults-${Date.now()}`,
    asset: "pathUSD",
    addresses: [treasury.account.address, escrow.account.address],
    cursors,
    startBlock,
  });

  return {
    customer, treasury, escrow, db, ledger, accounts, events, registry, mock, solana, engine, observer, startBlock, legOpts,
    async close() {
      server.close();
      await db.close();
    },
  };
}
