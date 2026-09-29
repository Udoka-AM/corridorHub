/**
 * D2 exit criterion: a public EUR→NGN payout runs through the saga with a
 * real Tempo leg, and a forced partner failure is compensated with a real
 * Tempo reversal. The observer then reconciles every vault movement against
 * the ledger.
 *
 *   pnpm payout:demo
 */
import { mkdirSync } from "node:fs";
import {
  RefKind,
  customerTag,
  encodeRef,
  formatMoney,
  money,
  parseMoney,
  uuidv7,
  type CorridorCode,
} from "@corridor/core";
import {
  TempoObserver,
  balanceOf,
  explorerTx,
  fundFromFaucet,
  tempoClient,
  transferWithReference,
  type TempoClient,
} from "@corridor/chain-tempo";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { ledgerReserveLeg, mockPartnerLeg, simulatedBridgeLeg } from "@corridor/legs";
import { PgCursorStore, reconcile, summarize } from "@corridor/recon";
import { planRoute } from "@corridor/routing";
import { SagaEngine, type PayoutData } from "@corridor/saga";
import { testnetKey } from "./env.ts";

const CUSTOMER_ID = "zynta-demo";
const CORRIDOR: CorridorCode = "EUR-NGN";
const secret = testnetKey("CORRIDOR_REF_SECRET");
const tag = customerTag(CUSTOMER_ID, secret);

const customer = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_CUSTOMER_KEY") });
const treasury = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_VAULT_KEY") });
const escrow = tempoClient({ network: "moderato", privateKey: testnetKey("TEMPO_TESTNET_BRIDGE_ESCROW_KEY") });

async function ensureGas(c: TempoClient, label: string) {
  if ((await balanceOf(c, "pathUSD", c.account.address)) < parseMoney("pathUSD", "10").amount) {
    console.log(`funding ${label} from faucet…`);
    await fundFromFaucet(c, c.account.address);
  }
}
await ensureGas(customer, "customer");
await ensureGas(treasury, "treasury");
await ensureGas(escrow, "bridge escrow");

mkdirSync(".data", { recursive: true });
const db = await openLocalDb(".data/ledger");
const ledger = await Ledger.open(db);
const accounts = new Accounts(ledger);
const cursors = await PgCursorStore.open(db);
const engine = await SagaEngine.open(db, ledger, accounts, [
  ledgerReserveLeg,
  simulatedBridgeLeg({ treasury, escrow }),
  mockPartnerLeg(),
]);

const startBlock = await treasury.getBlockNumber();
const observer = new TempoObserver(treasury, {
  name: "tempo-moderato-vaults",
  asset: "pathUSD",
  addresses: [treasury.account.address, escrow.account.address],
  cursors,
  startBlock,
});

// 1. The PSP pre-funds 20 pathUSD. Booked from the on-chain observation.
const depositRef = encodeRef({ kind: RefKind.Deposit, corridor: CORRIDOR, shielded: false, id: uuidv7(), customerTag: tag });
const deposit = await transferWithReference(customer, {
  asset: "pathUSD",
  to: treasury.account.address,
  amount: parseMoney("pathUSD", "20").amount,
  reference: depositRef,
});
await ledger.post({
  kind: "tempo.deposit",
  reference: depositRef,
  external: { venue: "tempo", ref: deposit.externalRef },
  lines: [
    { account: await accounts.vault("treasury", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", deposit.amount) },
    { account: await accounts.customer(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo"), direction: "C", money: money("pathUSD", deposit.amount) },
  ],
});
console.log(`\ndeposit   ${formatMoney(money("pathUSD", deposit.amount))}  ${explorerTx("moderato", deposit.txHash)}`);

// 2. Plan and run two payouts: one clean, one where the partner fails.
const plan = planRoute({
  corridor: CORRIDOR,
  privacy: "public",
  source: { venue: "tempo", asset: "pathUSD" },
  destination: { venue: "partner_fiat", asset: "NGN" },
  env: "testnet",
});
console.log(`route     ${plan.steps.map((s) => s.kind).join(" → ")}`);

async function payout(amount: string, failAtPartner: boolean) {
  const payoutId = uuidv7();
  const data: PayoutData = {
    payoutId,
    customerId: CUSTOMER_ID,
    corridor: CORRIDOR,
    asset: "pathUSD",
    venue: "tempo",
    amount: parseMoney("pathUSD", amount).amount.toString(),
    reference: encodeRef({ kind: RefKind.Payout, corridor: CORRIDOR, shielded: false, id: payoutId, customerTag: tag }),
    recipient: { kind: "bank", bank: "058", account: "0123456789", name: "Ada Obi" },
    tempoStartBlock: startBlock.toString(),
  };
  const id = await engine.start({
    kind: "payout",
    reference: data.reference,
    plan,
    data,
    faults: failAtPartner ? { failAt: "partner.payout" } : undefined,
  });
  const status = await engine.run(id);
  const view = await engine.get(id);
  console.log(`\npayout ${amount} pathUSD  → ${status.toUpperCase()}  (saga ${id})`);
  for (const s of view.steps) {
    const out = s.output as Record<string, string> | null;
    const tx = out?.tempoDeposit ?? out?.tempoRefund;
    console.log(`  ${s.idx} ${s.kind.padEnd(18)} ${s.status.padEnd(12)} ${s.error ?? ""}`);
    if (tx) console.log(`      ${explorerTx("moderato", tx.split(":")[0]!)}`);
  }
  for (const e of view.events.filter((e) => e.event.startsWith("compensat"))) {
    const out = e.detail ? (JSON.parse(e.detail) as Record<string, string>) : {};
    if (out.tempoRefund) console.log(`  reversal  ${explorerTx("moderato", out.tempoRefund.split(":")[0]!)}`);
  }
}

await payout("7", false);
await payout("4", true);

// 3. Reconcile everything the observer saw on the vaults against the books.
const observations = await observer.poll();
const results = await reconcile(ledger, observations);
console.log(`\nreconciliation over ${observations.length} Tempo movements:`, summarize(results));
for (const r of results) {
  console.log(`  ${r.status.padEnd(12)} ${formatMoney(money("pathUSD", r.observation.amount)).padEnd(14)} ${r.observation.externalRef.slice(0, 20)}…`);
}

const available = await accounts.customer(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo");
const hold = await accounts.customerHold(CUSTOMER_ID, CORRIDOR, "pathUSD", "tempo");
console.log(`\ncustomer available ${formatMoney(await ledger.balance(available))}, held ${formatMoney(await ledger.balance(hold))}`);
console.log(`clearing usd-peg   ${formatMoney(await ledger.balance(await accounts.clearing("usd-peg", "pathUSD", "tempo")))} / ${formatMoney(await ledger.balance(await accounts.clearing("usd-peg", "USDC", "solana")))}`);
console.log(`invariants         ${JSON.stringify(await ledger.checkInvariants())}`);
await db.close();

if (results.some((r) => r.status !== "matched")) process.exitCode = 1;
