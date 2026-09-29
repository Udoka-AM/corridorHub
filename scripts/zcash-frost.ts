/**
 * D7: a FROST 2-of-3 threshold-approved shielded batch on Zcash testnet (Ironwood).
 *
 *   pnpm zcash:frost
 *
 * The customer's period vault is controlled by FROST shares (signer 1 = the
 * customer's approver, 2 = the customer's finance lead, 3 = Corridor). No
 * single party can move funds.
 *
 *   1. funding: TAZ arrives in the vault (on testnet, swept from the hot
 *      funding account `acme-2026-10`, standing in for the NEAR Intents leg)
 *   2. zcash-devtool builds the batch as an unsigned PCZT and proves it
 *   3. corridor-frost: one signer alone is refused; signers 1 + 3 co-sign
 *   4. combine + broadcast: one Ironwood tx pays every recipient
 *   5. recipients read their invoice memos; an auditor holding only the
 *      vault's viewing key reconciles the batch against the ledger
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { RefKind, customerTag, encodeRef, fromZcashMemo, money, toZcashMemo, uuidv7 } from "@corridor/core";
import { FrostSigner, ZcashWallet, formatZec, shieldedObservations } from "@corridor/chain-zcash";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { reconcile, summarize } from "@corridor/recon";
import { testnetKey } from "./env.ts";

const DEVTOOL = process.env.ZCASH_DEVTOOL ?? "/Users/udoka/Wfiar/tools/zcash-devtool/target/release/zcash-devtool";
const FROST_BIN = process.env.CORRIDOR_FROST ?? "services/zcash-frost/target/release/corridor-frost";
const KEYS = ".keys/frost-treasury";
const WORK = ".data/pczt";

const corridor = new ZcashWallet({ bin: DEVTOOL, walletDir: ".data/zcash-testnet", identity: ".keys/zcash-testnet-age.txt" });
const suppliers = new ZcashWallet({ bin: DEVTOOL, walletDir: ".data/zcash-testnet-suppliers", identity: ".keys/zcash-testnet-suppliers-age.txt" });
const frost = new FrostSigner(FROST_BIN, KEYS);
const vaultKeys = frost.vault();

const CUSTOMER = "acme-imports";
const PER_PAYMENT = 1_000_000n; // 0.01 TAZ
const FEE_BUFFER = 200_000n;

const resumeIdx = process.argv.indexOf("--txid");
const resumeTxid = resumeIdx === -1 ? undefined : process.argv[resumeIdx + 1];

console.log("syncing wallets…");
corridor.sync();
suppliers.sync();

const vault = corridor.importUfvk("acme-2026-10-vault", vaultKeys.ufvk, corridor.chainTip() - 5);
const vaultAddress = corridor.defaultAddress(vault.uuid);
const recipients = ["supplier-shenzhen", "supplier-hongkong", "contractor-lagos"].map((name, i) => ({
  name,
  invoice: `INV-2026-10-F${String(i + 1).padStart(2, "0")}`,
  address: suppliers.defaultAddress(suppliers.account(name).uuid),
}));
const needed = PER_PAYMENT * BigInt(recipients.length) + FEE_BUFFER;
const spendable = (a: string) => {
  const b = corridor.balance(a);
  return b.ironwoodSpendable + b.orchardSpendable;
};

console.log(`FROST vault (${vaultKeys.threshold}-of-${vaultKeys.signers}), viewing key imported, no spending key held anywhere
  address  ${vaultAddress}
  balance  ${formatZec(spendable(vault.uuid))} TAZ spendable`);

let txid: string;
let batchId: string;
let approvedBy: number[];
let total: bigint;

if (resumeTxid) {
  // Finish ledger + recipient + auditor steps for a batch already broadcast.
  txid = resumeTxid;
  const rec = existsSync(`${WORK}/${txid}.approval.json`)
    ? JSON.parse(readFileSync(`${WORK}/${txid}.approval.json`, "utf8"))
    : { batchId: `resumed-${txid.slice(0, 8)}`, approvedBy: [] };
  batchId = rec.batchId;
  approvedBy = rec.approvedBy;
  total = corridor
    .outputs()
    .filter((o) => o.txid === txid && o.fromAccount === vault.uuid && !o.isChange)
    .reduce((sum, o) => sum + o.zatoshi, 0n);
  console.log(`\nresuming batch ${batchId} (tx ${txid})`);
} else {
// ---- 1. funding ----
if (spendable(vault.uuid) < needed) {
  const hot = corridor.account("acme-2026-10");
  if (spendable(hot.uuid) < needed + FEE_BUFFER) {
    console.log(`\nNeeds ${formatZec(needed)} TAZ in the vault. Fund the hot funding account and re-run:
  ${corridor.defaultAddress(hot.uuid)}
(faucets: https://zcashfaucet.jinolabs.xyz · https://fauzec.com)`);
    process.exit(0);
  }
  const txid = corridor.payBatch(hot.uuid, [{ address: vaultAddress, zatoshi: needed }]);
  console.log(`\nfunded vault from acme-2026-10: ${txid}\nwaiting for confirmations, then re-run \`pnpm zcash:frost\`.`);
  process.exit(0);
}

// ---- 2. build and prove the batch ----
mkdirSync(WORK, { recursive: true });
const secret = testnetKey("CORRIDOR_REF_SECRET");
batchId = uuidv7();
const items = recipients.map((r) => ({
  ...r,
  reference: encodeRef({ kind: RefKind.BatchItem, corridor: "NGN-CNY", shielded: true, id: uuidv7(), customerTag: customerTag(CUSTOMER, secret) }),
}));
const unsigned = `${WORK}/${batchId}.unsigned.pczt`;
corridor.pcztCreateBatch(
  vault.uuid,
  items.map((it) => ({ address: it.address, zatoshi: PER_PAYMENT, memo: toZcashMemo(it.reference, it.invoice) })),
  unsigned,
);
const proved = `${WORK}/${batchId}.proved.pczt`;
corridor.pcztProve(unsigned, proved);
console.log(`\nbatch ${batchId}: unsigned PCZT built and proved (${items.length} recipients)`);

// ---- 3. threshold approval ----
try {
  frost.sign(unsigned, [2], `${WORK}/${batchId}.solo.pczt`);
  throw new Error("a single signer must not be able to authorize a spend");
} catch (e) {
  const msg = (e as { stderr?: Buffer }).stderr?.toString().trim().split("\n").at(-1) ?? String(e);
  console.log(`  signer 2 alone → refused (${msg.replace(/^Error: /, "")})`);
}
const signed = `${WORK}/${batchId}.signed.pczt`;
const approval = frost.sign(unsigned, [1, 3], signed);
console.log(`  signers 1 + 3 → ${approval.signed}/${approval.ironwoodActions} Ironwood actions signed (sighash ${approval.sighash.slice(0, 16)}…)`);

// ---- 4. combine and broadcast ----
const final = `${WORK}/${batchId}.final.pczt`;
corridor.pcztCombine([proved, signed], final);
txid = corridor.pcztSend(final);
approvedBy = approval.signers;
total = PER_PAYMENT * BigInt(items.length);
writeFileSync(`${WORK}/${txid}.approval.json`, JSON.stringify({ batchId, approvedBy, sighash: approval.sighash }));
console.log(`\nbroadcast: one shielded tx, ${items.length} recipients\n  ${txid}\n  https://testnet.zcashexplorer.app/transactions/${txid}`);

console.log("waiting for the transaction to be mined…");
for (let i = 0; i < 60; i++) {
  corridor.sync();
  if (corridor.outputs().some((o) => o.txid === txid && o.minedHeight != null)) break;
  await new Promise((r) => setTimeout(r, 20_000));
}
}

// ---- 5. ledger, recipients, auditor ----
mkdirSync(".data", { recursive: true });
const db = await openLocalDb(".data/ledger");
const ledger = await Ledger.open(db);
const accounts = new Accounts(ledger);
const vaultAcct = await accounts.vault("acme-2026-10-vault", "ZEC", "zcash_ironwood");
const liability = await accounts.customer(CUSTOMER, "NGN-CNY", "ZEC", "zcash_ironwood");
await ledger.post({
  kind: "near.swap.simulated",
  external: { venue: "internal", ref: `fund:${batchId}` },
  lines: [
    { account: vaultAcct, direction: "D", money: money("ZEC", total) },
    { account: liability, direction: "C", money: money("ZEC", total) },
  ],
});
const sent = shieldedObservations(corridor.outputs().filter((o) => o.txid === txid && o.fromAccount === vault.uuid));
for (const obs of sent.filter((o) => o.reference)) {
  await ledger.post({
    kind: "zcash.shieldedBatch.item",
    reference: obs.reference!,
    external: { venue: "zcash_ironwood", ref: obs.externalRef },
    metadata: { batchId, txid, approvedBy },
    lines: [
      { account: liability, direction: "D", money: money("ZEC", obs.amount) },
      { account: vaultAcct, direction: "C", money: money("ZEC", obs.amount) },
    ],
  });
}

suppliers.sync();
console.log("\nrecipients' view:");
for (const o of suppliers.outputs().filter((o) => o.txid === txid)) {
  const m = o.memo ? fromZcashMemo(o.memo) : null;
  console.log(`  ${o.pool.padEnd(8)} ${formatZec(o.zatoshi)} TAZ  ${m ? m.invoiceRef : "(no memo)"}`);
}

const auditor = new ZcashWallet({ bin: DEVTOOL, walletDir: `.data/zcash-testnet-auditor-${batchId}` });
const minedAt = corridor.outputs().find((o) => o.txid === txid)?.minedHeight ?? corridor.chainTip();
auditor.initViewOnly("auditor-acme-2026-10", vaultKeys.ufvk, minedAt - 10);
auditor.sync();
const seen = shieldedObservations(auditor.outputs()).filter((o) => o.reference);
console.log(`\nauditor (vault viewing key only): ${seen.length} payouts;`, summarize(await reconcile(ledger, seen)));
console.log(`ledger invariants: ${JSON.stringify(await ledger.checkInvariants())}`);
await db.close();
