import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import type { RoutePlan } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type Leg, type PayoutData } from "./index.ts";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;
let accounts: Accounts;

/**
 * An explicit three-step plan. These tests are about the engine — ordering,
 * retries, compensation, fencing — so the plan is written out rather than
 * planned, and they do not move when a corridor's routing changes.
 */
const hub = { venue: "stellar", asset: "USDC" } as const;
const plan: RoutePlan = {
  corridor: "EUR-NGN",
  purpose: "payout",
  privacy: "public",
  steps: [
    { index: 0, kind: "ledger.reserve", from: hub, to: hub, referenceScope: "payout" },
    { index: 1, kind: "bridge.simulated", from: hub, to: { venue: "solana", asset: "USDC" }, referenceScope: "payout" },
    { index: 2, kind: "partner.payout", from: { venue: "solana", asset: "USDC" }, to: { venue: "partner_fiat", asset: "NGN" }, referenceScope: "payout" },
  ],
};

const data: PayoutData = {
  payoutId: "p1",
  customerId: "eu-payco",
  corridor: "EUR-NGN",
  asset: "USDC",
  venue: "stellar",
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
      const vault = await ctx.accounts.vault("treasury", "USDC", "stellar");
      const clearing = await ctx.accounts.clearing(kind, "USDC", "stellar");
      return {
        output: { ok: kind },
        bookings: [
          {
            kind,
            lines: [
              { account: clearing, direction: "D", money: money("USDC", 1n) },
              { account: vault, direction: "C", money: money("USDC", 1n) },
            ],
          },
        ],
      };
    },
    async compensate(ctx) {
      log.push(`comp ${kind}`);
      const vault = await ctx.accounts.vault("treasury", "USDC", "stellar");
      const clearing = await ctx.accounts.clearing(kind, "USDC", "stellar");
      return {
        output: { undone: kind },
        bookings: [
          {
            kind: `${kind}.undo`,
            lines: [
              { account: vault, direction: "D", money: money("USDC", 1n) },
              { account: clearing, direction: "C", money: money("USDC", 1n) },
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
  const vault = await accounts.vault("treasury", "USDC", "stellar");
  const customer = await accounts.customer("eu-payco", "EUR-NGN", "USDC", "stellar");
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: vault, direction: "D", money: money("USDC", 10_000_000n) },
      { account: customer, direction: "C", money: money("USDC", 10_000_000n) },
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

    const hold = await accounts.customerHold("eu-payco", "EUR-NGN", "USDC", "stellar");
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
    const available = await accounts.customer("eu-payco", "EUR-NGN", "USDC", "stellar");
    const hold = await accounts.customerHold("eu-payco", "EUR-NGN", "USDC", "stellar");
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

  /** A promise the test resolves by hand, so the two workers interleave in a fixed order. */
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  };

  it("fences out a worker whose lease expired mid-leg: its bookings and step result are never committed", async () => {
    const calls: string[] = [];
    let booked = 0;
    const insideA = deferred();
    const releaseA = deferred();

    /**
     * A leg whose every call books a distinct movement, so only fencing (not
     * idempotency) can stop a double booking.
     *
     * Worker A parks inside the leg until the test lets it go. That is what
     * makes this a sequence rather than a bet on wall-clock timing: the old
     * version slept, and under load A could still be in the step before it —
     * or not have taken the lease at all — when the sleep elapsed.
     */
    const bridge = (worker: string): Leg<PayoutData> => ({
      kind: "bridge.simulated",
      backoffMs: 1,
      async forward(ctx) {
        calls.push(worker);
        if (worker === "A") {
          insideA.resolve();
          await releaseA.promise;
        }
        const vault = await ctx.accounts.vault("treasury", "USDC", "stellar");
        const clearing = await ctx.accounts.clearing("bridge", "USDC", "stellar");
        return {
          output: { by: worker },
          bookings: [
            {
              kind: "bridge.move",
              // Distinct per call by construction. Keying this on the clock
              // meant two calls in the same millisecond shared a reference
              // and were deduplicated — which would pass whether or not
              // fencing worked.
              external: { venue: "internal", ref: `${worker}:${++booked}` },
              lines: [
                { account: clearing, direction: "D", money: money("USDC", 1n) },
                { account: vault, direction: "C", money: money("USDC", 1n) },
              ],
            },
          ],
        };
      },
    });
    const a = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, bridge("A"), fakeLeg("partner.payout", [])]);
    const b = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, bridge("B"), fakeLeg("partner.payout", [])]);
    const id = await a.start({ kind: "payout", plan, data });

    const runA = a.run(id);
    await insideA.promise; // A holds the lease and is inside the bridge leg
    // Lapse A's lease outright. What is under test is a lease that expired,
    // not how long one takes to expire, and the engine compares against the
    // database's clock — so this is the same condition without the race.
    await db.query(`update sagas set lease_until = now() - interval '1 minute' where id = $1`, [id]);

    expect(await b.run(id)).toBe("completed"); // B takes over and finishes
    releaseA.resolve();
    expect(await runA).toBe("completed"); // A wakes up, is fenced out, and reports the real status

    expect(calls).toEqual(["A", "B"]);
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from journal_entries where kind = 'bridge.move'`);
    expect(rows[0]!.n).toBe(1);
    expect((await a.get(id)).steps[1]!.output).toEqual({ by: "B" });
    expect(await ledger.checkInvariants()).toEqual([]);
  });
});
