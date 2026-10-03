/**
 * Read-only pilot: watch a payment company's existing wallets, match what moved
 * against its own payout records, and print the exceptions queue. No keys, no
 * ledger writes, nothing moves.
 *
 *   pnpm watch:report examples/watch/eu-payco-demo.json
 *
 * Config: addresses per chain plus an optional CSV of payout records
 * (id,venue,asset,amount,direction,counterparty,reference,created_at; amounts
 * in decimal units, e.g. 250.00). Writes <name>-report.csv next to the config.
 */
import "./env.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createPublicClient, http, type Address } from "viem";
import { base, baseSepolia } from "viem/chains";
import { formatMoney, parseMoney, type Asset, type Hex, type Observation, type Venue } from "@corridor/core";
import { TEMPO_TOKENS, TempoObserver, tempoReader, type TempoNetwork } from "@corridor/chain-tempo";
import { SolanaWatcher, type SolanaCluster } from "@corridor/chain-solana";
import { BASE_STABLES, Erc20Watcher, type BaseNetwork } from "@corridor/chain-evm";
import { exceptions, readOnlyCsv, reconcileReadOnly, summarizeReadOnly, type PayoutRecord } from "@corridor/recon";

interface WatchConfig {
  name: string;
  tempo?: { network: TempoNetwork; addresses: Address[]; lookbackBlocks?: number };
  solana?: { cluster: SolanaCluster; addresses: string[]; limit?: number };
  base?: { network: BaseNetwork; addresses: Address[]; lookbackBlocks?: number };
  records?: string;
}

const configPath = process.argv[2] ?? "examples/watch/eu-payco-demo.json";
const config = JSON.parse(readFileSync(configPath, "utf8")) as WatchConfig;
const memory = () => {
  const m = new Map<string, bigint>();
  return { get: async (n: string) => m.get(n), set: async (n: string, b: bigint) => void m.set(n, b) };
};

const observations: Observation[] = [];

if (config.tempo) {
  const client = tempoReader({ network: config.tempo.network });
  const latest = await client.getBlockNumber();
  const startBlock = latest - BigInt(config.tempo.lookbackBlocks ?? 200_000);
  for (const asset of Object.keys(TEMPO_TOKENS) as Asset[]) {
    const seen = await new TempoObserver(client, {
      name: `tempo:${asset}`, asset, addresses: config.tempo.addresses, cursors: memory(), startBlock, unreferenced: true, maxRange: 50_000n,
    }).poll();
    // Gas is booked by the vault check, not matched against payout records.
    observations.push(...seen.filter((o) => o.to?.toLowerCase() !== "0xfeec000000000000000000000000000000000000"));
  }
}

if (config.solana) {
  for (const address of config.solana.addresses) {
    observations.push(...(await new SolanaWatcher(address, config.solana.cluster).recent({ limit: config.solana.limit ?? 25 })));
  }
}

if (config.base) {
  const chain = config.base.network === "base" ? base : baseSepolia;
  const client = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000, retryCount: 3 }) });
  const latest = await client.getBlockNumber();
  observations.push(
    ...(await new Erc20Watcher(client, {
      name: "base", venue: "base", tokens: BASE_STABLES[config.base.network], addresses: config.base.addresses,
      cursors: memory(), startBlock: latest - BigInt(config.base.lookbackBlocks ?? 10_000),
    }).poll()),
  );
}

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

const records = config.records ? readRecords(join(dirname(configPath), config.records)) : [];
const results = reconcileReadOnly(records, observations);
const summary = summarizeReadOnly(results);

console.log(`\n${config.name}: ${observations.length} stablecoin movements observed, ${records.length} payout records\n`);
console.table(summary);
const queue = exceptions(results);
console.log(`\nExceptions (${queue.length}):`);
for (const r of queue.slice(0, 25)) {
  const o = r.observation;
  const what = r.record ? `${r.record.id} expected ${formatMoney({ asset: r.record.asset, amount: r.record.amount })}` : `unrecorded ${o!.venue} ${formatMoney({ asset: o!.asset, amount: o!.amount })}`;
  console.log(`  ${r.status.padEnd(10)} ${what}${o ? `  ${o.externalRef.slice(0, 20)}…` : ""}`);
}
const out = join(dirname(configPath), `${config.name}-report.csv`);
writeFileSync(out, readOnlyCsv(results));
console.log(`\nCSV: ${out}`);
