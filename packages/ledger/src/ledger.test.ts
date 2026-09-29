import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { money } from "@corridor/core";
import { Ledger, LedgerError, openLocalDb } from "./index.ts";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let ledger: Ledger;

beforeEach(async () => {
  db = await openLocalDb();
  ledger = await Ledger.open(db);
});
afterEach(() => db.close());

/** Customer funds held in a Corridor vault on Tempo. */
async function fundedCustomer(amount: bigint) {
  const vault = await ledger.openAccount({ type: "asset", ownerType: "vault", ownerId: "routing", asset: "pathUSD", venue: "tempo", noOverdraft: true });
  const customer = await ledger.openAccount({ type: "liability", ownerType: "customer", ownerId: "zynta", corridor: "EUR-NGN", asset: "pathUSD", venue: "tempo", noOverdraft: true });
  await ledger.post({
    kind: "deposit",
    lines: [
      { account: vault, direction: "D", money: money("pathUSD", amount) },
      { account: customer, direction: "C", money: money("pathUSD", amount) },
    ],
  });
  return { vault, customer };
}

describe("ledger", () => {
  it("books a balanced entry and projects natural balances", async () => {
    const { vault, customer } = await fundedCustomer(100_000_000n);
    expect((await ledger.balance(vault)).amount).toBe(100_000_000n);
    expect((await ledger.balance(customer)).amount).toBe(100_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("rejects an entry that does not balance", async () => {
    const { vault, customer } = await fundedCustomer(10n);
    await expect(
      ledger.post({
        kind: "bad",
        lines: [
          { account: vault, direction: "D", money: money("pathUSD", 5n) },
          { account: customer, direction: "C", money: money("pathUSD", 4n) },
        ],
      }),
    ).rejects.toThrow(LedgerError);
  });

  it("rejects a posting in the wrong asset for the account", async () => {
    const { vault } = await fundedCustomer(10n);
    const zec = await ledger.openAccount({ type: "asset", ownerType: "vault", ownerId: "shielded", asset: "ZEC", venue: "zcash_ironwood" });
    await expect(
      ledger.post({
        kind: "bad",
        lines: [
          { account: vault, direction: "D", money: money("ZEC", 5n) },
          { account: zec, direction: "C", money: money("ZEC", 5n) },
        ],
      }),
    ).rejects.toThrow(/holds pathUSD/);
  });

  it("refuses to overdraw a customer and leaves no partial writes", async () => {
    const { vault, customer } = await fundedCustomer(10_000_000n);
    const out = await ledger.openAccount({ type: "asset", ownerType: "partner", ownerId: "paj", asset: "pathUSD", venue: "tempo" });
    await expect(
      ledger.post({
        kind: "payout",
        lines: [
          { account: customer, direction: "D", money: money("pathUSD", 20_000_000n) },
          { account: out, direction: "C", money: money("pathUSD", 20_000_000n) },
        ],
      }),
    ).rejects.toThrow(/insufficient funds/);
    expect((await ledger.balance(customer)).amount).toBe(10_000_000n);
    expect((await ledger.balance(vault)).amount).toBe(10_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });

  it("books an on-chain movement exactly once", async () => {
    const { vault, customer } = await fundedCustomer(10_000_000n);
    const routing = await ledger.openAccount({ type: "asset", ownerType: "vault", ownerId: "egress", asset: "pathUSD", venue: "tempo" });
    const entry = {
      kind: "tempo.transfer",
      reference: "0xabc",
      external: { venue: "tempo" as const, ref: "0xtxhash:3" },
      lines: [
        { account: routing, direction: "D" as const, money: money("pathUSD", 1_000_000n) },
        { account: vault, direction: "C" as const, money: money("pathUSD", 1_000_000n) },
      ],
    };
    const first = await ledger.post(entry);
    const again = await ledger.post(entry);
    expect(again).toEqual({ entryId: first.entryId, duplicate: true });
    expect((await ledger.balance(routing)).amount).toBe(1_000_000n);
    expect(await ledger.entriesByReference("0xabc")).toHaveLength(1);
    expect(customer).toBeDefined();
  });

  it("keeps the journal append-only", async () => {
    await fundedCustomer(1n);
    await expect(db.query(`update postings set amount = 2`)).rejects.toThrow(/append-only/);
    await expect(db.query(`delete from journal_entries`)).rejects.toThrow(/append-only/);
  });

  it("moves value into the shielded venue through a clearing account", async () => {
    // pathUSD on Tempo -> ZEC in the Ironwood pool, the start of a shielded batch.
    const { customer } = await fundedCustomer(50_000_000n);
    const usdClearing = await ledger.openAccount({ type: "clearing", ownerType: "fx", ownerId: "USD-ZEC", asset: "pathUSD", venue: "tempo" });
    const zecClearing = await ledger.openAccount({ type: "clearing", ownerType: "fx", ownerId: "USD-ZEC", asset: "ZEC", venue: "zcash_ironwood" });
    const shielded = await ledger.openAccount({ type: "liability", ownerType: "customer", ownerId: "zynta", corridor: "USD-SHIELDED", asset: "ZEC", venue: "zcash_ironwood", noOverdraft: true });

    await ledger.post({
      kind: "near.swap",
      lines: [
        { account: customer, direction: "D", money: money("pathUSD", 50_000_000n) },
        { account: usdClearing, direction: "C", money: money("pathUSD", 50_000_000n) },
        { account: zecClearing, direction: "D", money: money("ZEC", 125_000_000n) },
        { account: shielded, direction: "C", money: money("ZEC", 125_000_000n) },
      ],
    });
    expect(await ledger.balance(shielded)).toEqual({ asset: "ZEC", amount: 125_000_000n });
    expect(await ledger.checkInvariants()).toEqual([]);
  });
});
