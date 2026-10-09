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
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { formatMoney } from "@corridor/core";
import { exceptions, readOnlyCsv, summarizeReadOnly } from "@corridor/recon";
import { runWatch } from "./watch.ts";

const configPath = process.argv[2] ?? "examples/watch/eu-payco-demo.json";
const { config, errors, observations, records, results } = await runWatch(configPath);
for (const e of errors) console.warn(`${e.chain} not scanned: ${e.message}`);
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
