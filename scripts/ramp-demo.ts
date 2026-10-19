/**
 * Ramp end to end on Stellar testnet, through the SDK:
 * sign up an app, onboard an end user with sponsored reserves, pay out to a
 * bank account, and read usage. The user's key never reaches Ramp: the SDK's
 * signXdr hook signs locally.
 *
 *   pnpm ramp:demo
 *
 * Testnet has no USDC faucet, so this settles in XLM unless RAMP_ASSET=USDC
 * and the user is funded with testnet USDC. The anchor is the mock unless
 * CORRIDOR_ANCHOR_BASE_URL names a SEP server.
 */
import type { AddressInfo } from "node:net";
import { Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { explorerTx } from "@corridor/chain-stellar";
import { rampServer } from "@corridor/ramp";
import { keypairSigner } from "@corridor/ramp/testing";
import { Ramp } from "@corridor/ramp-sdk";
import { NETWORK } from "./runtime.ts";
import { RAMP_ASSET, openRamp } from "./ramp-env.ts";

if (NETWORK !== "testnet") throw new Error("ramp:demo runs on testnet only");

const { ramp: service, sponsor, mock } = await openRamp({ publicUrl: "http://localhost" });
const server = rampServer(service, { selfServeSignup: true });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

try {
  const { app, secretKey } = await Ramp.signup({ name: "Ramp demo app", baseUrl });
  console.log(`1. app ${app.id} on the ${app.plan} plan`);

  const user = Keypair.random();
  const ramp = new Ramp({ apiKey: secretKey, baseUrl, signXdr: keypairSigner(user) });
  const onboarded = await ramp.accounts.onboard(user.publicKey());
  console.log(`2. user ${user.publicKey()} onboarded, reserves sponsored: ${explorerTx(NETWORK, onboarded.txHash)}`);

  if (RAMP_ASSET === "XLM") {
    // Testnet stand-in for the user's own deposit: give them something to pay out.
    const account = await sponsor.server.loadAccount(sponsor.address);
    const tx = new TransactionBuilder(account, { fee: await sponsor.fee(), networkPassphrase: sponsor.passphrase })
      .addOperation(Operation.payment({ destination: user.publicKey(), asset: Asset.native(), amount: "10" }))
      .setTimeout(180)
      .build();
    tx.addSignature(sponsor.address, Buffer.from(await sponsor.signer!.sign(tx.hash())).toString("base64"));
    await sponsor.server.submitTransaction(tx);
    console.log("   funded the user with 10 XLM (testnet only)");
  }

  const order = await ramp.withdrawals.send({
    currency: process.env.CORRIDOR_PAYOUT_CURRENCY ?? "KES",
    amount: 50_000_000n,
    account: user.publicKey(),
    beneficiary: { bankCode: "01", accountNumber: "0123456789" },
    idempotencyKey: `demo-${Date.now()}`,
  });
  console.log(`3. payout ${order.id}: ${order.status}, ${order.fiatAmount} ${order.currency} minor units, reference ${order.reference}`);
  console.log(`   funding tx (user-signed, fee sponsored): ${explorerTx(NETWORK, order.txHash!)}`);

  if (mock) await mock.observeFunding(order.partnerOrderId, order.txHash!);
  const done = await ramp.orders.wait(order.id, { intervalMs: 2_000, timeoutMs: 5 * 60_000 });
  console.log(`4. payout ${done.status}`);
  console.log("5. usage", JSON.stringify(await ramp.usage(), null, 2));
} finally {
  server.close();
}
