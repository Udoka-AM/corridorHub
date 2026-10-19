import { Account, FeeBumpTransaction, Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { localStellarSigner, stellarClient } from "@corridor/chain-stellar";
import { openLocalDb } from "@corridor/ledger";
import { MockPartner, PartnerRegistry } from "@corridor/partners";
import { stellarRampChain } from "./chain.ts";
import { RampService } from "./service.ts";

/**
 * A complete Ramp on an in-memory database, a mock anchor and an offline
 * Stellar: transactions are really built, signed and checked, but "submit"
 * records them instead of sending. For tests and local development.
 */
export async function testRamp(opts: { now?: () => Date; fetch?: typeof fetch; failPayouts?: boolean; publicUrl?: string } = {}) {
  const db = await openLocalDb();
  const sponsorKeys = Keypair.random();
  const anchorAccount = Keypair.random().publicKey();
  const known = new Set<string>([sponsorKeys.publicKey()]);
  const sent: Array<Transaction | FeeBumpTransaction> = [];
  const chain = stellarRampChain({
    sponsor: stellarClient({ network: "testnet", signer: localStellarSigner(sponsorKeys.secret()), fee: "100" }),
    fee: "100",
    loadAccount: async (address) => {
      if (!known.has(address)) throw new Error(`account ${address} not found`);
      return new Account(address, "1000");
    },
    send: async (tx) => {
      sent.push(tx);
      const inner = tx instanceof FeeBumpTransaction ? tx.innerTransaction : tx;
      for (const op of inner.operations) if (op.type === "createAccount") known.add(op.destination);
      return { hash: Buffer.from(tx.hash()).toString("hex"), ledger: 1, successful: true };
    },
  });
  let ramp: RampService | undefined;
  const mock = new MockPartner({
    webhookSecret: "whsec_mock",
    chains: ["STELLAR"],
    stellarAccount: anchorAccount,
    failPayouts: opts.failPayouts,
    deliver: async (body, headers) => {
      await ramp?.handlePartnerWebhook("mock", body, headers);
    },
  });
  ramp = await RampService.open({
    db,
    partners: new PartnerRegistry().register(mock),
    chain,
    publicUrl: opts.publicUrl ?? "http://localhost:8787",
    fetch: opts.fetch ?? (async () => new Response("ok")),
    now: opts.now,
  });
  return { ramp, db, mock, chain, sent, known, sponsorKeys, anchorAccount, close: () => db.close() };
}

/** A `signXdr` for a local keypair (tests, scripts). Production apps sign in the user's wallet. */
export function keypairSigner(keys: Keypair, passphrase: string = Networks.TESTNET) {
  return async (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
    tx.sign(keys);
    return tx.toXDR();
  };
}
