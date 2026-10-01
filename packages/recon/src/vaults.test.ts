import { beforeEach, describe, expect, it } from "vitest";
import { money, type Observation } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { bookVaultMovements, checkVaults, reconcile, summarize } from "./index.ts";

const TREASURY = "0xb4f90ffbf68a7c235d2fee06add744aabe1c312f";
const FEE_MANAGER = "0xfeec000000000000000000000000000000000000";
const ZERO = "0x0000000000000000000000000000000000000000";
const STRANGER = "0x1111111111111111111111111111111111111111";
const opts = {
  vaults: [{ name: "treasury", address: TREASURY, asset: "pathUSD" as const, venue: "tempo" as const }],
  fundingSources: [ZERO],
  feeCollector: FEE_MANAGER,
};

const obs = (ref: string, from: string, to: string, amount: bigint, block: bigint): Observation => ({
  venue: "tempo",
  externalRef: ref,
  reference: null,
  asset: "pathUSD",
  amount,
  from,
  to,
  blockNumber: block,
  observedAt: new Date(),
});

let ledger: Ledger;
let accounts: Accounts;
beforeEach(async () => {
  ledger = await Ledger.open(await openLocalDb());
  accounts = new Accounts(ledger);
});

describe("vault accounting", () => {
  it("books funding before the fees it pays for, exactly once", async () => {
    // Fee listed first but happened later: chain order decides.
    const movements = [obs("0xb:2", TREASURY, FEE_MANAGER, 98n, 20n), obs("0xa:0", ZERO, TREASURY, 1_000_000n, 10n)];
    expect(await bookVaultMovements(ledger, accounts, movements, opts)).toEqual({ gas: 1, funding: 1, failed: [] });
    expect(await bookVaultMovements(ledger, accounts, movements, opts)).toEqual({ gas: 0, funding: 0, failed: [] });

    const vault = await accounts.vault("treasury", "pathUSD", "tempo");
    expect(await ledger.balance(vault)).toEqual(money("pathUSD", 999_902n));
    expect(await ledger.balance(await accounts.expense("gas", "pathUSD", "tempo"))).toEqual(money("pathUSD", 98n));
    expect(summarize(await reconcile(ledger, movements)).matched).toBe(2);
  });

  it("never credits an unidentified deposit", async () => {
    const stray = obs("0xc:0", STRANGER, TREASURY, 5_000_000n, 30n);
    expect(await bookVaultMovements(ledger, accounts, [stray], opts)).toEqual({ gas: 0, funding: 0, failed: [] });
    expect(summarize(await reconcile(ledger, [stray])).unreferenced).toBe(1);
  });

  it("reports a fee that would overdraw the vault instead of booking it", async () => {
    const r = await bookVaultMovements(ledger, accounts, [obs("0xd:1", TREASURY, FEE_MANAGER, 98n, 40n)], opts);
    expect(r.gas).toBe(0);
    expect(r.failed[0]?.error).toMatch(/insufficient funds/);
  });

  it("compares each vault's on-chain balance with the ledger", async () => {
    await bookVaultMovements(ledger, accounts, [obs("0xa:0", ZERO, TREASURY, 1_000_000n, 10n)], opts);
    const [ok] = await checkVaults(accounts, ledger, [{ ...opts.vaults[0]!, onchain: 1_000_000n }]);
    expect(ok).toMatchObject({ status: "balanced", diff: 0n });
    const [off] = await checkVaults(accounts, ledger, [{ ...opts.vaults[0]!, onchain: 1_000_098n }]);
    expect(off).toMatchObject({ status: "drift", diff: 98n });
  });
});
