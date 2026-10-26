import { afterEach, describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, type Transaction } from "@stellar/stellar-sdk";
import { RefKind, decodeRef } from "@corridor/core";
import { Iris, solanaAddressOfStellar } from "@corridor/bridge-cctp";
import { localStellarSigner } from "@corridor/chain-stellar";
import { address, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { OneClick } from "@corridor/swap-intents";
import { RampError } from "./errors.ts";
import { testRamp } from "./testing.ts";
import type { TronLaneOptions } from "./tron.ts";

const USDC_MINT = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const TRON = "TJRyWwFs9wTFGZg3JbrVriFbNfCug5tDeC";
const DEPOSIT_ADDRESS = "TWd4JxMVfwRTqtPEAjNRMBXvAUPuTqy4tL";

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

const quoteBody = {
  quote: {
    amountIn: "150000000",
    amountOut: "149767242",
    minAmountOut: "148269569",
    amountInUsd: "149.88",
    amountOutUsd: "149.73",
    timeEstimate: 77,
    deadline: "2026-10-26T12:17:37.545Z",
    depositAddress: DEPOSIT_ADDRESS,
  },
  signature: "ed25519:sig",
  correlationId: "c-1",
};

function swapStatus(status: string, details: Record<string, unknown> = {}) {
  return {
    correlationId: "c-1",
    status,
    updatedAt: "2026-10-26T12:20:00.000Z",
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [{ hash: "tron-tx", explorerUrl: "x" }],
      destinationChainTxHashes: [],
      ...details,
    },
  };
}

/** A 1Click whose quote always works and whose status is scripted. */
function oneClick(statuses: unknown[] = []) {
  const calls: string[] = [];
  let i = 0;
  const http = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("/quote")) return new Response(JSON.stringify(quoteBody), { status: 201 });
    const body = statuses[Math.min(i++, statuses.length - 1)] ?? swapStatus("PENDING_DEPOSIT");
    return new Response(JSON.stringify(body), { status: 200 });
    void init;
  });
  return { client: new OneClick({ fetch: http as unknown as typeof fetch }), calls, statusCalls: () => calls.filter((c) => c.includes("/status")).length };
}

/** Just enough Soroban for the mint. */
function fakeSoroban() {
  return {
    getAccount: async (a: string) => new Account(a, "7"),
    prepareTransaction: async (tx: Transaction) => tx,
    sendTransaction: async (tx: Transaction) => ({ status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), errorResult: {} }),
    getTransaction: async () => ({ status: "SUCCESS" }),
  } as never;
}

async function lane(over: Partial<TronLaneOptions> = {}): Promise<TronLaneOptions & { submit: ReturnType<typeof vi.fn> }> {
  const submit = vi.fn(async (_ix: Instruction) => "burn-signature-1");
  const owner = await generateKeyPairSigner();
  return {
    oneClick: oneClick([swapStatus("SUCCESS", { amountOut: "149767242", destinationChainTxHashes: [{ hash: "sol-tx", explorerUrl: "x" }] })]).client,
    iris: new Iris({
      network: "testnet",
      fetch: (async () => Response.json({ messages: [{ message: "0xdead", attestation: "0xbeef", status: "complete" }] })) as unknown as typeof fetch,
    }),
    network: "testnet",
    mint: { signer: localStellarSigner(Keypair.random().secret()), passphrase: Networks.TESTNET, server: fakeSoroban(), sleep: async () => {} },
    usdcMint: USDC_MINT,
    feePayer: await generateKeyPairSigner(),
    ownerFor: async () => owner,
    submit,
    pollMs: 1,
    timeoutMs: 50,
    sleep: async () => {},
    ...over,
  } as TronLaneOptions & { submit: ReturnType<typeof vi.fn> };
}

async function setup(tron?: TronLaneOptions) {
  const t = await testRamp({ tron });
  cleanup.push(t.close);
  const app = await t.ramp.createTenant({ name: "Blockroll", plan: "growth" });
  const caller = await t.ramp.authenticate(app.secretKey);
  return { ...t, app, caller, account: Keypair.random().publicKey() };
}

describe("the Tron deposit lane", () => {
  it("says so plainly when the deployment does not offer the lane", async () => {
    const s = await setup(); // no tron options
    const err = await s.ramp
      .createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RampError);
    // 501, not a 400: the caller's request was fine, this deployment is not.
    expect(err).toMatchObject({ code: "not_configured", status: 501 });
  });

  it("hands back a deposit address that pays out to the user's own Solana account", async () => {
    const s = await setup(await lane());
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    expect(d.depositAddress).toBe(DEPOSIT_ADDRESS);
    expect(d.solanaAddress).toBe(solanaAddressOfStellar(s.account));
    expect(d).toMatchObject({ status: "awaiting_deposit", tronAmount: 150_000_000n, expectedUsdc: 149_767_242n, refundTo: TRON });
    expect(d.id.startsWith("td_")).toBe(true);
  });

  it("returns without waiting on the solver, because that wait is minutes long", async () => {
    const o = oneClick();
    const s = await setup(await lane({ oneClick: o.client }));
    await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    // The quote was taken; the swap was not polled even once.
    expect(o.statusCalls()).toBe(0);
  });

  it("stamps a Deposit reference on the USD-USD corridor, not a fiat collection", async () => {
    const s = await setup(await lane());
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    const ref = decodeRef(d.reference);
    expect(ref.kind).toBe(RefKind.Deposit);
    expect(ref.corridor).toBe("USD-USD");
  });

  it("passes the solver network's own refusal through as a bad request", async () => {
    const s = await setup(await lane());
    const err = await s.ramp
      .createTronDeposit(s.caller, { account: s.account, amount: 40_000_000n, refundTo: TRON })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RampError);
    expect(err).toMatchObject({ code: "invalid_request" });
    expect(err.message).toContain("$100");
  });

  it("insists on a refund address, because an unfilled swap has to go somewhere", async () => {
    const s = await setup(await lane());
    await expect(
      s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: "" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("prices a dry quote without handing out a deposit address", async () => {
    const s = await setup(await lane());
    const rate = await s.ramp.quoteTron(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    expect(rate).toEqual({ expectedUsdc: 149_767_242n, minUsdc: 148_269_569n, timeEstimateSeconds: 77 });
  });

  it("runs swap, burn and mint on the ticker and completes the deposit", async () => {
    const l = await lane();
    const s = await setup(l);
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    expect(await s.ramp.advanceTronDeposits()).toBe(1);
    const after = await s.ramp.getTronDeposit(s.caller, d.id);
    expect(after.status).toBe("completed");
    // The burn was signed and submitted once, for the amount that arrived.
    expect(l.submit).toHaveBeenCalledOnce();
  });

  it("marks a refunded swap failed and never burns", async () => {
    const refunded = oneClick([swapStatus("REFUNDED", { refundedAmount: "148295028" })]);
    const l = await lane({ oneClick: refunded.client });
    const s = await setup(l);
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    await s.ramp.advanceTronDeposits();
    const after = await s.ramp.getTronDeposit(s.caller, d.id);
    expect(after.status).toBe("failed");
    expect(after.error).toContain(TRON);
    // Nothing was burned: the user's USDT is back on Tron.
    expect(l.submit).not.toHaveBeenCalled();
  });

  it("does nothing on the ticker when the lane is not configured", async () => {
    const s = await setup();
    await expect(s.ramp.advanceTronDeposits()).resolves.toBe(0);
  });

  it("keeps one tenant's deposits out of another's", async () => {
    const s = await setup(await lane());
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    const other = await s.ramp.createTenant({ name: "Someone else", plan: "growth" });
    const otherCaller = await s.ramp.authenticate(other.secretKey);
    await expect(s.ramp.getTronDeposit(otherCaller, d.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(s.ramp.listTronDeposits(otherCaller)).resolves.toEqual([]);
  });

  it("tells the tenant about the deposit without leaking the saga or the key", async () => {
    const s = await setup(await lane());
    const d = await s.ramp.createTronDeposit(s.caller, { account: s.account, amount: 150_000_000n, refundTo: TRON });
    const events = await s.ramp.events(s.caller, {});
    const created = events.find((e) => e.type === "tron_deposit.created");
    expect(created).toBeDefined();
    expect(JSON.stringify(created)).not.toContain(s.app.tenant.id);
    expect(Object.keys(created!.data as object)).not.toContain("sagaId");
    void d;
  });
});
