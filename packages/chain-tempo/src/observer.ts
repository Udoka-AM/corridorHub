import { getAbiItem, type Address } from "viem";
import { Abis } from "viem/tempo";
import { tryDecodeRef, type Asset, type Hex, type Observation } from "@corridor/core";
import type { TempoClient } from "./index.ts";
import { tokenAddress } from "./tokens.ts";

export interface CursorStore {
  get(name: string): Promise<bigint | undefined>;
  set(name: string, block: bigint): Promise<void>;
}

const TRANSFER_WITH_MEMO = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

/**
 * Watches Corridor's Tempo vaults for memo-tagged TIP-20 movements in or out,
 * and emits them as Observations for reconciliation. Resumes from a stored
 * block cursor, so restarts neither miss nor double-count events.
 */
export class TempoObserver {
  constructor(
    private readonly client: TempoClient,
    private readonly opts: {
      name: string;
      asset: Asset;
      addresses: Address[];
      cursors: CursorStore;
      /** Where to start when no cursor exists yet. */
      startBlock: bigint;
      /** Max blocks per getLogs call. */
      maxRange?: bigint;
    },
  ) {}

  async poll(): Promise<Observation[]> {
    const { name, cursors, startBlock } = this.opts;
    const maxRange = this.opts.maxRange ?? 10_000n;
    const latest = await this.client.getBlockNumber();
    let from = ((await cursors.get(name)) ?? startBlock - 1n) + 1n;
    const seen = new Map<string, Observation>();

    while (from <= latest) {
      const to = from + maxRange - 1n > latest ? latest : from + maxRange - 1n;
      for (const obs of await this.range(from, to)) seen.set(obs.externalRef, obs);
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
    return [...inbound, ...outbound].map((log) => ({
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
  }
}
