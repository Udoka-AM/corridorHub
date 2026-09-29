/**
 * Zcash spike (D5–D6): Corridor's shielded lane on Zcash testnet, Ironwood pool.
 *
 *   pnpm zcash:spike
 *
 * 1. A customer's period account (ZIP-32 account "acme-2026-10") pays three
 *    suppliers in ONE shielded transaction, each output carrying a Corridor
 *    Reference + invoice number in its encrypted memo.
 * 2. Recipients see their payment and invoice number in their own wallet.
 * 3. An auditor given ONLY the period account's viewing key rebuilds the
 *    payouts in a view-only wallet, and those observations reconcile 1:1
 *    against Corridor's ledger.
 *
 * Needs testnet ZEC (TAZ) in the period account; the script prints its address.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { RefKind, customerTag, encodeRef, fromZcashMemo, money, toZcashMemo, uuidv7 } from "@corridor/core";
import { ZcashWallet, formatZec, shieldedObservations } from "@corridor/chain-zcash";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { reconcile, summarize } from "@corridor/recon";
import { testnetKey } from "./env.ts";

const BIN = process.env.ZCASH_DEVTOOL ?? "/Users/udoka/Wfiar/tools/zcash-devtool/target/release/zcash-devtool";
const corridor = new ZcashWallet({ bin: BIN, walletDir: ".data/zcash-testnet", identity: ".keys/zcash-testnet-age.txt" });
const suppliers = new ZcashWallet({ bin: BIN, walletDir: ".data/zcash-testnet-suppliers", identity: ".keys/zcash-testnet-suppliers-age.txt" });

const CUSTOMER = "acme-imports";
const PERIOD = "acme-2026-10";
const PER_PAYMENT = 1_000_000n; // 0.01 TAZ each
const FEE_BUFFER = 100_000n;

console.log("syncing wallets…");
corridor.sync();
suppliers.sync();
const period = corridor.account(PERIOD);
const periodAddress = corridor.defaultAddress(period.uuid);
const balance = corridor.balance(period.uuid);
console.log(`period account ${PERIOD} (ZIP-32 index ${period.index})
  address  ${periodAddress}
  balance  ${formatZec(balance.total)} TAZ (Ironwood spendable ${formatZec(balance.ironwoodSpendable)})`);

const recipients = ["supplier-shenzhen", "supplier-hongkong", "contractor-lagos"].map((name, i) => ({
  name,
  invoice: `INV-2026-10-${String(i + 1).padStart(3, "0")}`,
  address: suppliers.defaultAddress(suppliers.account(name).uuid),
}));

const needed = PER_PAYMENT * BigInt(recipients.length) + FEE_BUFFER;
const spendable = balance.ironwoodSpendable + balance.orchardSpendable + balance.saplingSpendable;
if (spendable < needed) {
  console.log(`\nNeeds ${formatZec(needed)} TAZ spendable. Send testnet ZEC to the period address above from a faucet
(e.g. https://zcashfaucet.jinolabs.xyz or https://fauzec.com), wait ~10 confirmations, then re-run.`);
  process.exit(0);
}

// ---- 1. one shielded transaction, one output per recipient ----
const secret = testnetKey("CORRIDOR_REF_SECRET");
const batchId = uuidv7();
const items = recipients.map((r) => ({
  ...r,
  reference: encodeRef({
    kind: RefKind.BatchItem,
    corridor: "NGN-CNY",
    shielded: true,
    id: uuidv7(),
    customerTag: customerTag(CUSTOMER, secret),
  }),
}));
const txid = corridor.payBatch(
  period.uuid,
  items.map((it) => ({ address: it.address, zatoshi: PER_PAYMENT, memo: toZcashMemo(it.reference, it.invoice) })),
);
console.log(`\nbatch ${batchId}\n  1 shielded tx, ${items.length} recipients: ${txid}\n  https://testnet.zcashexplorer.app/transactions/${txid}`);

console.log("waiting for the transaction to be mined…");
for (let i = 0; i < 60; i++) {
  corridor.sync();
  if (corridor.outputs().some((o) => o.txid === txid && o.minedHeight != null)) break;
  await new Promise((r) => setTimeout(r, 20_000));
}

// ---- book the batch in Corridor's ledger from the sender's own view ----
mkdirSync(".data", { recursive: true });
const db = await openLocalDb(".data/ledger");
const ledger = await Ledger.open(db);
const accounts = new Accounts(ledger);
const vault = await accounts.vault(PERIOD, "ZEC", "zcash_ironwood");
const liability = await accounts.customer(CUSTOMER, "NGN-CNY", "ZEC", "zcash_ironwood");
const funding = PER_PAYMENT * BigInt(items.length);
await ledger.post({
  kind: "near.swap.simulated",
  external: { venue: "internal", ref: `fund:${batchId}` },
  metadata: { note: "USDC→ZEC funding leg is simulated on testnet (no NEAR Intents testnet liquidity)" },
  lines: [
    { account: vault, direction: "D", money: money("ZEC", funding) },
    { account: liability, direction: "C", money: money("ZEC", funding) },
  ],
});
const sent = shieldedObservations(corridor.outputs().filter((o) => o.txid === txid && o.fromAccount === period.uuid));
for (const obs of sent) {
  if (!obs.reference) continue;
  await ledger.post({
    kind: "zcash.shieldedBatch.item",
    reference: obs.reference,
    external: { venue: "zcash_ironwood", ref: obs.externalRef },
    metadata: { batchId, txid },
    lines: [
      { account: liability, direction: "D", money: money("ZEC", obs.amount) },
      { account: vault, direction: "C", money: money("ZEC", obs.amount) },
    ],
  });
}
console.log(`booked ${sent.filter((o) => o.reference).length} payouts in the ledger`);

// ---- 2. what each recipient sees in their own wallet ----
suppliers.sync();
console.log("\nrecipients' view (their own wallets):");
for (const o of suppliers.outputs().filter((o) => o.txid === txid)) {
  const m = o.memo ? fromZcashMemo(o.memo) : null;
  console.log(`  ${o.pool.padEnd(8)} ${formatZec(o.zatoshi)} TAZ  memo: ${m ? `${m.invoiceRef} · corridor:${m.ref.slice(2, 12)}…` : "(none)"}`);
}

// ---- 3. the auditor: only the period account's viewing key ----
const auditorDir = ".data/zcash-testnet-auditor";
if (existsSync(auditorDir)) rmSync(auditorDir, { recursive: true });
const auditor = new ZcashWallet({ bin: BIN, walletDir: auditorDir });
const birthday = corridor.outputs().find((o) => o.txid === txid)!.minedHeight! - 10;
auditor.initViewOnly(`auditor-${PERIOD}`, period.ufvk!, birthday);
auditor.sync();
const seen = shieldedObservations(auditor.outputs());
const results = await reconcile(ledger, seen.filter((o) => o.reference));
console.log(`\nauditor (view-only, ${PERIOD} key only) sees ${seen.length} shielded outputs; reconciliation:`, summarize(results));
console.log(`treasury activity visible to auditor: ${auditor.outputs().some((o) => o.toAccount === corridor.account("corridor-treasury").uuid) ? "YES (leak!)" : "none"}`);
console.log(`ledger invariants: ${JSON.stringify(await ledger.checkInvariants())}`);
await db.close();
