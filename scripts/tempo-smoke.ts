/**
 * D1 exit criterion: a memo-tagged pathUSD transfer on Tempo Moderato that
 * shows on the explorer and is booked in the ledger exactly once.
 *
 *   pnpm tempo:smoke
 *
 * Generates two testnet keys into .env.local on first run (gitignored):
 * a "customer" wallet standing in for a PSP, and Corridor's treasury vault.
 */
import { mkdirSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { RefKind, customerTag, encodeRef, formatMoney, money, parseMoney, uuidv7 } from "@corridor/core";
import { Ledger, openLocalDb } from "@corridor/ledger";
import { balanceOf, explorerTx, fundFromFaucet, tempoClient, transferWithReference } from "@corridor/chain-tempo";
import { testnetKey as key } from "./env.ts";

const CUSTOMER_ID = "zynta-demo";
const REF_SECRET = process.env.CORRIDOR_REF_SECRET ?? key("CORRIDOR_REF_SECRET");

const customer = tempoClient({ network: "moderato", privateKey: key("TEMPO_TESTNET_CUSTOMER_KEY") });
const vaultAddress = privateKeyToAccount(key("TEMPO_TESTNET_VAULT_KEY")).address;
const customerAddress = customer.account.address;

console.log(`customer ${customerAddress}\nvault    ${vaultAddress}`);

// 1. Fund the customer wallet from the Moderato faucet if it is low.
const amount = parseMoney("pathUSD", "5");
if ((await balanceOf(customer, "pathUSD", customerAddress)) < amount.amount * 2n) {
  console.log("funding customer from faucet…");
  await fundFromFaucet(customer, customerAddress);
}
console.log(`customer balance: ${formatMoney(money("pathUSD", await balanceOf(customer, "pathUSD", customerAddress)))}`);

// 2. A Corridor Reference for this deposit.
const reference = encodeRef({
  kind: RefKind.Payout,
  corridor: "EUR-NGN",
  shielded: false,
  id: uuidv7(),
  customerTag: customerTag(CUSTOMER_ID, REF_SECRET),
});
console.log(`reference ${reference}`);

// 3. Transfer on Tempo with the reference as the TIP-20 memo, then find it again by memo topic.
const obs = await transferWithReference(customer, { asset: "pathUSD", to: vaultAddress, amount: amount.amount, reference });
console.log(`settled: ${explorerTx("moderato", obs.txHash)}`);

// 4. Book it. The second post must be a no-op.
mkdirSync(".data", { recursive: true });
const db = await openLocalDb(".data/ledger");
const ledger = await Ledger.open(db);
const vault = await ledger.openAccount({ type: "asset", ownerType: "vault", ownerId: "treasury", asset: "pathUSD", venue: "tempo", noOverdraft: true });
const liability = await ledger.openAccount({ type: "liability", ownerType: "customer", ownerId: CUSTOMER_ID, corridor: "EUR-NGN", asset: "pathUSD", venue: "tempo", noOverdraft: true });

const entry = {
  kind: "tempo.deposit",
  reference: obs.reference ?? undefined,
  external: { venue: "tempo" as const, ref: obs.externalRef },
  metadata: { from: obs.from, to: obs.to, block: obs.blockNumber?.toString() },
  lines: [
    { account: vault, direction: "D" as const, money: money("pathUSD", obs.amount) },
    { account: liability, direction: "C" as const, money: money("pathUSD", obs.amount) },
  ],
};
const first = await ledger.post(entry);
const replay = await ledger.post(entry);

console.log(`booked entry ${first.entryId} (replay duplicate=${replay.duplicate})`);
console.log(`customer liability: ${formatMoney(await ledger.balance(liability))}`);
console.log(`invariants: ${JSON.stringify(await ledger.checkInvariants())}`);
await db.close();

if (!replay.duplicate || replay.entryId !== first.entryId) throw new Error("exactly-once booking failed");
