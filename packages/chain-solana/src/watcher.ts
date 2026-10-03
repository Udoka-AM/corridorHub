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

  async recent(opts: { limit?: number; before?: string; onlyReferenced?: boolean } = {}): Promise<Observation[]> {
    const sigs = await this.rpc
      .getSignaturesForAddress(address(this.owner), { limit: opts.limit ?? 25, ...(opts.before ? { before: opts.before as Signature } : {}) })
      .send();
    const out: Observation[] = [];
    for (const s of sigs) {
      if (s.err) continue;
      const reference = extractReference(s.memo);
      if (opts.onlyReferenced && !reference) continue;
      const tx = await this.rpc
        .getTransaction(s.signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })
        .send();
      if (!tx?.meta) continue;
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
          blockNumber: BigInt(s.slot),
          observedAt: new Date(Number(s.blockTime ?? 0) * 1000),
        });
      }
    }
    return out;
  }
}
