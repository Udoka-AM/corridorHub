/**
 * Shared read-only pilot run: watch the configured addresses on Tempo, Solana
 * and Base, and match what moved against the company's payout records. Used by
 * `pnpm watch:report` and the console's exceptions queue.
 */
import "./env.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { parseMoney, type Asset, type Hex, type Observation, type Venue } from "@corridor/core";
import { TEMPO_TOKENS, TempoObserver, tempoReader, type TempoNetwork } from "@corridor/chain-tempo";
import { SolanaWatcher, type SolanaCluster } from "@corridor/chain-solana";
import { BASE_STABLES, Erc20Watcher, type BaseNetwork } from "@corridor/chain-evm";
import { reconcileReadOnly, type PayoutRecord, type ReadOnlyResult } from "@corridor/recon";

export interface WatchConfig {
  name: string;
  tempo?: { network: TempoNetwork; addresses: Address[]; lookbackBlocks?: number };
  solana?: { cluster: SolanaCluster; addresses: string[]; limit?: number };
  base?: { network: BaseNetwork; addresses: Address[]; lookbackBlocks?: number };
  records?: string;
}

export interface WatchRun {
  config: WatchConfig;
  /** Chains whose scan failed this run (public RPC errors); the rest still reconcile. */
  errors: { chain: string; message: string }[];
  observations: Observation[];
  records: PayoutRecord[];
  results: ReadOnlyResult[];
}

const memory = () => {
  const m = new Map<string, bigint>();
  return { get: async (n: string) => m.get(n), set: async (n: string, b: bigint) => void m.set(n, b) };
};

function readRecords(path: string): PayoutRecord[] {
  const [header, ...lines] = readFileSync(path, "utf8").trim().split("\n");
  const cols = header!.split(",");
  return lines.filter(Boolean).map((line) => {
    const v = Object.fromEntries(line.split(",").map((x, i) => [cols[i], x.trim()]));
    const asset = v.asset as Asset;
    return {
      id: v.id!, venue: v.venue as Venue, asset, amount: parseMoney(asset, v.amount!).amount,
      direction: v.direction as "in" | "out", counterparty: v.counterparty || undefined,
      reference: (v.reference || undefined) as Hex | undefined, createdAt: new Date(v.created_at!),
    };
  });
}

export async function runWatch(configPath: string): Promise<WatchRun> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as WatchConfig;
  const observations: Observation[] = [];
  const errors: WatchRun["errors"] = [];
  const scan = async (chain: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      errors.push({ chain, message: String((e as Error)?.message ?? e).split("\n")[0]!.slice(0, 200) });
    }
  };

  if (config.tempo) await scan("tempo", async () => {
    const client = tempoReader({ network: config.tempo!.network });
    const latest = await client.getBlockNumber();
    const startBlock = latest - BigInt(config.tempo!.lookbackBlocks ?? 200_000);
    for (const asset of Object.keys(TEMPO_TOKENS) as Asset[]) {
      const seen = await new TempoObserver(client, {
        name: `tempo:${asset}`, asset, addresses: config.tempo!.addresses, cursors: memory(), startBlock, unreferenced: true, maxRange: 50_000n,
      }).poll();
      // Gas is booked by the vault check, not matched against payout records.
      observations.push(...seen.filter((o) => o.to?.toLowerCase() !== "0xfeec000000000000000000000000000000000000"));
    }
  });

  if (config.solana) await scan("solana", async () => {
    for (const address of config.solana!.addresses) {
      observations.push(...(await new SolanaWatcher(address, config.solana!.cluster).recent({ limit: config.solana!.limit ?? 25 })));
    }
  });

  if (config.base) await scan("base", async () => {
    const chain = config.base!.network === "base" ? base : baseSepolia;
    const client = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000, retryCount: 3 }) });
    const latest = await client.getBlockNumber();
    observations.push(
      ...(await new Erc20Watcher(client, {
        name: "base", venue: "base", tokens: BASE_STABLES[config.base!.network], addresses: config.base!.addresses,
        cursors: memory(), startBlock: latest - BigInt(config.base!.lookbackBlocks ?? 10_000),
      }).poll()),
    );
  });

  const records = config.records ? readRecords(join(dirname(configPath), config.records)) : [];
  return { config, errors, observations, records, results: reconcileReadOnly(records, observations) };
}
