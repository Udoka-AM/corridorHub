import { erc20Abi, getAbiItem, type Address, type Log, type PublicClient } from "viem";
import type { Observation, Stablecoin, Venue } from "@corridor/core";

/**
 * EVM spokes (Base today). Base has no transfer memo, so Corridor's own Base
 * legs are matched through the bridge's deposit status; this watcher covers
 * the read-only side: stablecoin movements in and out of any address, such as
 * a customer's existing treasury wallet with another provider.
 */

export type BaseNetwork = "base" | "base-sepolia";

/**
 * Pseudo-address that Base fee observations are "paid to", so vault
 * accounting books them to expense:gas exactly like Tempo's Fee Manager
 * transfers and Solana's network fees.
 */
export const BASE_FEES = "base:network-fees";

/** A Base transaction's fee (execution gas plus L1 data fee, in wei) as an Observation for vault accounting. */
export function gasObservation(args: { txHash: string; payer: string; wei: bigint; blockNumber?: bigint; at?: Date }): Observation {
  return {
    venue: "base",
    externalRef: `${args.txHash}:fee`,
    reference: null,
    asset: "ETH",
    amount: args.wei,
    from: args.payer,
    to: BASE_FEES,
    blockNumber: args.blockNumber,
    observedAt: args.at ?? new Date(),
  };
}

/** Stablecoins on Base by network. Bridged USDT has no canonical Base deployment, so it is left out on purpose. */
export const BASE_STABLES: Record<BaseNetwork, Partial<Record<Stablecoin, Address>>> = {
  base: {
    USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    EURC: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42",
  },
  "base-sepolia": {
    USDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  },
};

const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });

export interface CursorStore {
  get(name: string): Promise<bigint | undefined>;
  set(name: string, block: bigint): Promise<void>;
}

type TransferLog = Log<bigint, number, false, typeof TRANSFER, true>;

/** Map ERC-20 Transfer logs to Observations. Pure, so it is unit-testable. */
export function transferObservations(venue: Venue, asset: Stablecoin, logs: readonly TransferLog[]): Observation[] {
  return logs.map((log) => ({
    venue,
    externalRef: `${log.transactionHash}:${log.logIndex}`,
    reference: null,
    asset,
    amount: log.args.value,
    from: log.args.from,
    to: log.args.to,
    blockNumber: log.blockNumber,
    observedAt: new Date(),
  }));
}

export class Erc20Watcher {
  constructor(
    private readonly client: Pick<PublicClient, "getBlockNumber" | "getLogs">,
    private readonly opts: {
      name: string;
      venue: Venue;
      tokens: Partial<Record<Stablecoin, Address>>;
      addresses: Address[];
      cursors: CursorStore;
      startBlock: bigint;
      maxRange?: bigint;
    },
  ) {}

  /** Public RPCs cap eth_getLogs ranges and change the cap without notice; shrink to whatever the error says. */
  private async logs(q: Parameters<Erc20Watcher["client"]["getLogs"]>[0]): Promise<TransferLog[]> {
    return (await this.client.getLogs(q as never)) as unknown as TransferLog[];
  }

  async poll(): Promise<Observation[]> {
    const { name, cursors, startBlock } = this.opts;
    let maxRange = this.opts.maxRange ?? 1_000n;
    const latest = await this.client.getBlockNumber();
    let from = ((await cursors.get(name)) ?? startBlock - 1n) + 1n;
    const seen = new Map<string, Observation>();
    while (from <= latest) {
      const to = from + maxRange - 1n > latest ? latest : from + maxRange - 1n;
      try {
        for (const [asset, token] of Object.entries(this.opts.tokens) as [Stablecoin, Address][]) {
          const [inbound, outbound] = await Promise.all([
            this.logs({ address: token, event: TRANSFER, args: { to: this.opts.addresses }, fromBlock: from, toBlock: to }),
            this.logs({ address: token, event: TRANSFER, args: { from: this.opts.addresses }, fromBlock: from, toBlock: to }),
          ]);
          for (const o of transferObservations(this.opts.venue, asset, [...inbound, ...outbound])) seen.set(o.externalRef, o);
        }
      } catch (e) {
        const cap = /limited to an? ([\d,]+)\s*(?:block)?\s*range/i.exec(String((e as Error)?.message ?? e));
        const limit = cap ? BigInt(cap[1]!.replace(/,/g, "")) : undefined;
        if (limit && limit < maxRange) {
          maxRange = limit;
          continue; // retry this window at the smaller range
        }
        throw e;
      }
      await cursors.set(name, to);
      from = to + 1n;
    }
    return [...seen.values()].sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)));
  }
}
