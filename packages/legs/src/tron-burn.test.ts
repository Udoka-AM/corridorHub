import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { address, generateKeyPairSigner, type Instruction, type TransactionSigner } from "@solana/kit";
import { Keypair } from "@stellar/stellar-sdk";
import type { Hex } from "@corridor/core";
import { solanaAddressOfStellar } from "@corridor/bridge-cctp";
import { openLocalDb } from "@corridor/ledger";
import { NonRetryableError, type Json, type LegContext } from "@corridor/saga";
import { TronBurnStore, tronBurnLeg, type TronDepositData } from "./tron.ts";

const USDC = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const DEPOSIT = "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL";

let db: Awaited<ReturnType<typeof openLocalDb>>;
let burns: TronBurnStore;
let feePayer: TransactionSigner;
let owner: TransactionSigner;

beforeEach(async () => {
  db = await openLocalDb();
  burns = await TronBurnStore.open(db);
  feePayer = await generateKeyPairSigner();
  owner = await generateKeyPairSigner();
});
afterEach(() => db.close());

const STELLAR = Keypair.random().publicKey();

function ctx(outputs: Record<number, Json>, over: Partial<TronDepositData> = {}): LegContext<TronDepositData> {
  return {
    sagaId: "saga-1",
    step: { index: 1, kind: "tron.burn", from: { venue: "solana", asset: "USDC" }, to: { venue: "stellar", asset: "USDC" } } as never,
    plan: {} as never,
    data: {
      depositAddress: DEPOSIT,
      tronAmount: "150000000",
      solanaAddress: solanaAddressOfStellar(STELLAR),
      stellarAccount: STELLAR,
      refundTo: "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC",
      reference: "0x00" as Hex,
      ...over,
    },
    idempotencyKey: "key-1",
    outputs,
    accounts: {} as never,
  };
}

function leg(submit = vi.fn(async (_ix: Instruction) => "burn-sig-1")) {
  const ownerFor = vi.fn(async (_account: string) => owner);
  return {
    submit,
    ownerFor,
    leg: tronBurnLeg({ network: "testnet", burns, usdcMint: USDC, feePayer, ownerFor, submit }),
  };
}

const DELIVERED = { 0: { state: "SUCCESS", solanaAmount: "149767242", solanaTx: "sol-tx" } };

describe("burning a Tron deposit onward to the hub", () => {
  it("burns what the solver delivered, not what the quote predicted", async () => {
    const h = leg();
    const out = await h.leg.forward(ctx(DELIVERED));
    // The quote said 150.000000 USDT in; 149.767242 USDC actually arrived.
    expect(out.output).toMatchObject({ burnTx: "burn-sig-1", amount: "149767242" });
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("asks the app for the signer of the user's own account", async () => {
    const h = leg();
    await h.leg.forward(ctx(DELIVERED));
    expect(h.ownerFor).toHaveBeenCalledWith(STELLAR);
  });

  it("puts the user on the burn as owner and Corridor only as fee payer", async () => {
    const h = leg();
    await h.leg.forward(ctx(DELIVERED));
    const accounts = h.submit.mock.calls[0]![0].accounts!.map((a) => String(a.address));
    expect(accounts).toContain(owner.address);
    expect(accounts).toContain(feePayer.address);
    // The user's key is the owner, so Corridor's fee payer is not the one
    // whose USDC moves.
    expect(owner.address).not.toBe(feePayer.address);
  });

  it("books nothing, because the hub credit belongs to the mint", async () => {
    const h = leg();
    const out = await h.leg.forward(ctx(DELIVERED));
    expect(out.bookings).toEqual([]);
  });

  it("does not burn twice when the step runs again", async () => {
    const h = leg();
    await h.leg.forward(ctx(DELIVERED));
    const again = await h.leg.forward(ctx(DELIVERED));
    expect(h.submit).toHaveBeenCalledOnce();
    expect(again.output).toMatchObject({ burnTx: "burn-sig-1" });
  });

  it("does not burn twice when a second saga runs over the same deposit", async () => {
    const h = leg();
    await h.leg.forward(ctx(DELIVERED));
    // A different saga has a different idempotency key; the deposit address
    // is what identifies the swap, so it is what the store is keyed on.
    const other = { ...ctx(DELIVERED), sagaId: "saga-2", idempotencyKey: "key-2" };
    await h.leg.forward(other);
    expect(h.submit).toHaveBeenCalledOnce();
  });

  it("refuses to run before the swap has recorded what it delivered", async () => {
    const h = leg();
    await expect(h.leg.forward(ctx({}))).rejects.toBeInstanceOf(NonRetryableError);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("remembers the hash even though the chain is what settles it", async () => {
    const h = leg();
    await h.leg.forward(ctx(DELIVERED));
    await expect(burns.submitted(DEPOSIT)).resolves.toBe("burn-sig-1");
  });
});
