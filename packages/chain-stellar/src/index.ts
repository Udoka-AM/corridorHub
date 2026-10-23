import { Asset as SdkAsset, BASE_FEE, Horizon, Keypair, Memo, Networks, Operation, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";
import { fromStellarMemo, money, toStellarMemo, tryDecodeRef, type Asset, type Hex, type Observation } from "@corridor/core";
import { NATIVE, assetOf, fromStellarAmount, issuerOf, stellarAsset, toStellarAmount, type StellarNetwork } from "./assets.ts";
import { StellarObserver, ledgerOf, normalizeRecord, type PaymentSource, type StellarPaymentRecord } from "./observer.ts";

export { NATIVE, STELLAR_DECIMALS, STELLAR_ISSUERS, assetOf, fromStellarAmount, issuerOf, stellarAsset, toStellarAmount, type StellarNetwork } from "./assets.ts";
export {
  StellarEventObserver,
  TRANSFER_TOPICS,
  type ContractEvent,
  type EventCursorStore,
  type EventPage,
  type EventSource,
} from "./events.ts";
export { StellarObserver, ledgerOf, normalizeRecord, type CursorStore, type PaymentSource, type StellarPaymentRecord } from "./observer.ts";

export const HORIZON: Record<StellarNetwork, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

export const PASSPHRASE: Record<StellarNetwork, string> = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
};

const EXPLORER: Record<StellarNetwork, string> = {
  testnet: "https://stellar.expert/explorer/testnet",
  mainnet: "https://stellar.expert/explorer/public",
};

/**
 * Whatever holds a vault's Stellar key. Stellar signs with Ed25519, the same
 * curve as Solana, so a deployment's KMS or MPC key can back both: give
 * `ed25519StellarSigner` the raw 32-byte public key and a `signBytes` and it
 * signs without the key ever leaving the HSM. `localStellarSigner` is for
 * development and testnet.
 */
export interface StellarSigner {
  readonly kind: string;
  /** G… StrKey public key of the vault. */
  readonly address: string;
  /** Sign the transaction hash (32 bytes). Returns the 64-byte Ed25519 signature. */
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export function localStellarSigner(secret: string): StellarSigner {
  const keypair = Keypair.fromSecret(secret);
  return {
    kind: "local",
    address: keypair.publicKey(),
    sign: async (hash) => new Uint8Array(keypair.sign(Buffer.from(hash))),
  };
}

/** Any Ed25519 signer (KMS, MPC, Turnkey) as a Stellar signer, given its raw public key. */
export function ed25519StellarSigner(
  signer: { readonly kind: string; signBytes(message: Uint8Array): Promise<Uint8Array> },
  publicKey: Uint8Array,
): StellarSigner {
  if (publicKey.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return {
    kind: signer.kind,
    address: StrKey.encodeEd25519PublicKey(Buffer.from(publicKey)),
    sign: (hash) => signer.signBytes(hash),
  };
}

export interface StellarClientOptions {
  network: StellarNetwork;
  horizonUrl?: string;
  /** Omit for a read-only client. */
  signer?: StellarSigner;
  /** Stroops per operation. Defaults to Horizon's recent fee stats, falling back to the base fee. */
  fee?: string;
}

export class StellarClient {
  readonly server: Horizon.Server;
  readonly network: StellarNetwork;

  constructor(private readonly opts: StellarClientOptions) {
    this.server = new Horizon.Server(opts.horizonUrl ?? HORIZON[opts.network]);
    this.network = opts.network;
  }

  /** The vault's own address. Throws on a read-only client. */
  get address(): string {
    if (!this.opts.signer) throw new Error("this Stellar client is read-only: no signer configured");
    return this.opts.signer.address;
  }

  get signer(): StellarSigner | undefined {
    return this.opts.signer;
  }

  get passphrase(): string {
    return PASSPHRASE[this.network];
  }

  async fee(): Promise<string> {
    if (this.opts.fee) return this.opts.fee;
    try {
      return String(await this.server.fetchBaseFee());
    } catch {
      return BASE_FEE;
    }
  }
}

export function stellarClient(opts: StellarClientOptions): StellarClient {
  return new StellarClient(opts);
}

/** A key-less client for watch-only observation (read-only pilots). */
export function stellarReader(opts: { network: StellarNetwork; horizonUrl?: string }): StellarClient {
  return new StellarClient(opts);
}

export async function balanceOf(client: StellarClient, asset: Asset, account: string): Promise<bigint> {
  const record = await client.server.loadAccount(account);
  const issuer = asset === NATIVE ? undefined : issuerOf(asset, client.network);
  const held = record.balances.find((b) =>
    asset === NATIVE
      ? b.asset_type === "native"
      : "asset_code" in b && b.asset_code === asset && "asset_issuer" in b && b.asset_issuer === issuer,
  );
  return held ? fromStellarAmount(asset, held.balance) : 0n;
}

/**
 * A transaction memo. Corridor's own payments carry the 32-byte reference as
 * `MEMO_HASH`, which is what makes reconciliation a join (ADR 0003).
 *
 * A receiving SEP-31 anchor assigns the memo for the payment that funds its
 * order, so on that one leg the memo is the anchor's and the reference
 * travels in the SEP-31 fields instead. `text` and `id` exist for that case.
 */
export type StellarMemo =
  | { type: "hash"; value: Hex }
  | { type: "text"; value: string }
  | { type: "id"; value: string };

function buildMemo(memo: StellarMemo): Memo {
  switch (memo.type) {
    case "hash":
      return Memo.hash(Buffer.from(toStellarMemo(memo.value)));
    case "text":
      return Memo.text(memo.value);
    case "id":
      return Memo.id(memo.value);
  }
}

/** Does a Horizon record carry this memo? Hash memos arrive base64; text and id arrive as-is. */
export function memoMatches(record: StellarPaymentRecord, memo: StellarMemo): boolean {
  const tx = record.transaction;
  if (!tx?.memo) return false;
  if (memo.type === "hash") return fromStellarMemo(tx.memo, tx.memo_type) === memo.value;
  return tx.memo_type === memo.type && tx.memo === memo.value;
}

/** The memo an anchor's order requires, or the flow's own reference when it assigns none. */
export function fundingMemoFor(order: { fundingMemo?: string; fundingMemoType?: "hash" | "text" | "id" }, reference: Hex): StellarMemo {
  if (!order.fundingMemo) return { type: "hash", value: reference };
  return { type: order.fundingMemoType ?? "text", value: order.fundingMemo } as StellarMemo;
}

/**
 * Move a classic asset with the Corridor Reference as the transaction's
 * MEMO_HASH. The reference is 32 bytes and so is MEMO_HASH, so it travels
 * whole and reconciliation is a join on the memo (ADR 0003).
 */
export function transferWithReference(
  client: StellarClient,
  args: { asset: Asset; to: string; amount: bigint; reference: Hex },
): Promise<Observation & { txHash: string }> {
  return transferWithMemo(client, { ...args, memo: { type: "hash", value: args.reference } });
}

/**
 * Move a classic asset carrying `memo`.
 *
 * `reference` is what the movement is booked against in Corridor's ledger. It
 * is normally also the memo; when a SEP-31 anchor has assigned its own, the
 * two differ, and the returned observation still names the reference so the
 * booking is right even though the chain does not carry it.
 */
export async function transferWithMemo(
  client: StellarClient,
  args: { asset: Asset; to: string; amount: bigint; memo: StellarMemo; reference?: Hex },
): Promise<Observation & { txHash: string }> {
  const signer = client.signer;
  if (!signer) throw new Error("transferWithMemo needs a signer");
  const source = await client.server.loadAccount(signer.address);
  const tx = new TransactionBuilder(source, {
    fee: await client.fee(),
    networkPassphrase: client.passphrase,
    memo: buildMemo(args.memo),
  })
    .addOperation(
      Operation.payment({
        destination: args.to,
        asset: stellarAsset(args.asset, client.network),
        amount: toStellarAmount(money(args.asset, args.amount)),
      }),
    )
    .setTimeout(180)
    .build();

  tx.addSignature(signer.address, Buffer.from(await signer.sign(tx.hash())).toString("base64"));
  const sent = await client.server.submitTransaction(tx);
  const hash = sent.hash;
  if (sent.successful === false) throw new Error(`Stellar transaction ${hash} was not successful`);

  return {
    venue: "stellar",
    externalRef: `${hash}:0`,
    reference: args.reference ?? (args.memo.type === "hash" ? args.memo.value : null),
    asset: args.asset,
    amount: args.amount,
    from: signer.address,
    to: args.to,
    blockNumber: sent.ledger === undefined ? undefined : BigInt(sent.ledger),
    observedAt: new Date(),
    txHash: hash,
  };
}

/** Horizon payments for an account, with the transaction joined so memos arrive in the same call. */
export function horizonPayments(server: Horizon.Server): PaymentSource {
  return {
    async fetch(account, cursor, limit) {
      let call = server.payments().forAccount(account).join("transactions").order("asc").limit(limit);
      if (cursor) call = call.cursor(cursor);
      const page = await call.call();
      return page.records.map(normalizeRecord);
    },
  };
}

/**
 * Every movement on `account` carrying `reference`, since `cursor`.
 *
 * Unlike an indexed memo topic, Horizon cannot be asked for a memo
 * network-wide, so this reads the watched account's own payment stream and
 * filters. That stream is per-vault and bounded, which is why the reference
 * is a join key rather than an index (ADR 0003).
 */
export function findTransfersByReference(
  client: StellarClient,
  args: { account: string; reference: Hex; cursor?: string; source?: PaymentSource },
): Promise<Observation[]> {
  return findTransfersByMemo(client, { ...args, memo: { type: "hash", value: args.reference } });
}

/**
 * The same join for any memo, so a payment funding a SEP-31 order — which
 * carries the anchor's memo rather than the reference — is just as safe to
 * retry. `reference` is what the movements are booked against.
 */
export async function findTransfersByMemo(
  client: StellarClient,
  args: { account: string; memo: StellarMemo; reference?: Hex; cursor?: string; source?: PaymentSource },
): Promise<Observation[]> {
  const source = args.source ?? horizonPayments(client.server);
  const reference = args.reference ?? (args.memo.type === "hash" ? args.memo.value : null);
  const found: Observation[] = [];
  let cursor = args.cursor;
  while (true) {
    const page = await source.fetch(args.account, cursor, 200);
    if (page.length === 0) break;
    for (const record of page) {
      if (!memoMatches(record, args.memo)) continue;
      const asset = assetOf(record, client.network);
      if (!asset || !record.amount) continue;
      found.push({
        venue: "stellar",
        externalRef: `${record.transaction_hash}:${record.id}`,
        reference,
        asset,
        amount: fromStellarAmount(asset, record.amount),
        from: record.from,
        to: record.to,
        blockNumber: record.transaction?.ledger === undefined ? ledgerOf(record.paging_token) : BigInt(record.transaction.ledger),
        observedAt: new Date(record.created_at),
      });
    }
    cursor = page.at(-1)!.paging_token;
    if (page.length < 200) break;
  }
  return found;
}

/** Testnet only: fund an account from Friendbot. */
export async function fundFromFriendbot(client: StellarClient, address: string): Promise<void> {
  if (client.network !== "testnet") throw new Error("Friendbot only funds testnet accounts");
  const res = await fetch(`https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`Friendbot refused ${address}: ${res.status} ${await res.text()}`);
}

/**
 * A trustline is what lets an account hold an issued asset. Ramp's end users
 * get theirs sponsored, so they hold USDC without first holding XLM.
 */
export async function trustAsset(client: StellarClient, asset: Asset): Promise<string> {
  const signer = client.signer;
  if (!signer) throw new Error("trustAsset needs a signer");
  const source = await client.server.loadAccount(signer.address);
  const tx = new TransactionBuilder(source, { fee: await client.fee(), networkPassphrase: client.passphrase })
    .addOperation(Operation.changeTrust({ asset: stellarAsset(asset, client.network) as SdkAsset }))
    .setTimeout(180)
    .build();
  tx.addSignature(signer.address, Buffer.from(await signer.sign(tx.hash())).toString("base64"));
  const sent = await client.server.submitTransaction(tx);
  return sent.hash;
}

export function observerFor(
  client: StellarClient,
  opts: { name: string; accounts: string[]; cursors: ConstructorParameters<typeof StellarObserver>[1]["cursors"]; unreferenced?: boolean },
): StellarObserver {
  return new StellarObserver(horizonPayments(client.server), { ...opts, network: client.network });
}

export function explorerTx(network: StellarNetwork, hash: string): string {
  return `${EXPLORER[network]}/tx/${hash}`;
}

export function explorerAccount(network: StellarNetwork, address: string): string {
  return `${EXPLORER[network]}/account/${address}`;
}

/** True when `memo` is a Corridor Reference this deployment issued. */
export function isCorridorMemo(memo: string | undefined, memoType?: string): boolean {
  return !!memo && !!fromStellarMemo(memo, memoType) && !!tryDecodeRef(fromStellarMemo(memo, memoType)!);
}

/**
 * On-ledger FX. A payout funded from a EURC or MGUSD balance converts on
 * Stellar's own order books rather than at an external venue, so the
 * conversion lands in the same chain history as the payment and books from it
 * (ADR 0010).
 *
 * Strict *send* is the right shape here: what is known is the balance that
 * was reserved, and what varies is how much settlement asset it buys.
 * `destMin` is the slippage floor — the transaction fails rather than
 * delivering less than the caller allowed.
 */
export interface PathQuote {
  /** The asset spent, and the exact amount of it. */
  from: Asset;
  sourceAmount: bigint;
  /** What Horizon says that buys, in minor units of the destination asset. */
  destAmount: bigint;
  /** Intermediate assets, in order. Empty for a direct order book. */
  path: Asset[];
}

/** The best price for spending exactly `sourceAmount` of `from` to get `destAsset`. */
export async function strictSendQuote(
  client: StellarClient,
  args: { from: Asset; sourceAmount: bigint; destAsset: Asset },
): Promise<PathQuote | null> {
  const page = await client.server
    .strictSendPaths(stellarAsset(args.from, client.network), toStellarAmount(money(args.from, args.sourceAmount)), [
      stellarAsset(args.destAsset, client.network),
    ])
    .call();
  if (page.records.length === 0) return null;

  // Most received wins.
  const best = page.records.reduce((a, b) => (Number(a.destination_amount) >= Number(b.destination_amount) ? a : b));
  const hops = best.path ?? [];
  const path = hops.flatMap((h) => {
    const asset = assetOf({ asset_type: h.asset_type, asset_code: h.asset_code, asset_issuer: h.asset_issuer }, client.network);
    return asset ? [asset] : [];
  });
  // A path through an asset Corridor does not book is not a path it will take.
  if (path.length !== hops.length) return null;
  return {
    from: args.from,
    sourceAmount: args.sourceAmount,
    destAmount: fromStellarAmount(args.destAsset, best.destination_amount),
    path,
  };
}

/**
 * Convert on the order books, carrying the reference as MEMO_HASH. The
 * destination is normally the vault itself: a path payment to your own
 * account is how a swap is done on Stellar.
 */
export async function pathPaymentWithReference(
  client: StellarClient,
  args: { from: Asset; sourceAmount: bigint; destAsset: Asset; destMin: bigint; to?: string; path?: Asset[]; reference: Hex },
): Promise<Observation & { txHash: string; sourceAmount: bigint }> {
  const signer = client.signer;
  if (!signer) throw new Error("pathPaymentWithReference needs a signer");
  const destination = args.to ?? signer.address;
  const source = await client.server.loadAccount(signer.address);
  const tx = new TransactionBuilder(source, {
    fee: await client.fee(),
    networkPassphrase: client.passphrase,
    memo: Memo.hash(Buffer.from(toStellarMemo(args.reference))),
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: stellarAsset(args.from, client.network),
        sendAmount: toStellarAmount(money(args.from, args.sourceAmount)),
        destination,
        destAsset: stellarAsset(args.destAsset, client.network),
        destMin: toStellarAmount(money(args.destAsset, args.destMin)),
        path: (args.path ?? []).map((a) => stellarAsset(a, client.network)),
      }),
    )
    .setTimeout(180)
    .build();

  tx.addSignature(signer.address, Buffer.from(await signer.sign(tx.hash())).toString("base64"));
  const sent = await client.server.submitTransaction(tx);
  if (sent.successful === false) throw new Error(`Stellar path payment ${sent.hash} was not successful`);

  // How much actually arrived is set by the order books, not by the request,
  // and the response body does not carry it. Read it back off the account's
  // own payment stream, which reports a path payment like any other.
  const landed = (await findTransfersByReference(client, { account: signer.address, reference: args.reference })).find(
    (o) => o.externalRef.startsWith(sent.hash) && o.asset === args.destAsset,
  );

  return {
    venue: "stellar",
    externalRef: landed?.externalRef ?? `${sent.hash}:0`,
    reference: args.reference,
    asset: args.destAsset,
    amount: landed?.amount ?? args.destMin,
    from: signer.address,
    to: destination,
    blockNumber: landed?.blockNumber ?? (sent.ledger === undefined ? undefined : BigInt(sent.ledger)),
    observedAt: landed?.observedAt ?? new Date(),
    txHash: sent.hash,
    sourceAmount: args.sourceAmount,
  };
}

/**
 * The Stellar Asset Contract address for a classic asset. A Soroban contract
 * moving USDC does it through this contract, and its events are the only
 * place such a movement appears — Horizon's payment stream does not show it.
 */
export function sacContractId(asset: Asset, network: StellarNetwork): string {
  return stellarAsset(asset, network).contractId(PASSPHRASE[network]);
}
