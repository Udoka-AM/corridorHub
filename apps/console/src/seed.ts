/**
 * Fill a local ledger with demo figures so the console can be looked at
 * without a testnet run.
 *
 *   pnpm console:demo && RAMP_DATA_DIR=.data/console-demo pnpm console:serve
 *
 * Every number here is invented. It writes to its own directory so it cannot
 * be mistaken for, or mixed into, a real run's books.
 */
import { mkdirSync } from "node:fs";
import { money } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";

const dir = process.env.SEED_DIR ?? ".data/console-demo";
mkdirSync(dir, { recursive: true });
const db = await openLocalDb(dir);
const ledger = await Ledger.open(db);
const a = new Accounts(ledger);

const treasury = await a.vault("treasury", "USDC", "stellar");
const ingress = await a.vault("solana-ingress", "USDC", "solana");
const equity = await a.equity("owner", "USDC", "stellar");
const acme = await a.customer("acme", "USD-KES", "USDC", "stellar");
const acmeHold = await a.customerHold("acme", "USD-KES", "USDC", "stellar");
const kola = await a.customer("kola-remit", "USD-NGN", "USDC", "stellar");
const fees = await a.revenue("corridor-fee", "USDC", "stellar");
const pegHub = await a.clearing("usd-peg", "USDC", "stellar");
const pegSpoke = await a.clearing("usd-peg", "USDC", "solana");

await ledger.post({ kind: "fund", lines: [
  { account: treasury, direction: "D", money: money("USDC", 250_000_0000000n) },
  { account: ingress, direction: "D", money: money("USDC", 40_000_0000000n) },
  { account: equity, direction: "C", money: money("USDC", 290_000_0000000n) },
]});
await ledger.post({ kind: "deposit", lines: [
  { account: treasury, direction: "D", money: money("USDC", 120_000_0000000n) },
  { account: acme, direction: "C", money: money("USDC", 120_000_0000000n) },
]});
await ledger.post({ kind: "deposit", lines: [
  { account: treasury, direction: "D", money: money("USDC", 18_500_0000000n) },
  { account: kola, direction: "C", money: money("USDC", 18_500_0000000n) },
]});
await ledger.post({ kind: "reserve", lines: [
  { account: acme, direction: "D", money: money("USDC", 7_400_0000000n) },
  { account: acmeHold, direction: "C", money: money("USDC", 7_400_0000000n) },
]});
await ledger.post({ kind: "fee", lines: [
  { account: treasury, direction: "D", money: money("USDC", 86_5000000n) },
  { account: fees, direction: "C", money: money("USDC", 86_5000000n) },
]});
// A CCTP burn in flight: one half of the pair posted, so it does not net.
await ledger.post({ kind: "cctp.burn", lines: [
  { account: pegSpoke, direction: "D", money: money("USDC", 5_000_0000000n) },
  { account: ingress, direction: "C", money: money("USDC", 5_000_0000000n) },
]});

await db.exec(`
  create table if not exists sagas (
    id text primary key, kind text not null, reference text, status text not null,
    input jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(), updated_at timestamptz not null default now());
  create table if not exists saga_steps (
    saga_id text not null references sagas (id), idx int not null, kind text not null,
    status text not null, attempts int not null default 0, output jsonb, error text,
    updated_at timestamptz not null default now(), primary key (saga_id, idx));
`);
const saga = async (id: string, status: string, ref: string, steps: [number, string, string, unknown?, string?][]) => {
  await db.query(`insert into sagas (id, kind, reference, status) values ($1,'payout',$2,$3) on conflict (id) do nothing`, [id, ref, status]);
  for (const [idx, kind, st, output, error] of steps) {
    await db.query(`insert into saga_steps (saga_id, idx, kind, status, attempts, output, error) values ($1,$2,$3,$4,1,$5,$6) on conflict do nothing`,
      [id, idx, kind, st, output === undefined ? null : JSON.stringify(output), error ?? null]);
  }
};
await saga("pay_01JD", "completed", "0x9f2c", [
  [0, "ledger.reserve", "done"],
  [1, "partner.payout", "done", { txHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90" }],
]);
await saga("dep_01JE", "running", "0x44ab", [
  [0, "tron.swap", "done", { solanaTx: "5Qk9xTjVnP2mWcR8hLbY" }],
  [1, "tron.burn", "done", { burnTx: "3Fm2pQvXnZ8kLwTt1aDe" }],
  [2, "cctp.transfer", "pending"],
]);
await saga("pay_01JF", "manual_review", "0x7d10", [
  [0, "ledger.reserve", "done"],
  [1, "partner.payout", "done", { settlement: "1" }],
]);
await saga("pay_01JG", "compensating", "0x2e55", [
  [0, "ledger.reserve", "done"],
  [1, "stellar.transfer", "compensation_failed", undefined, "refund payment did not confirm within the window"],
]);
console.log(`seeded demo figures into ${dir} — invented numbers, not a real run`);
await db.close();
