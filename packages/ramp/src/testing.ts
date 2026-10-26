import { Account, Asset as SdkAsset, FeeBumpTransaction, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { randomBytes } from "node:crypto";
import { STELLAR_ISSUERS, localStellarSigner, stellarClient, type PaymentSource, type StellarPaymentRecord } from "@corridor/chain-stellar";
import { openLocalDb, type Db } from "@corridor/ledger";
import { MockPartner, PartnerRegistry } from "@corridor/partners";
import { stellarRampChain } from "./chain.ts";
import { RampService } from "./service.ts";
import type { TronLaneOptions } from "./tron.ts";

/**
 * A complete Ramp on an in-memory database, a mock anchor and an offline
 * Stellar: transactions are really built, signed and checked, but "submit"
 * records them instead of sending. For tests and local development.
 */
export async function testRamp(
  opts: { now?: () => Date; fetch?: typeof fetch; failPayouts?: boolean; publicUrl?: string; db?: Db & { close(): Promise<void> }; tron?: TronLaneOptions } = {},
) {
  const db = opts.db ?? (await openLocalDb());
  const sponsorKeys = Keypair.random();
  const anchorAccount = Keypair.random().publicKey();
  const known = new Set<string>([sponsorKeys.publicKey()]);
  const sent: Array<Transaction | FeeBumpTransaction> = [];
  const ledger = fakeHorizon();
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
      const hash = Buffer.from(tx.hash()).toString("hex");
      ledger.record(hash, inner);
      return { hash, ledger: ledger.sequence, successful: true };
    },
  });
  let ramp: RampService | undefined;
  const mock = new MockPartner({
    webhookSecret: "whsec_mock",
    chains: ["STELLAR"],
    stellarAccount: anchorAccount,
    failPayouts: opts.failPayouts,
    // The anchor's delivery lands on the (fake) chain, where the reconciler sees it.
    sendUsdc: async (recipient, amount) => ledger.pay(anchorAccount, recipient, amount),
    deliver: async (body, headers) => {
      await ramp?.handlePartnerWebhook("mock", body, headers);
    },
  });
  ramp = await RampService.open({
    db,
    partners: new PartnerRegistry().register(mock),
    chain,
    payments: ledger.source,
    publicUrl: opts.publicUrl ?? "http://localhost:8787",
    fetch: opts.fetch ?? (async () => new Response("ok")),
    now: opts.now,
    tron: opts.tron,
  });
  return { ramp, db, mock, chain, sent, known, ledger, sponsorKeys, anchorAccount, close: () => db.close() };
}

/** A `signXdr` for a local keypair (tests, scripts). Production apps sign in the user's wallet. */
export function keypairSigner(keys: Keypair, passphrase: string = Networks.TESTNET) {
  return async (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, passphrase) as Transaction;
    tx.sign(keys);
    return tx.toXDR();
  };
}

/**
 * Just enough Horizon for the reconciler: every submitted transaction's
 * operations become payment records (memo and all), served per account
 * after a paging-token cursor.
 */
export function fakeHorizon() {
  const records: StellarPaymentRecord[] = [];
  let token = 0;
  const state = {
    sequence: 1,
    record(hash: string, tx: Transaction) {
      state.sequence++;
      const memo = horizonMemo(tx.memo);
      for (const op of tx.operations) {
        const base = {
          id: String(++token),
          paging_token: String(token),
          transaction_hash: hash,
          created_at: new Date().toISOString(),
          transaction_successful: true,
          transaction: { ...memo, ledger: state.sequence, source_account: tx.source, fee_charged: "100", successful: true },
        };
        if (op.type === "payment") {
          records.push({ ...base, type: "payment", ...horizonAsset(op.asset), from: op.source ?? tx.source, to: op.destination, amount: op.amount });
        } else if (op.type === "createAccount") {
          records.push({ ...base, type: "create_account", asset_type: "native", funder: op.source ?? tx.source, account: op.destination, starting_balance: op.startingBalance });
        }
      }
    },
    /** A payment some third party (an anchor) sends, outside Ramp. */
    async pay(from: string, to: string, amount: bigint, asset = "USDC"): Promise<string> {
      const issuer = STELLAR_ISSUERS[asset as "USDC"]!.testnet!;
      const tx = new TransactionBuilder(new Account(from, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
        .addOperation(Operation.payment({ destination: to, asset: new SdkAsset(asset, issuer), amount: (Number(amount) / 1e7).toFixed(7) }))
        .setTimeout(0)
        .build();
      const hash = randomBytes(32).toString("hex");
      state.record(hash, tx);
      return hash;
    },
    source: {
      async fetch(account, cursor, limit) {
        const after = cursor === undefined ? 0 : Number(cursor);
        return records
          .filter((r) => Number(r.paging_token) > after && [r.from, r.to, r.funder, r.account].includes(account))
          .slice(0, limit);
      },
    } satisfies PaymentSource,
  };
  return state;
}

function horizonMemo(memo: Memo): { memo?: string; memo_type: string } {
  if (memo.type === "none" || memo.value === null) return { memo_type: "none" };
  const value = memo.value as string | Buffer;
  if (memo.type === "hash" || memo.type === "return") return { memo: Buffer.from(value as Buffer).toString("base64"), memo_type: memo.type };
  return { memo: typeof value === "string" ? value : Buffer.from(value).toString(memo.type === "text" ? "utf8" : "ascii"), memo_type: memo.type };
}

function horizonAsset(a: SdkAsset): Pick<StellarPaymentRecord, "asset_type" | "asset_code" | "asset_issuer"> {
  if (a.isNative()) return { asset_type: "native" };
  return { asset_type: a.getAssetType(), asset_code: a.getCode(), asset_issuer: a.getIssuer() };
}
