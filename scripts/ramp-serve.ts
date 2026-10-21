/**
 * Run the hosted Ramp API locally.
 *
 *   pnpm ramp:serve
 *   curl -X POST localhost:8787/v1/signup -d '{"name":"My app"}'
 *
 * Env: RAMP_PORT (8787), RAMP_PUBLIC_URL, RAMP_ADMIN_TOKEN (enables paid-plan
 * apps), RAMP_DATA_DIR (.data/ramp), RAMP_ASSET (XLM on testnet, USDC on
 * mainnet), CORRIDOR_ANCHOR_BASE_URL (a SEP server; otherwise the mock).
 */
import { rampServer } from "@corridor/ramp";
import { NETWORK } from "./runtime.ts";
import { RAMP_ASSET, openRamp } from "./ramp-env.ts";

const port = Number(process.env.RAMP_PORT ?? 8787);
const publicUrl = process.env.RAMP_PUBLIC_URL ?? `http://localhost:${port}`;
const { ramp, sponsor, anchor } = await openRamp({ publicUrl, dataDir: process.env.RAMP_DATA_DIR ?? ".data/ramp", partnerWebhookBase: publicUrl });

const server = rampServer(ramp, { adminToken: process.env.RAMP_ADMIN_TOKEN, selfServeSignup: NETWORK === "testnet" });
setInterval(() => void ramp.deliverPending().catch((e) => console.error("webhook retry:", e)), 30_000).unref();
// Orders settle only from what Horizon shows (ADR 0008).
setInterval(() => void ramp.reconcile().catch((e) => console.error("reconcile:", e)), 10_000).unref();
server.listen(port, () => {
  console.log(`Ramp API on ${publicUrl} (${NETWORK}, settling in ${RAMP_ASSET})`);
  console.log(`sponsor ${sponsor.address}, anchor ${anchor.id}`);
  if (NETWORK === "testnet") console.log(`sandbox signup: curl -X POST ${publicUrl}/v1/signup -H 'content-type: application/json' -d '{"name":"My app"}'`);
});
