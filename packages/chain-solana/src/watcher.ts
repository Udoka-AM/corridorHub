import { address, createSolanaRpc, type Signature } from "@solana/kit";
import { fromSolanaMemo, tryDecodeRef, type Hex, type Observation, type Stablecoin } from "@corridor/core";
import { stableByMint, type SolanaCluster } from "./stables.ts";

/** The part of a parsed transaction's `meta` the watcher reads. */
export interface TokenBalanceMeta {
  preTokenBalances?: readonly TokenBalance[] | null;
  postTokenBalances?: readonly TokenBalance[] | null;
}

interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}

export interface TokenDelta {
  asset: Stablecoin;
  /** Positive: the owner received; negative: the owner sent. */
  delta: bigint;
  /** The other owner whose balance in the same mint moved the opposite way. */
  counterparty?: string;
}

/**
 * Net stablecoin movement for `owner` in one transaction, from the pre/post
 * token balances. Works for any program that moved the tokens (plain
 * transfers, swaps, bridges), not just transfers Corridor built itself.
 */
export function tokenDeltas(meta: TokenBalanceMeta, owner: string, cluster: SolanaCluster): TokenDelta[] {
  const byKey = new Map<string, { mint: string; owner: string; delta: bigint }>();
  const add = (b: TokenBalance, sign: 1n | -1n) => {
    if (!b.owner) return;
    const key = `${b.accountIndex}`;
    const cur = byKey.get(key) ?? { mint: b.mint, owner: b.owner, delta: 0n };
    cur.delta += sign * BigInt(b.uiTokenAmount.amount);
    byKey.set(key, cur);
  };
  for (const b of meta.preTokenBalances ?? []) add(b, -1n);
  for (const b of meta.postTokenBalances ?? []) add(b, 1n);

  const out: TokenDelta[] = [];
  const mints = new Set([...byKey.values()].filter((v) => v.owner === owner).map((v) => v.mint));
  for (const mint of mints) {
    const asset = stableByMint(cluster, mint);
    if (!asset) continue;
    const rows = [...byKey.values()].filter((v) => v.mint === mint);
    const delta = rows.filter((v) => v.owner === owner).reduce((a, v) => a + v.delta, 0n);
    if (delta === 0n) continue;
    const abs = (x: bigint) => (x < 0n ? -x : x);
    const other = rows
      .filter((v) => v.owner !== owner && (delta > 0n ? v.delta < 0n : v.delta > 0n))
      .sort((a, b) => (abs(b.delta) > abs(a.delta) ? 1 : abs(b.delta) < abs(a.delta) ? -1 : 0))[0];
    out.push({ asset, delta, counterparty: other?.owner });
  }
  return out;
}

/**
 * Pseudo-address that Solana fee observations are "paid to", so vault
 * accounting books them to expense:gas the same way it books the hub's XLM
 * Manager transfers.
 */
export const SOLANA_FEES = "solana:network-fees";

/**
 * Pseudo-address for SOL a vault spends creating accounts (for example the
 * recipient's token account when funding a partner's one-off deposit
 * address). It is rent, not a transfer, and is booked to its own expense.
 */
export const SOLANA_ACCOUNT_RENT = "solana:account-rent";

/** The parts of a parsed transaction the native (SOL) accounting reads. */
export interface NativeTx {
  message: { accountKeys: readonly ({ pubkey: string } | string)[] };
  meta: { fee: bigint | number; preBalances: readonly (bigint | number)[]; postBalances: readonly (bigint | number)[] };
}

/**
 * SOL movements for `owner` in one transaction: the network fee it paid (if it
 * was the fee payer) and any other change in its SOL balance, with the account
 * whose balance moved the opposite way.
 */
export function nativeMovements(tx: NativeTx, owner: string): { fee: bigint; delta: bigint; counterparty?: string; createdAccount?: boolean } {
  const keys = tx.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  const i = keys.indexOf(owner);
  if (i < 0) return { fee: 0n, delta: 0n };
  const fee = i === 0 ? BigInt(tx.meta.fee) : 0n;
  const change = (j: number) => BigInt(tx.meta.postBalances[j] ?? 0) - BigInt(tx.meta.preBalances[j] ?? 0);
  const delta = change(i) + fee; // the fee is reported separately, so take it out of the owner's change
  let counterparty: string | undefined;
  let createdAccount = false;
  if (delta !== 0n) {
    let best = 0n;
    keys.forEach((k, j) => {
      if (j === i) return;
      const c = change(j) + (j === 0 ? BigInt(tx.meta.fee) : 0n);
      if ((delta > 0n ? c < 0n : c > 0n) && (c < 0n ? -c : c) > best) {
        best = c < 0n ? -c : c;
        counterparty = k;
        createdAccount = delta < 0n && BigInt(tx.meta.preBalances[j] ?? 0) === 0n;
      }
    });
  }
  return createdAccount ? { fee, delta, counterparty, createdAccount } : { fee, delta, counterparty };
}

/** Public Solana RPCs answer 429 under load: wait and retry rather than fail a whole scan. */
async function retrying<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= attempts || !/429|too many requests|rate limit/i.test(String((e as Error)?.message ?? e))) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

/** RPC `memo` fields look like `[N] corridor:<hex>`; pull the Corridor Reference out if present. */
export function extractReference(memoField: string | null | undefined): Hex | null {
  if (!memoField) return null;
  const m = /corridor:[0-9a-f]{64}/.exec(memoField);
  const hex = m ? fromSolanaMemo(m[0]) : null;
  return hex && tryDecodeRef(hex) ? hex : null;
}

/**
 * Watch-only observer for any Solana address: a Corridor vault, or a wallet a
 * customer already runs with another provider. It needs no key, so a
 * read-only pilot can start from nothing but an address list.
 *
 * Emits one Observation per stablecoin that moved in each transaction, with
 * the real amount from balance changes. `externalRef` is the signature, or
 * `signature:ASSET` when one transaction moved several stablecoins.
 */
export class SolanaWatcher {
  private readonly rpc;

  constructor(
    readonly owner: string,
    readonly cluster: SolanaCluster,
    rpcUrl?: string,
  ) {
    this.rpc = createSolanaRpc(rpcUrl ?? (cluster === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com"));
  }

  /**
   * Every transaction touching the address, oldest first, following the RPC's
   * pages back to the first one (or `max`). Used to replay a vault's history.
   */
  async history(opts: { native?: boolean; max?: number } = {}): Promise<Observation[]> {
    const out: Observation[] = [];
    let before: string | undefined;
    for (let fetched = 0; fetched < (opts.max ?? 1_000); ) {
      const sigs = await this.signatures(100, before);
      out.push(...(await this.observe(sigs, { native: opts.native })));
      fetched += sigs.length;
      if (sigs.length < 100) break;
      before = sigs[sigs.length - 1]!.signature;
    }
    return out.sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  }

  async recent(opts: { limit?: number; before?: string; onlyReferenced?: boolean; native?: boolean } = {}): Promise<Observation[]> {
    return this.observe(await this.signatures(opts.limit ?? 25, opts.before), opts);
  }

  /** The address's SOL balance in lamports, for the vault check. */
  async nativeBalance(): Promise<bigint> {
    const { value } = await retrying(() => this.rpc.getBalance(address(this.owner)).send());
    return BigInt(value);
  }

  private async signatures(limit: number, before?: string) {
    return retrying(() => this.rpc.getSignaturesForAddress(address(this.owner), { limit, ...(before ? { before: before as Signature } : {}) }).send());
  }

  private async observe(
    sigs: Awaited<ReturnType<SolanaWatcher["signatures"]>>,
    opts: { onlyReferenced?: boolean; native?: boolean },
  ): Promise<Observation[]> {
    const out: Observation[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      const reference = extractReference(s.memo);
      if (opts.onlyReferenced && !reference) continue;
      const tx = await retrying(() =>
        this.rpc.getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }).send(),
      );
      if (!tx?.meta) continue;
      const at = new Date(Number(s.blockTime ?? 0) * 1000);
      const slot = BigInt(s.slot);
      if (opts.native) {
        const n = nativeMovements({ message: (tx.transaction as unknown as NativeTx).message, meta: tx.meta as unknown as NativeTx["meta"] }, this.owner);
        if (n.fee > 0n) {
          out.push({ venue: "solana", externalRef: `${s.signature}:fee`, reference: null, asset: "SOL", amount: n.fee, from: this.owner, to: SOLANA_FEES, blockNumber: slot, observedAt: at });
        }
        if (n.delta !== 0n) {
          const incoming = n.delta > 0n;
          out.push({
            // No leg books SOL, so this is never matched by reference: vault accounting books it (rent, funding).
            venue: "solana", externalRef: `${s.signature}:sol`, reference: null, asset: "SOL", amount: incoming ? n.delta : -n.delta,
            from: incoming ? n.counterparty : this.owner,
            to: incoming ? this.owner : n.createdAccount ? SOLANA_ACCOUNT_RENT : n.counterparty,
            blockNumber: slot, observedAt: at,
          });
        }
      }
      const deltas = tokenDeltas(tx.meta as unknown as TokenBalanceMeta, this.owner, this.cluster);
      for (const d of deltas) {
        const incoming = d.delta > 0n;
        out.push({
          venue: "solana",
          externalRef: deltas.length > 1 ? `${s.signature}:${d.asset}` : s.signature,
          reference,
          asset: d.asset,
          amount: incoming ? d.delta : -d.delta,
          from: incoming ? d.counterparty : this.owner,
          to: incoming ? this.owner : d.counterparty,
          blockNumber: slot,
          observedAt: at,
        });
      }
    }
    return out;
  }
}
