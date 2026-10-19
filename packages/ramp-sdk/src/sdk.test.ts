import type { AddressInfo } from "node:net";
import { Keypair } from "@stellar/stellar-sdk";
import { rampServer } from "@corridor/ramp";
import { keypairSigner, testRamp } from "@corridor/ramp/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Ramp, RampApiError, agentTools, verifyWebhook } from "./index.ts";

let t: Awaited<ReturnType<typeof testRamp>>;
let server: ReturnType<typeof rampServer>;
let baseUrl: string;
const hooks: Array<{ body: string; headers: Record<string, string> }> = [];

beforeAll(async () => {
  t = await testRamp({
    fetch: async (_url, init) => {
      hooks.push({ body: init!.body as string, headers: init!.headers as Record<string, string> });
      return new Response("ok");
    },
  });
  server = rampServer(t.ramp, { selfServeSignup: true, adminToken: "op_test" });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await t.close();
});

const bank = { bankCode: "01", accountNumber: "0123456789" };

describe("Ramp SDK against the API", () => {
  it("signs up, onboards a user, pays out and reads usage", async () => {
    const { app, secretKey, webhookSecret } = await Ramp.signup({ name: "Jumpa", webhookUrl: "https://jumpa.example/hooks", baseUrl });
    expect(app.plan).toBe("sandbox");
    const user = Keypair.random();
    const ramp = new Ramp({ apiKey: secretKey, baseUrl, signXdr: keypairSigner(user) });
    expect((await ramp.me()).key.kind).toBe("secret");

    expect((await ramp.accounts.onboard(user.publicKey())).status).toBe("active");

    const sent = await ramp.withdrawals.send({ currency: "KES", amount: 50_000_000n, account: user.publicKey(), beneficiary: bank, idempotencyKey: "pay-1" });
    expect(sent.status).toBe("submitted");
    expect(sent.fee).toBe("0");
    expect(sent.transaction).toBeUndefined();

    await t.mock.observeFunding(sent.partnerOrderId, sent.txHash!);
    const done = await ramp.orders.wait(sent.id, { intervalMs: 10 });
    expect(done.status).toBe("completed");

    const usage = (await ramp.usage()) as { withdrawals: { volume: string; completed: number } };
    expect(usage.withdrawals).toMatchObject({ volume: "50000000", completed: 1 });
    expect((await ramp.orders.list()).map((o) => o.id)).toEqual([sent.id]);

    const hook = hooks.at(-1)!;
    expect(verifyWebhook(webhookSecret, hook.body, hook.headers)?.type).toBe("order.updated");
    expect(verifyWebhook("whsec_wrong", hook.body, hook.headers)).toBeNull();
  });

  it("replays an idempotent POST instead of opening a second order", async () => {
    const { secretKey } = await Ramp.signup({ name: "Linq", baseUrl });
    const ramp = new Ramp({ apiKey: secretKey, baseUrl });
    const user = Keypair.random();
    await ramp.accounts.onboard(user.publicKey(), keypairSigner(user));
    const q = await ramp.quotes.create({ kind: "withdrawal", currency: "KES", amount: "10000000" });
    const a = await ramp.withdrawals.create({ quoteId: q.id, account: user.publicKey(), beneficiary: bank }, { idempotencyKey: "k1" });
    const b = await ramp.withdrawals.create({ quoteId: q.id, account: user.publicKey(), beneficiary: bank }, { idempotencyKey: "k1" });
    expect(b.id).toBe(a.id);
    await expect(ramp.quotes.create({ kind: "withdrawal", currency: "KES", amount: "1" }, { idempotencyKey: "k1" })).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("collects with a hosted link", async () => {
    const { secretKey } = await Ramp.signup({ name: "Choppaddi", baseUrl });
    const ramp = new Ramp({ apiKey: secretKey, baseUrl });
    const merchant = Keypair.random().publicKey();
    const order = await ramp.deposits.collect({ currency: "NGN", fiatAmount: "1560000", account: merchant });
    expect(order.status).toBe("awaiting_payment");
    expect(order.collectionLink).toBe(`http://localhost:8787/pay/${order.id}`);
    const page = await fetch(`${baseUrl}/pay/${order.id}`);
    expect(await page.text()).toContain("Pay Choppaddi");
    await t.mock.payerTransferred(order.partnerOrderId);
    expect((await ramp.deposits.get(order.id)).status).toBe("completed");
  });

  it("gives agents tools that respect the key's spending policy", async () => {
    const { secretKey } = await Ramp.signup({ name: "Rail402", baseUrl });
    const owner = new Ramp({ apiKey: secretKey, baseUrl });
    const user = Keypair.random();
    await owner.accounts.onboard(user.publicKey(), keypairSigner(user));
    const { key } = await owner.keys.create({ kind: "agent", label: "bot", policy: { maxPerPayout: 20_000_000n } });
    const tools = agentTools(new Ramp({ apiKey: key, baseUrl }), keypairSigner(user));
    const send = tools.find((x) => x.name === "ramp_send_payout")!;
    const refused = await send.handler({ currency: "KES", amount: "30000000", account: user.publicKey(), ...bank, idempotencyKey: "a1" });
    expect(refused).toMatchObject({ ok: false, error: { code: "spending_limit", details: { limit: "maxPerPayout" } } });
    const paid = await send.handler({ currency: "KES", amount: "20000000", account: user.publicKey(), ...bank, idempotencyKey: "a2" });
    expect(paid).toMatchObject({ ok: true, result: { status: "submitted" } });
  });

  it("returns stable error codes", async () => {
    const bad = new Ramp({ apiKey: "rk_test_bad", baseUrl });
    await expect(bad.me()).rejects.toBeInstanceOf(RampApiError);
    await expect(bad.me()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
    const { secretKey } = await Ramp.signup({ name: "Yolat", baseUrl });
    const ramp = new Ramp({ apiKey: secretKey, baseUrl });
    await expect(ramp.quotes.create({ kind: "withdrawal", currency: "ZZZ", amount: "1" })).rejects.toMatchObject({ code: "invalid_request" });
    const paid = await fetch(`${baseUrl}/v1/tenants`, { method: "POST", body: JSON.stringify({ name: "x", plan: "growth" }) });
    expect(paid.status).toBe(401);
    const op = await fetch(`${baseUrl}/v1/tenants`, {
      method: "POST",
      headers: { authorization: "Bearer op_test" },
      body: JSON.stringify({ name: "Blink", plan: "growth" }),
    });
    expect(op.status).toBe(201);
  });
});
