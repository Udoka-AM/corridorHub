import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type Leg, type PayoutData } from "./index.ts";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;

const plan = planRoute({
  corridor: "EUR-NGN",
  privacy: "public",
  source: { venue: "tempo", asset: "pathUSD" },
  destination: { venue: "partner_fiat", asset: "NGN" },
  env: "testnet",
});

const data: PayoutData = {
  payoutId: "p1",
  customerId: "eu-payco",
  corridor: "EUR-NGN",
  asset: "pathUSD",
  venue: "tempo",
  amount: "3000000",
  reference: `0x${"ab".repeat(32)}`,
  recipient: { kind: "bank" },
};

/** Test legs that record calls and book through a clearing account. */
function fakeLeg(kind: Leg["kind"], log: string[], opts: { failTimes?: number } = {}): Leg<PayoutData> {
  let failures = opts.failTimes ?? 0;
  return {
    kind,
    backoffMs: 1,
    async forward(ctx) {
      log.push(`fwd ${kind}`);
      if (failures-- > 0) throw new Error(`transient ${kind}`);
      const vault = await ctx.accounts.vault("treasury", "pathUSD", "tempo");
      const clearing = await ctx.accounts.clearing(kind, "pathUSD", "tempo");
      return {
        output: { ok: kind },
        bookings: [
          {
            kind,
            lines: [
              { account: clearing, direction: "D", money: money("pathUSD", 1n) },
              { account: vault, direction: "C", money: money("pathUSD", 1n) },
            ],
          },
        ],
      };
    },
    async compensate(ctx) {
      log.push(`comp ${kind}`);
      const vault = await ctx.accounts.vault("treasury", "pathUSD", "tempo");
      const clearing = await ctx.accounts.clearing(kind, "pathUSD", "tempo");
      return {
        output: { undone: kind },
        bookings: [
          {
            kind: `${kind}.undo`,
            lines: [
              { account: vault, direction: "D", money: money("pathUSD", 1n) },
              { account: clearing, direction: "C", money: money("pathUSD", 1n) },
            ],
          },
        ],
      };
    },
  };
}

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
  accounts = new Accounts(ledger);
  const vault = await accounts.vault("treasury", "pathUSD", "tempo");
  const customer = await accounts.customer("eu-payco", "EUR-NGN", "pathUSD", "tempo");
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: vault, direction: "D", money: money("pathUSD", 10_000_000n) },
      { account: customer, direction: "C", money: money("pathUSD", 10_000_000n) },
    ],
  });
});
afterEach(() => db.close());

describe("saga engine", () => {
  it("runs every planned leg in order and books each once", async () => {
    const log: string[] = [];
    const engine = await SagaEngine.open(db, ledger, accounts, [
      ledgerReserveLeg,
      fakeLeg("bridge.simulated", log),
      fakeLeg("partner.payout", log),
    ]);
    const id = await engine.start({ kind: "payout", plan, data });
    expect(await engine.run(id)).toBe("completed");
    expect(log).toEqual(["fwd bridge.simulated", "fwd partner.payout"]);

    const hold = await accounts.customerHold("eu-payco", "EUR-NGN", "pathUSD", "tempo");
    expect((await ledger.balance(hold)).amount).toBe(3_000_000n);

    // Re-running a finished saga is a no-op.
    expect(await engine.run(id)).toBe("completed");
    expect(log).toHaveLength(2);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("retries transient failures", async () => {
    const log: string[] = [];
    const engine = await SagaEngine.open(db, ledger, accounts, [
      ledgerReserveLeg,
      fakeLeg("bridge.simulated", log, { failTimes: 2 }),
      fakeLeg("partner.payout", log),
    ]);
    const id = await engine.start({ kind: "payout", plan, data });
    expect(await engine.run(id)).toBe("completed");
    expect((await engine.get(id)).steps[1]?.attempts).toBe(3);
  });

  it("compensates completed legs in reverse order when a leg fails", async () => {
    const log: string[] = [];
    const engine = await SagaEngine.open(db, ledger, accounts, [
      ledgerReserveLeg,
      fakeLeg("bridge.simulated", log),
      fakeLeg("partner.payout", log),
    ]);
    const id = await engine.start({ kind: "payout", plan, data, faults: { failAt: "partner.payout" } });
    expect(await engine.run(id)).toBe("compensated");
    expect(log).toEqual(["fwd bridge.simulated", "comp bridge.simulated"]);

    const view = await engine.get(id);
    expect(view.steps.map((s) => s.status)).toEqual(["compensated", "compensated", "failed"]);

    // Customer is whole again and the books still balance.
    const available = await accounts.customer("eu-payco", "EUR-NGN", "pathUSD", "tempo");
    const hold = await accounts.customerHold("eu-payco", "EUR-NGN", "pathUSD", "tempo");
    expect((await ledger.balance(available)).amount).toBe(10_000_000n);
    expect((await ledger.balance(hold)).amount).toBe(0n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("refuses to reserve more than the customer holds", async () => {
    const engine = await SagaEngine.open(db, ledger, accounts, [
      ledgerReserveLeg,
      fakeLeg("bridge.simulated", []),
      fakeLeg("partner.payout", []),
    ]);
    const id = await engine.start({ kind: "payout", plan, data: { ...data, amount: "99000000" } });
    expect(await engine.run(id)).toBe("compensated");
    const view = await engine.get(id);
    expect(view.steps[0]?.error).toMatch(/insufficient funds/);
  });

  it("resumes an interrupted saga without redoing finished legs", async () => {
    const log: string[] = [];
    const legs = [ledgerReserveLeg, fakeLeg("bridge.simulated", log), fakeLeg("partner.payout", log)];
    const engine = await SagaEngine.open(db, ledger, accounts, legs);
    const id = await engine.start({ kind: "payout", plan, data });

    // A worker completes two legs, then hangs forever on the third (a crash, as far as anyone can tell).
    const crashing = await SagaEngine.open(
      db,
      ledger,
      accounts,
      [
        ledgerReserveLeg,
        fakeLeg("bridge.simulated", log),
        { kind: "partner.payout", maxAttempts: 1, forward: () => new Promise(() => {}) },
      ],
      { leaseMs: 300 },
    );
    void crashing.run(id);
    await new Promise((r) => setTimeout(r, 100));

    // While the lease is live, another worker must not touch the saga.
    expect(await engine.run(id)).toBe("running");

    // Once the lease expires, a healthy worker takes over from the unfinished step.
    await new Promise((r) => setTimeout(r, 400));
    expect(await engine.run(id)).toBe("completed");
    expect(log.filter((l) => l === "fwd bridge.simulated")).toHaveLength(1);
  });
});
