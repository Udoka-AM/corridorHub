import { FeeBumpTransaction, Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { decodeRef } from "@corridor/core";
import { signWebhook, verifyWebhookSignature } from "@corridor/partners";
import { afterEach, describe, expect, it } from "vitest";
import { RampError } from "./errors.ts";
import { PLANS, formatRate, rampFee, scaleRate, toFiat, toSettlement } from "./fees.ts";
import { keypairSigner, testRamp } from "./testing.ts";

const USDC = (n: number) => BigInt(n) * 10_000_000n;
const bank = { bankCode: "01", accountNumber: "0123456789" };
let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup) await c();
  cleanup = [];
});

async function setup(opts: Parameters<typeof testRamp>[0] = {}) {
  const t = await testRamp(opts);
  cleanup.push(t.close);
  const app = await t.ramp.createTenant({ name: "Blockroll", plan: "growth", webhookUrl: "https://app.example/hooks" });
  const caller = await t.ramp.authenticate(app.secretKey);
  const user = Keypair.random();
  const sign = keypairSigner(user);
  return { ...t, app, caller, user, sign };
}

async function onboard(s: Awaited<ReturnType<typeof setup>>) {
  const pending = await s.ramp.createAccount(s.caller, { address: s.user.publicKey() });
  return s.ramp.submitAccount(s.caller, { address: s.user.publicKey(), signedXdr: await s.sign(pending.xdr), hash: pending.hash });
}

describe("fees", () => {
  it("prices in integer minor units", () => {
    expect(scaleRate("128.9")).toBe(1_289_000_000n);
    expect(formatRate(scaleRate("1530.25"))).toBe("1530.25");
    expect(toFiat(USDC(10), scaleRate("128.9"), "KES")).toBe(128_900n);
    expect(toSettlement(128_900n, scaleRate("128.9"), "KES")).toBe(USDC(10));
    expect(rampFee(PLANS.growth, USDC(100), "withdrawal")).toBe(3_500_000n);
    expect(rampFee(PLANS.agent, USDC(100), "withdrawal")).toBe(5_000_000n + 500_000n);
    expect(rampFee(PLANS.sandbox, USDC(100), "withdrawal")).toBe(0n);
    expect(() => scaleRate("1e-7")).toThrow(RampError);
  });
});

describe("Ramp", () => {
  it("authenticates by API key and refuses unknown keys", async () => {
    const s = await setup();
    expect(s.caller.tenant.name).toBe("Blockroll");
    expect(s.app.secretKey).toMatch(/^rk_test_/);
    await expect(s.ramp.authenticate("rk_test_nope")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("onboards a user with sponsored reserves and a USDC trustline", async () => {
    const s = await setup();
    const pending = await s.ramp.createAccount(s.caller, { address: s.user.publicKey() });
    const tx = TransactionBuilder.fromXDR(pending.xdr, Networks.TESTNET) as Transaction;
    expect(tx.source).toBe(s.sponsorKeys.publicKey());
    expect(tx.operations.map((o) => o.type)).toEqual(["beginSponsoringFutureReserves", "createAccount", "changeTrust", "endSponsoringFutureReserves"]);
    expect(tx.signatures).toHaveLength(1);
    const done = await s.ramp.submitAccount(s.caller, { address: s.user.publicKey(), signedXdr: await s.sign(pending.xdr), hash: pending.hash });
    expect(done.status).toBe("active");
    expect((s.sent[0] as Transaction).signatures).toHaveLength(2);
  });

  it("runs a withdrawal: quote, anchor order, user-signed funding, fee-bumped submit, completion", async () => {
    const hits: Array<{ body: string; headers: Record<string, string> }> = [];
    const s = await setup({
      fetch: async (_url, init) => {
        hits.push({ body: init!.body as string, headers: init!.headers as Record<string, string> });
        return new Response("ok");
      },
    });
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(10) });
    expect(q.fiatAmount).toBe(128_900n);
    expect(q.fee).toBe(350_000n);
    expect(q.total).toBe(USDC(10) + 350_000n);

    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    expect(order.status).toBe("awaiting_signature");
    expect(decodeRef(order.reference).kind).toBe(0x01);
    const funding = TransactionBuilder.fromXDR(order.unsignedXdr!, Networks.TESTNET) as Transaction;
    expect(funding.source).toBe(s.user.publicKey());
    expect(funding.memo.type).toBe("text");
    expect(funding.operations).toMatchObject([
      { type: "payment", destination: s.anchorAccount, amount: "10.0000000" },
      { type: "payment", destination: s.sponsorKeys.publicKey(), amount: "0.0350000" },
    ]);

    const submitted = await s.ramp.submitWithdrawal(s.caller, order.id, await s.sign(order.unsignedXdr!));
    expect(submitted.status).toBe("submitted");
    const outer = s.sent.at(-1)!;
    expect(outer).toBeInstanceOf(FeeBumpTransaction);
    expect((outer as FeeBumpTransaction).feeSource).toBe(s.sponsorKeys.publicKey());

    await s.mock.observeFunding(order.partnerOrderId, submitted.txHash!);
    // The anchor says it paid, but nothing settles on its word alone.
    expect((await s.ramp.getOrder(s.caller, order.id)).status).toBe("submitted");
    expect((await s.ramp.usage(s.caller)).feesBookedAllTime).toBe(0n);
    expect(await s.ramp.reconcile()).toBe(1);
    const done = await s.ramp.getOrder(s.caller, order.id);
    expect(done.status).toBe("completed");
    expect(done.chain).toMatchObject({ txHash: submitted.txHash, amount: USDC(10).toString() });
    expect(done.chain!.feeRef!.startsWith(`${submitted.txHash}:`)).toBe(true);

    const usage = await s.ramp.usage(s.caller);
    expect(usage.withdrawals.volume).toBe(USDC(10));
    expect(usage.feesBookedAllTime).toBe(350_000n);
    expect(await s.ramp.ledger.checkInvariants()).toEqual([]);

    const types = hits.map((h) => JSON.parse(h.body).type);
    expect(types[0]).toBe("account.active");
    expect(types).toContain("order.created");
    const last = hits.at(-1)!;
    expect(JSON.parse(last.body).data.status).toBe("completed");
    expect(verifyWebhookSignature(s.app.webhookSecret, last.body, last.headers["x-ramp-timestamp"], last.headers["x-ramp-signature"])).toBe(true);
  });

  it("refuses a signed transaction that differs from the one it built", async () => {
    const s = await setup();
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(5) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    const q2 = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(500) });
    const other = await s.ramp.createWithdrawal(s.caller, { quoteId: q2.id, account: s.user.publicKey(), beneficiary: bank });
    await expect(s.ramp.submitWithdrawal(s.caller, order.id, await s.sign(other.unsignedXdr!))).rejects.toMatchObject({ code: "transaction_mismatch" });
  });

  it("uses a quote once and only before it expires", async () => {
    let clock = new Date("2026-10-20T10:00:00Z");
    const s = await setup({ now: () => clock });
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    await expect(s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "quote_used",
    });
    const late = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    clock = new Date(clock.getTime() + 10 * 60_000);
    await expect(s.ramp.createWithdrawal(s.caller, { quoteId: late.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "quote_expired",
    });
  });

  it("releases the quote when opening the order fails", async () => {
    const s = await setup();
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    // The user has not been onboarded, so the funding transaction cannot be built.
    await expect(s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await onboard(s);
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    expect(order.status).toBe("awaiting_signature");
  });

  it("holds agent keys to their spending policy with actionable refusals", async () => {
    const s = await setup();
    await onboard(s);
    const agent = await s.ramp.createKey(s.caller, { kind: "agent", label: "payout-bot", policy: { maxPerPayout: USDC(20), dailyLimit: USDC(30), currencies: ["KES"] } });
    const bot = await s.ramp.authenticate(agent.key);
    expect(bot.key.kind).toBe("agent");

    const big = await s.ramp.quote(bot, { kind: "withdrawal", currency: "KES", amount: USDC(25) });
    await expect(s.ramp.createWithdrawal(bot, { quoteId: big.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "spending_limit",
      details: { limit: "maxPerPayout", max: USDC(20).toString() },
    });
    const ok = await s.ramp.quote(bot, { kind: "withdrawal", currency: "KES", amount: USDC(20) });
    await s.ramp.createWithdrawal(bot, { quoteId: ok.id, account: s.user.publicKey(), beneficiary: bank });
    const over = await s.ramp.quote(bot, { kind: "withdrawal", currency: "KES", amount: USDC(15) });
    await expect(s.ramp.createWithdrawal(bot, { quoteId: over.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "spending_limit",
      details: { limit: "dailyLimit", remaining: USDC(10).toString() },
    });
    const ngn = await s.ramp.quote(bot, { kind: "withdrawal", currency: "NGN", amount: USDC(1) });
    await expect(s.ramp.createWithdrawal(bot, { quoteId: ngn.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "spending_limit",
      details: { limit: "currencies" },
    });
    await expect(s.ramp.createKey(bot, { kind: "agent" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps each app's orders to itself", async () => {
    const s = await setup();
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    const other = await s.ramp.authenticate((await s.ramp.createTenant({ name: "Paycashless" })).secretKey);
    await expect(s.ramp.getOrder(other, order.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(s.ramp.createWithdrawal(other, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank })).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await s.ramp.listOrders(other)).toEqual([]);
  });

  it("runs a deposit to completion and accrues its fee against the app", async () => {
    const s = await setup();
    const q = await s.ramp.quote(s.caller, { kind: "deposit", currency: "NGN", amount: 1_560_000n });
    expect(q.amount).toBe(USDC(10));
    expect(q.total).toBe(USDC(10) - 350_000n);
    const order = await s.ramp.createDeposit(s.caller, { quoteId: q.id, account: s.user.publicKey() });
    expect(order.status).toBe("awaiting_payment");
    expect(order.virtualAccount?.accountNumber).toBeTruthy();
    expect(s.ramp.collectionLink(order)).toBe(`http://localhost:8787/pay/${order.id}`);
    expect((await s.ramp.collectionPage(order.id)).merchant).toBe("Blockroll");

    await s.mock.payerTransferred(order.partnerOrderId);
    expect((await s.ramp.getOrder(s.caller, order.id)).status).toBe("processing");
    await s.ramp.reconcile();
    const done = await s.ramp.getOrder(s.caller, order.id);
    expect(done.status).toBe("completed");
    expect(done.chain?.txHash).toBe(done.deliveryTx);
    expect((await s.ramp.usage(s.caller)).deposits.volume).toBe(USDC(10));
    expect((await s.ramp.usage(s.caller)).feesBookedAllTime).toBe(350_000n);
  });

  it("reports a failed payout and names supported currencies when none fits", async () => {
    const s = await setup({ failPayouts: true });
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "GHS", amount: USDC(2) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    const sub = await s.ramp.submitWithdrawal(s.caller, order.id, await s.sign(order.unsignedXdr!));
    await s.mock.observeFunding(order.partnerOrderId, sub.txHash!);
    await s.ramp.reconcile();
    expect((await s.ramp.getOrder(s.caller, order.id)).status).toBe("failed");
    await expect(s.ramp.quote(s.caller, { kind: "withdrawal", currency: "XOF", amount: USDC(1) })).rejects.toMatchObject({ code: "unsupported" });
  });

  it("keeps the free sandbox on testnet and retries undelivered webhooks", async () => {
    let up = false;
    let clock = new Date("2026-10-20T10:00:00Z");
    const s = await setup({ now: () => clock, fetch: async () => new Response("", { status: up ? 200 : 500 }) });
    await onboard(s);
    expect((await s.ramp.events(s.caller)).map((e) => e.type)).toEqual(["account.active"]);
    up = true;
    // The first retry waits out its backoff (30s).
    expect(await s.ramp.deliverPending()).toBe(0);
    clock = new Date(clock.getTime() + 30_000);
    expect(await s.ramp.deliverPending()).toBe(1);
    expect(await s.ramp.deliverPending()).toBe(0);
  });

  it("never settles a withdrawal whose funding the chain does not show", async () => {
    const s = await setup();
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(3) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    // A forged "completed" from the anchor, with no transaction behind it.
    await s.mock.observeFunding(order.partnerOrderId, "0".repeat(64));
    await s.ramp.reconcile();
    const still = await s.ramp.getOrder(s.caller, order.id);
    expect(still.status).toBe("awaiting_signature");
    expect(still.chain).toBeUndefined();
  });

  it("keeps chain evidence when the anchor's update lands from a copy read before reconcile", async () => {
    const s = await setup();
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(4) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    const submitted = await s.ramp.submitWithdrawal(s.caller, order.id, await s.sign(order.unsignedXdr!));
    const stale = (await s.ramp.store.order(s.caller.tenant.id, order.id))!;
    expect(stale.chain).toBeUndefined();
    await s.ramp.reconcile();
    // A webhook handler that loaded the order before reconcile writes the anchor's state.
    await s.ramp.store.patchOrder(stale.tenantId, stale.id, { partnerState: "completed", partnerStatus: "COMPLETED" });
    await s.mock.observeFunding(order.partnerOrderId, submitted.txHash!);
    const done = await s.ramp.getOrder(s.caller, order.id);
    expect(done.chain?.txHash).toBe(submitted.txHash);
    expect(done.status).toBe("completed");
  });

  it("does not let one payment settle two orders", async () => {
    const s = await setup();
    await onboard(s);
    const q1 = await s.ramp.quote(s.caller, { kind: "deposit", currency: "NGN", amount: 1_560_000n });
    const q2 = await s.ramp.quote(s.caller, { kind: "deposit", currency: "NGN", amount: 1_560_000n });
    const a = await s.ramp.createDeposit(s.caller, { quoteId: q1.id, account: s.user.publicKey() });
    const b = await s.ramp.createDeposit(s.caller, { quoteId: q2.id, account: s.user.publicKey() });
    await s.mock.payerTransferred(a.partnerOrderId);
    const delivered = (await s.ramp.getOrder(s.caller, a.id)).deliveryTx!;
    // The second anchor order claims the same delivery transaction.
    const forged = { ...(await s.mock.getOrder(b.partnerOrderId)), status: "completed", partnerStatus: "COMPLETED", txSignature: delivered };
    const body = JSON.stringify(forged, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    const ts = Math.floor(Date.now() / 1000);
    await s.ramp.handlePartnerWebhook("mock", body, { "x-paj-timestamp": String(ts), "x-paj-signature": signWebhook("whsec_mock", ts, body) });
    await s.ramp.reconcile();
    expect((await s.ramp.getOrder(s.caller, a.id)).status).toBe("completed");
    expect((await s.ramp.getOrder(s.caller, b.id)).status).not.toBe("completed");
  });

  it("lets an unsigned withdrawal lapse and compensates its saga", async () => {
    let clock = new Date("2026-10-20T10:00:00Z");
    const s = await setup({ now: () => clock });
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    const order = await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    clock = new Date(clock.getTime() + 10 * 60_000);
    await s.ramp.reconcile();
    expect((await s.ramp.getOrder(s.caller, order.id)).status).toBe("failed");
    await expect(s.ramp.submitWithdrawal(s.caller, order.id, await s.sign(order.unsignedXdr!))).rejects.toMatchObject({ code: "conflict" });
  });

  it("expires keys and rotates them with a grace period", async () => {
    let clock = new Date("2026-10-20T10:00:00Z");
    const s = await setup({ now: () => clock });
    const short = await s.ramp.createKey(s.caller, { kind: "agent", expiresInSeconds: 60 });
    await expect(s.ramp.authenticate(short.key)).resolves.toBeTruthy();
    const rotated = await s.ramp.rotateKey(s.caller, short.id, { graceSeconds: 30 });
    expect(rotated.kind).toBe("agent");
    expect(rotated.previous.expiresAt).toEqual(new Date(clock.getTime() + 30_000));
    clock = new Date(clock.getTime() + 31_000);
    await expect(s.ramp.authenticate(short.key)).rejects.toMatchObject({ code: "unauthorized", message: "API key expired" });
    await expect(s.ramp.authenticate(rotated.key)).resolves.toBeTruthy();
    await expect(s.ramp.createKey(s.caller, { expiresInSeconds: -1 })).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("backs off failed webhooks and dead-letters them after the last attempt", async () => {
    let clock = new Date("2026-10-20T10:00:00Z");
    let calls = 0;
    let up = false;
    const s = await setup({
      now: () => clock,
      fetch: async () => {
        calls++;
        return new Response("", { status: up ? 200 : 503 });
      },
    });
    await onboard(s);
    const q = await s.ramp.quote(s.caller, { kind: "withdrawal", currency: "KES", amount: USDC(1) });
    await s.ramp.createWithdrawal(s.caller, { quoteId: q.id, account: s.user.publicKey(), beneficiary: bank });
    const first = calls;
    expect(first).toBeGreaterThan(0);
    // Inside the backoff window nothing is retried.
    await s.ramp.deliverPending();
    expect(calls).toBe(first);
    for (let i = 0; i < 12; i++) {
      clock = new Date(clock.getTime() + 7 * 3_600_000);
      await s.ramp.deliverPending();
    }
    const dead = await s.ramp.deadLetters(s.caller);
    expect(dead.length).toBeGreaterThan(0);
    expect(dead[0]!.attempts).toBe(10);
    expect(dead[0]!.lastError).toBe("HTTP 503");
    const settled = calls;
    clock = new Date(clock.getTime() + 7 * 3_600_000);
    await s.ramp.deliverPending();
    expect(calls).toBe(settled);
    up = true;
    await s.ramp.redeliver(s.caller, dead[0]!.event.id);
    expect((await s.ramp.deadLetters(s.caller)).map((d) => d.event.id)).not.toContain(dead[0]!.event.id);
  });
});
