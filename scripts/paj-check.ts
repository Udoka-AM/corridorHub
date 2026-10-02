/**
 * Read-only Paj connectivity check: fetch live rates with PAJ_API_KEY from
 * .env.local. Moves no money; never prints the key.
 *
 *   pnpm paj:check
 */
import { PajPartner, PartnerError } from "@corridor/partners";
import "./env.ts"; // loads .env.local and prefers IPv4
const apiKey = process.env.PAJ_API_KEY;
if (!apiKey) {
  console.error("PAJ_API_KEY is not set in .env.local");
  process.exit(1);
}

const paj = new PajPartner({ apiKey, webhookSecret: process.env.PAJ_WEBHOOK_SECRET });
for (const currency of ["NGN"] as const) {
  try {
    const r = await paj.rates(currency);
    console.log(`${currency}: on-ramp ${r.onRamp} · off-ramp ${r.offRamp} per USD (as of ${r.at.toISOString()})`);
  } catch (err) {
    if (err instanceof PartnerError) console.error(`${currency}: Paj returned ${err.status ?? "?"}: ${err.message}`);
    else console.error(`${currency}: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
