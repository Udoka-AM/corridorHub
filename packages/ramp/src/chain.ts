import {
  Account,
  FeeBumpTransaction,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
  type Asset as SdkAsset,
} from "@stellar/stellar-sdk";
import { money, toStellarMemo, type Asset } from "@corridor/core";
import { NATIVE, stellarAsset, toStellarAmount, type StellarClient, type StellarMemo, type StellarNetwork } from "@corridor/chain-stellar";
import { RampError } from "./errors.ts";

/**
 * Ramp's side of the chain. Ramp never holds an end user's key: it builds
 * the transaction, the user's embedded wallet signs it, and Ramp submits it.
 *
 * The only key Ramp holds is the sponsor's. It pays network fees (by
 * wrapping the user's transaction in a fee bump) and the base reserves of
 * accounts and trustlines (CAP-33 sponsorship), so a user can hold USDC
 * without ever buying XLM. It holds XLM for that and nothing else.
 */
export interface FundingPayment {
  to: string;
  asset: Asset;
  amount: bigint;
}

export interface BuiltTx {
  xdr: string;
  /** Hex hash of the transaction body. Signatures do not change it. */
  hash: string;
}

export interface SubmitResult {
  hash: string;
  ledger?: number;
}

export interface RampChain {
  readonly network: StellarNetwork;
  /** Address whose XLM sponsors reserves and fees. */
  readonly sponsor: string;
  buildFunding(args: { source: string; payments: FundingPayment[]; memo: StellarMemo; timeoutSeconds: number }): Promise<BuiltTx>;
  /** Create (or top up) a sponsored account with trustlines for `assets`. Returned signed by the sponsor. */
  buildSponsoredAccount(args: { account: string; assets: Asset[]; timeoutSeconds: number }): Promise<BuiltTx>;
  /** Submit a user-signed transaction, refusing anything but the exact transaction Ramp built. */
  submit(signedXdr: string, expectedHash: string): Promise<SubmitResult>;
}

export interface StellarRampChainOptions {
  /** The sponsor account, with a signer. Holds XLM only. */
  sponsor: StellarClient;
  /** Override account loading (tests build offline). Must throw for an account that does not exist. */
  loadAccount?: (address: string) => Promise<Account>;
  /** Override submission (tests). */
  send?: (tx: Transaction | FeeBumpTransaction) => Promise<{ hash: string; ledger?: number; successful?: boolean }>;
  /** Stroops per operation. */
  fee?: string;
}

function memoOf(memo: StellarMemo): Memo {
  switch (memo.type) {
    case "hash":
      return Memo.hash(Buffer.from(toStellarMemo(memo.value)));
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
  }
}

export function stellarRampChain(opts: StellarRampChainOptions): RampChain {
  const client = opts.sponsor;
  const signer = client.signer;
  if (!signer) throw new Error("the Ramp sponsor client needs a signer");
  const passphrase = client.passphrase;
  const load = opts.loadAccount ?? (async (address: string) => {
    const a = await client.server.loadAccount(address);
    return new Account(a.accountId(), a.sequenceNumber());
  });
  const send =
    opts.send ??
    (async (tx: Transaction | FeeBumpTransaction) => {
      const r = await client.server.submitTransaction(tx);
      return { hash: r.hash, ledger: r.ledger, successful: r.successful };
    });
  const fee = async () => opts.fee ?? (await client.fee());

  async function sponsorSign(tx: Transaction | FeeBumpTransaction): Promise<void> {
    tx.addSignature(signer!.address, Buffer.from(await signer!.sign(tx.hash())).toString("base64"));
  }

  async function exists(address: string): Promise<boolean> {
    try {
      await load(address);
      return true;
    } catch {
      return false;
    }
  }

  return {
    network: client.network,
    sponsor: signer.address,

    async buildFunding({ source, payments, memo, timeoutSeconds }) {
      if (!payments.length) throw new RampError("invalid_request", "nothing to pay");
      let account: Account;
      try {
        account = await load(source);
      } catch {
        throw new RampError("invalid_request", `account ${source} does not exist on ${client.network}; create it with POST /v1/accounts first`);
      }
      const b = new TransactionBuilder(account, { fee: await fee(), networkPassphrase: passphrase, memo: memoOf(memo) });
      for (const p of payments) {
        b.addOperation(
          Operation.payment({ destination: p.to, asset: stellarAsset(p.asset, client.network), amount: toStellarAmount(money(p.asset, p.amount)) }),
        );
      }
      const tx = b.setTimeout(timeoutSeconds).build();
      return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
    },

    async buildSponsoredAccount({ account, assets, timeoutSeconds }) {
      const sponsorAccount = await load(signer.address);
      const isNew = !(await exists(account));
      const b = new TransactionBuilder(sponsorAccount, { fee: await fee(), networkPassphrase: passphrase }).addOperation(
        Operation.beginSponsoringFutureReserves({ sponsoredId: account }),
      );
      if (isNew) b.addOperation(Operation.createAccount({ destination: account, startingBalance: "0" }));
      for (const asset of assets) {
        if (asset === NATIVE) continue;
        b.addOperation(Operation.changeTrust({ asset: stellarAsset(asset, client.network) as SdkAsset, source: account }));
      }
      b.addOperation(Operation.endSponsoringFutureReserves({ source: account }));
      const tx = b.setTimeout(timeoutSeconds).build();
      await sponsorSign(tx);
      return { xdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
    },

    async submit(signedXdr, expectedHash) {
      let parsed: Transaction | FeeBumpTransaction;
      try {
        parsed = TransactionBuilder.fromXDR(signedXdr, passphrase);
      } catch {
        throw new RampError("invalid_request", "signed transaction is not valid XDR for this network");
      }
      if (parsed instanceof FeeBumpTransaction) throw new RampError("transaction_mismatch", "submit the inner transaction; Ramp adds the fee bump");
      if (Buffer.from(parsed.hash()).toString("hex") !== expectedHash) {
        throw new RampError("transaction_mismatch", "signed transaction differs from the one Ramp built", { expectedHash });
      }
      if (!parsed.signatures.length) throw new RampError("invalid_request", "transaction carries no signatures");
      let outer: Transaction | FeeBumpTransaction = parsed;
      if (parsed.source !== signer.address) {
        const bump = TransactionBuilder.buildFeeBumpTransaction(signer.address, await fee(), parsed, passphrase);
        await sponsorSign(bump);
        outer = bump;
      }
      try {
        const r = await send(outer);
        if (r.successful === false) throw new Error(`transaction ${r.hash} was not successful`);
        return { hash: r.hash, ...(r.ledger !== undefined ? { ledger: r.ledger } : {}) };
      } catch (e) {
        const codes = (e as { response?: { data?: { extras?: { result_codes?: unknown } } } }).response?.data?.extras?.result_codes;
        throw new RampError("chain_error", `Stellar rejected the transaction: ${(e as Error).message}`, codes ? { resultCodes: codes } : undefined);
      }
    },
  };
}
