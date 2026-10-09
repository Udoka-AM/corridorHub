import { getAbiItem, type Address } from "viem";
import { Abis, Addresses } from "viem/tempo";
import { tryDecodeRef, type Asset, type Hex, type Observation } from "@corridor/core";
import type { TempoClient } from "./index.ts";
import { tokenAddress } from "./tokens.ts";

type BlockReader = Pick<TempoClient, "getBlock">;

/**
 * Block timestamps for a set of block numbers, fetched once each. Observations
 * carry when the movement happened on-chain, not when it was observed, so
 * time-window matching (read-only pilots) works on Tempo too.
 */
export async function blockTimes(client: BlockReader, blocks: Iterable<bigint>, cache = new Map<bigint, Date>()): Promise<Map<bigint, Date>> {
  const missing = [...new Set(blocks)].filter((b) => !cache.has(b));
  for (let i = 0; i < missing.length; i += 4) {
    await Promise.all(
      missing.slice(i, i + 4).map(async (blockNumber) => {
        for (let attempt = 0; ; attempt++) {
          try {
            const block = await client.getBlock({ blockNumber });
            cache.set(blockNumber, new Date(Number(block.timestamp) * 1000));
            return;
          } catch (e) {
            if (attempt >= 5) throw e;
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
          }
        }
      }),
    );
  }
  return cache;
}

export interface CursorStore {
  get(name: string): Promise<bigint | undefined>;
  set(name: string, block: bigint): Promise<void>;
}

const TRANSFER_WITH_MEMO = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });
const TRANSFER = getAbiItem({ abi: Abis.tip20, name: "Transfer" });

/**
 * Tempo has no native gas token: every transaction pays its fee as a TIP-20
 * transfer from the fee payer to the Fee Manager, logged in the same receipt.
 */
export const FEE_MANAGER: Address = Addresses.feeManager;

/**
 * Watches Tempo addresses (Corridor's vaults, or a customer's own wallets in
 * read-only mode) for TIP-20 movements in or out, and emits them as
 * Observations for reconciliation. Resumes from a stored
 * block cursor, so restarts neither miss nor double-count events.
 */
export class TempoObserver {
  constructor(
    private readonly client: Pick<TempoClient, "getBlockNumber" | "getLogs" | "getBlock">,
    private readonly opts: {
      name: string;
      asset: Asset;
      addresses: Address[];
      cursors: CursorStore;
      /** Where to start when no cursor exists yet. */
      startBlock: bigint;
      /** Max blocks per getLogs call. */
      maxRange?: bigint;
      /**
       * Also report movements that carry no memo: gas fees the watched
       * addresses pay to the Fee Manager, and plain inbound transfers (faucet
       * mints, owner top-ups, deposits sent without a reference).
       */
      unreferenced?: boolean;
    },
  ) {}

  private readonly times = new Map<bigint, Date>();

  async poll(): Promise<Observation[]> {
    const { name, cursors, startBlock } = this.opts;
    let maxRange = this.opts.maxRange ?? 10_000n;
    let throttled = 0;
    const latest = await this.client.getBlockNumber();
    let from = ((await cursors.get(name)) ?? startBlock - 1n) + 1n;
    const seen = new Map<string, Observation>();

    while (from <= latest) {
      const to = from + maxRange - 1n > latest ? latest : from + maxRange - 1n;
      let found: Observation[];
      try {
        found = await this.range(from, to);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        // Moderato answers "Request exceeds defined limit" when rate limited: wait and retry the same window.
        if (/exceeds defined limit|rate limit|429|too many requests/i.test(message) && throttled < 6) {
          await new Promise((r) => setTimeout(r, 1_000 * 2 ** throttled++));
          continue;
        }
        // Other public RPCs cap getLogs by block range or response size: shrink the window.
        if (/limited to|block range|response size|query returned more than/i.test(message) && maxRange > 100n) {
          maxRange /= 2n;
          continue;
        }
        throw e;
      }
      throttled = 0;
      const times = await blockTimes(this.client, found.flatMap((o) => (o.blockNumber === undefined ? [] : [o.blockNumber])), this.times);
      for (const obs of found) seen.set(obs.externalRef, { ...obs, observedAt: (obs.blockNumber !== undefined && times.get(obs.blockNumber)) || obs.observedAt });
      await cursors.set(name, to);
      from = to + 1n;
    }
    return [...seen.values()].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  }

  private async range(fromBlock: bigint, toBlock: bigint): Promise<Observation[]> {
    const address = tokenAddress(this.opts.asset);
    const watch = this.opts.addresses;
    // Indexed-argument filters are ORed within an array, so query inbound and outbound separately.
    const [inbound, outbound] = await Promise.all([
      this.client.getLogs({ address, event: TRANSFER_WITH_MEMO, args: { to: watch }, fromBlock, toBlock }),
      this.client.getLogs({ address, event: TRANSFER_WITH_MEMO, args: { from: watch }, fromBlock, toBlock }),
    ]);
    const memoed = [...inbound, ...outbound].map((log) => ({
      venue: "tempo" as const,
      externalRef: `${log.transactionHash}:${log.logIndex}`,
      reference: tryDecodeRef(log.args.memo!) ? (log.args.memo as Hex) : null,
      asset: this.opts.asset,
      amount: log.args.amount!,
      from: log.args.from,
      to: log.args.to,
      blockNumber: log.blockNumber ?? undefined,
      observedAt: new Date(),
    }));
    if (!this.opts.unreferenced) return memoed;

    const [plainIn, fees] = await Promise.all([
      this.client.getLogs({ address, event: TRANSFER, args: { to: watch }, fromBlock, toBlock }),
      this.client.getLogs({ address, event: TRANSFER, args: { from: watch, to: FEE_MANAGER }, fromBlock, toBlock }),
    ]);
    // A memo transfer also emits a plain Transfer; keep only the memo'd one.
    const key = (tx: string, from?: string, to?: string, amount?: bigint) => `${tx}:${from?.toLowerCase()}:${to?.toLowerCase()}:${amount}`;
    const hasMemo = new Set(inbound.map((l) => key(l.transactionHash!, l.args.from, l.args.to, l.args.amount)));
    const unreferenced = [...plainIn.filter((l) => !hasMemo.has(key(l.transactionHash!, l.args.from, l.args.to, l.args.amount))), ...fees].map(
      (log) => ({
        venue: "tempo" as const,
        externalRef: `${log.transactionHash}:${log.logIndex}`,
        reference: null,
        asset: this.opts.asset,
        amount: log.args.amount!,
        from: log.args.from,
        to: log.args.to,
        blockNumber: log.blockNumber ?? undefined,
        observedAt: new Date(),
      }),
    );
    return [...memoed, ...unreferenced];
  }
}
