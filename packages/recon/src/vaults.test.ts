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

  it("books Solana and Base gas in their native assets the same way, and checks the SOL vault", async () => {
    const SOL_VAULT = "GNaeRSd8Q2LRsTVubmdBF3NzHX8KTSeLUV2rMxN2oMHL";
    const FUNDER = "Funder1111111111111111111111111111111111111";
    const BASE_RELAY = "0x7b54a95e0708b32c6a1299c3930b9abc06ebe43a";
    const at = new Date();
    const sol: Observation[] = [
      { venue: "solana", externalRef: "sigA:sol", reference: null, asset: "SOL", amount: 1_000_000_000n, from: FUNDER, to: SOL_VAULT, blockNumber: 1n, observedAt: at },
      { venue: "solana", externalRef: "sigB:fee", reference: null, asset: "SOL", amount: 5_000n, from: SOL_VAULT, to: "solana:network-fees", blockNumber: 2n, observedAt: at },
      { venue: "solana", externalRef: "sigC:fee", reference: null, asset: "SOL", amount: 5_000n, from: SOL_VAULT, to: "solana:network-fees", blockNumber: 3n, observedAt: at },
      { venue: "solana", externalRef: "sigC:sol", reference: null, asset: "SOL", amount: 1_488_440n, from: SOL_VAULT, to: "solana:account-rent", blockNumber: 3n, observedAt: at },
    ];
    const solOpts = {
      vaults: [{ name: "solana-vault", address: SOL_VAULT, asset: "SOL" as const, venue: "solana" as const }],
      fundingSources: [FUNDER],
      feeCollector: "solana:network-fees",
      expenses: { "solana:account-rent": "account-rent" },
    };
    expect(await bookVaultMovements(ledger, accounts, sol, solOpts)).toEqual({ gas: 2, other: 1, funding: 1, failed: [] });
    const [check] = await checkVaults(accounts, ledger, [{ ...solOpts.vaults[0]!, onchain: 1_000_000_000n - 10_000n - 1_488_440n }]);
    expect(check).toMatchObject({ status: "balanced", diff: 0n });
    expect((await ledger.balance(await accounts.expense("gas", "SOL", "solana"))).amount).toBe(10_000n);
    expect((await ledger.balance(await accounts.expense("account-rent", "SOL", "solana"))).amount).toBe(1_488_440n);

    const base: Observation[] = [
      { venue: "base", externalRef: "0xfund:0", reference: null, asset: "ETH", amount: 10n ** 15n, from: FUNDER, to: BASE_RELAY, blockNumber: 5n, observedAt: at },
      { venue: "base", externalRef: "0xdeposit:fee", reference: null, asset: "ETH", amount: 400_000_000_000n, from: BASE_RELAY, to: "base:network-fees", blockNumber: 6n, observedAt: at },
    ];
    const baseOpts = {
      vaults: [{ name: "base-relay", address: BASE_RELAY, asset: "ETH" as const, venue: "base" as const }],
      fundingSources: [FUNDER],
      feeCollector: "base:network-fees",
    };
    expect(await bookVaultMovements(ledger, accounts, base, baseOpts)).toEqual({ gas: 1, funding: 1, failed: [] });
    expect((await ledger.balance(await accounts.expense("gas", "ETH", "base"))).amount).toBe(400_000_000_000n);
    expect(await ledger.checkInvariants()).toEqual([]);
  });
});
