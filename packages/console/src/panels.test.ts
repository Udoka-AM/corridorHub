import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { bookedFees, corridorBoard, exceptionsQueue, fundingForecast, settlementTimeline, venueBalances } from "./panels.ts";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let a: Accounts;

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  a = new Accounts(ledger);
  // The console reads the saga tables, which the engine owns; the panels are
  // tested against the same shape without booting an engine.
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
});
afterEach(() => db.close());

const CORRIDOR = "USD-KES";

describe("the corridor board", () => {
  it("reports what Corridor owes a customer as a positive balance", async () => {
    // A customer account is a liability: credits exceed debits. Read as
    // debit-normal it would come back negative.
    const vault = await a.vault("treasury", "USDC", "stellar");
    const customer = await a.customer("acme", CORRIDOR, "USDC", "stellar");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 1_000_0000n) },
        { account: customer, direction: "C", money: money("USDC", 1_000_0000n) },
      ],
    });
    const board = await corridorBoard(db);
    expect(board).toEqual([
      { customerId: "acme", corridor: CORRIDOR, asset: "USDC", venue: "stellar", available: "10000000", held: "0" },
    ]);
  });

  it("shows a payout in flight as held, out of available but still Corridor's", async () => {
    const vault = await a.vault("treasury", "USDC", "stellar");
    const customer = await a.customer("acme", CORRIDOR, "USDC", "stellar");
    const hold = await a.customerHold("acme", CORRIDOR, "USDC", "stellar");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 1_000_0000n) },
        { account: customer, direction: "C", money: money("USDC", 1_000_0000n) },
      ],
    });
    await ledger.post({
      kind: "reserve",
      lines: [
        { account: customer, direction: "D", money: money("USDC", 250_0000n) },
        { account: hold, direction: "C", money: money("USDC", 250_0000n) },
      ],
    });
    const [row] = await corridorBoard(db);
    expect(row).toMatchObject({ available: "7500000", held: "2500000" });
  });
});

describe("venue balances", () => {
  it("totals the vaults on a venue and nets a closed clearing pair to zero", async () => {
    const hub = await a.vault("treasury", "USDC", "stellar");
    const ingress = await a.vault("solana-ingress", "USDC", "stellar");
    const pegHub = await a.clearing("usd-peg", "USDC", "stellar");
    const pegSpoke = await a.clearing("usd-peg", "USDC", "solana");
    const equity = await a.equity("owner", "USDC", "stellar");
    await ledger.post({
      kind: "fund",
      lines: [
        { account: hub, direction: "D", money: money("USDC", 100_0000n) },
        { account: ingress, direction: "D", money: money("USDC", 50_0000n) },
        { account: equity, direction: "C", money: money("USDC", 150_0000n) },
      ],
    });
    await ledger.post({
      kind: "cctp.burn",
      lines: [
        { account: pegSpoke, direction: "D", money: money("USDC", 30_0000n) },
        { account: pegHub, direction: "C", money: money("USDC", 30_0000n) },
      ],
    });
    const { venues, clearing } = await venueBalances(db);
    const stellar = venues.find((v) => v.venue === "stellar" && v.asset === "USDC")!;
    expect(stellar.total).toBe("1500000");
    expect(stellar.vaults.map((v) => v.name).sort()).toEqual(["solana-ingress", "treasury"]);
    // Both halves of the pair were posted, so it sums to nothing.
    expect(clearing.find((c) => c.name === "usd-peg")!.net).toBe("0");
  });

  it("shows a clearing pair with one half missing as a non-zero net", async () => {
    // Credited against equity, not a vault: a vault is no-overdraft and the
    // ledger would refuse to let it go negative, which is its job, not this
    // panel's subject.
    const equity = await a.equity("owner", "USDC", "stellar");
    const peg = await a.clearing("usd-peg", "USDC", "solana");
    await ledger.post({
      kind: "half",
      lines: [
        { account: peg, direction: "D", money: money("USDC", 30_0000n) },
        { account: equity, direction: "C", money: money("USDC", 30_0000n) },
      ],
    });
    // In transit, or an entry that never got its other half — either way the
    // console must not round it away.
    expect((await venueBalances(db)).clearing.find((c) => c.name === "usd-peg")!.net).toBe("300000");
  });
});

describe("booked fees", () => {
  it("reads revenue as a positive amount earned", async () => {
    const vault = await a.vault("treasury", "USDC", "stellar");
    const fees = await a.revenue("corridor-fee", "USDC", "stellar");
    await ledger.post({
      kind: "fee",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 5_0000n) },
        { account: fees, direction: "C", money: money("USDC", 5_0000n) },
      ],
    });
    expect(await bookedFees(db)).toEqual([{ name: "corridor-fee", asset: "USDC", venue: "stellar", booked: "50000" }]);
  });
});

async function saga(id: string, status: string, steps: [number, string, string, unknown?, string?][], ref = "0xref") {
  await db.query(`insert into sagas (id, kind, reference, status) values ($1,'payout',$2,$3)`, [id, ref, status]);
  for (const [idx, kind, stepStatus, output, error] of steps) {
    await db.query(
      `insert into saga_steps (saga_id, idx, kind, status, attempts, output, error) values ($1,$2,$3,$4,1,$5,$6)`,
      [id, idx, kind, stepStatus, output === undefined ? null : JSON.stringify(output), error ?? null],
    );
  }
}

describe("the settlement timeline", () => {
  it("lists the most recently touched saga first, with its steps in order", async () => {
    await saga("s-old", "completed", [[0, "ledger.reserve", "done"]]);
    await saga("s-new", "running", [
      [0, "ledger.reserve", "done"],
      [1, "partner.payout", "pending"],
    ]);
    await db.query(`update sagas set updated_at = now() - interval '1 hour' where id = 's-old'`);
    const rows = await settlementTimeline(db);
    expect(rows.map((r) => r.sagaId)).toEqual(["s-new", "s-old"]);
    expect(rows[0]!.steps.map((s) => s.idx)).toEqual([0, 1]);
  });

  it("surfaces the transaction a step produced, whatever the leg called it", async () => {
    await saga("s-1", "completed", [
      [0, "tron.swap", "done", { solanaTx: "sol-tx" }],
      [1, "tron.burn", "done", { burnTx: "burn-tx" }],
      [2, "cctp.transfer", "done", { mintTx: "mint-tx" }],
      [3, "ledger.credit", "done", { amount: "1" }],
    ]);
    const steps = (await settlementTimeline(db))[0]!.steps;
    expect(steps.map((s) => s.txHash)).toEqual(["sol-tx", "burn-tx", "mint-tx", undefined]);
  });

  it("honours the limit so the panel does not grow without bound", async () => {
    for (let i = 0; i < 5; i++) await saga(`s-${i}`, "completed", [[0, "ledger.credit", "done"]]);
    expect(await settlementTimeline(db, 3)).toHaveLength(3);
  });

  it("returns nothing rather than failing when no saga has run", async () => {
    await expect(settlementTimeline(db)).resolves.toEqual([]);
  });
});

describe("the exceptions queue", () => {
  it("puts a failed compensation above a deliberate stop, because money may be stranded", async () => {
    await saga("s-review", "manual_review", [[0, "partner.payout", "done"]]);
    await saga("s-stranded", "compensating", [[0, "stellar.transfer", "compensation_failed", undefined, "undo did not land"]]);
    const rows = await exceptionsQueue(db);
    expect(rows[0]!.sagaId).toBe("s-stranded");
    expect(rows[0]!.error).toBe("undo did not land");
    expect(rows.map((r) => r.sagaId)).toContain("s-review");
  });

  it("leaves a clean run out of the queue", async () => {
    await saga("s-fine", "completed", [[0, "partner.payout", "done"]]);
    expect(await exceptionsQueue(db)).toEqual([]);
  });

  it("picks up a failed step even when the saga is still running", async () => {
    await saga("s-retrying", "running", [[0, "partner.payout", "failed", undefined, "anchor timed out"]]);
    const rows = await exceptionsQueue(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sagaStatus: "running", stepStatus: "failed", stepKind: "partner.payout" });
  });
});

describe("the pre-funding forecast", () => {
  it("works out a daily rate and how long the balance covers it", async () => {
    const vault = await a.vault("treasury", "USDC", "stellar");
    const customer = await a.customer("acme", CORRIDOR, "USDC", "stellar");
    const hold = await a.customerHold("acme", CORRIDOR, "USDC", "stellar");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 700n) },
        { account: customer, direction: "C", money: money("USDC", 700n) },
      ],
    });
    // 70 spent over a 7-day window: 10 a day, and 630 left covers 63 days.
    await ledger.post({
      kind: "reserve",
      lines: [
        { account: customer, direction: "D", money: money("USDC", 70n) },
        { account: hold, direction: "C", money: money("USDC", 70n) },
      ],
    });
    const [row] = await fundingForecast(db, { days: 7 });
    expect(row).toMatchObject({ customerId: "acme", outflow: "70", perDay: "10", available: "630", daysOfCover: 63 });
  });

  it("reports no cover rather than infinite cover for a customer who has not spent", async () => {
    const vault = await a.vault("treasury", "USDC", "stellar");
    const customer = await a.customer("quiet", CORRIDOR, "USDC", "stellar");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 500n) },
        { account: customer, direction: "C", money: money("USDC", 500n) },
      ],
    });
    const [row] = await fundingForecast(db, { days: 7 });
    // Showing a well-funded tick here would be a guess dressed as a number.
    expect(row).toMatchObject({ outflow: "0", perDay: "0", available: "500", daysOfCover: null });
  });

  it("ignores spending older than the window", async () => {
    const vault = await a.vault("treasury", "USDC", "stellar");
    const customer = await a.customer("acme", CORRIDOR, "USDC", "stellar");
    const hold = await a.customerHold("acme", CORRIDOR, "USDC", "stellar");
    await ledger.post({
      kind: "deposit",
      lines: [
        { account: vault, direction: "D", money: money("USDC", 700n) },
        { account: customer, direction: "C", money: money("USDC", 700n) },
      ],
    });
    await ledger.post({
      kind: "reserve",
      lines: [
        { account: customer, direction: "D", money: money("USDC", 70n) },
        { account: hold, direction: "C", money: money("USDC", 70n) },
      ],
    });
    // The journal is append-only, so the entry cannot be backdated. The
    // window is moved instead: thirty days on, that spending is out of range.
    const later = new Date(Date.now() + 30 * 86_400_000);
    const [row] = await fundingForecast(db, { days: 7, now: later });
    expect(row).toMatchObject({ outflow: "0", daysOfCover: null });
  });
});
