import { describe, expect, it } from "vitest";
import { openPostgresDb } from "@corridor/ledger";
import { keypairSigner, testRamp } from "./testing.ts";
import { Keypair } from "@stellar/stellar-sdk";

/** The full withdrawal against a real Postgres server. Runs when TEST_DATABASE_URL is set (CI provides one). */
describe.skipIf(!process.env.TEST_DATABASE_URL)("Ramp on Postgres", () => {
  it("runs a withdrawal end to end and settles it from the chain", async () => {
    const db = await openPostgresDb(process.env.TEST_DATABASE_URL!);
    await db.exec("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    const t = await testRamp({ db });
    try {
      const app = await t.ramp.createTenant({ name: "pg", plan: "growth" });
      const caller = await t.ramp.authenticate(app.secretKey);
      const user = Keypair.random();
      const sign = keypairSigner(user);
      const p = await t.ramp.createAccount(caller, { address: user.publicKey() });
      await t.ramp.submitAccount(caller, { address: user.publicKey(), signedXdr: await sign(p.xdr), hash: p.hash });
      const q = await t.ramp.quote(caller, { kind: "withdrawal", currency: "KES", amount: 20_000_000n });
      const o = await t.ramp.createWithdrawal(caller, { quoteId: q.id, account: user.publicKey(), beneficiary: { bankCode: "01", accountNumber: "1" } });
      const sent = await t.ramp.submitWithdrawal(caller, o.id, await sign(o.unsignedXdr!));
      await t.mock.observeFunding(o.partnerOrderId, sent.txHash!);
      await t.ramp.reconcile();
      const done = await t.ramp.getOrder(caller, o.id);
      expect(done.status).toBe("completed");
      expect((await t.ramp.usage(caller)).feesBookedAllTime).toBe(o.fee);
    } finally {
      await db.close();
    }
  });
});
