/**
 * Run the hosted Ramp API locally.
 *
 *   pnpm ramp:serve
 *   curl -X POST localhost:8787/v1/signup -d '{"name":"My app"}'
 *
 * Env: RAMP_PORT (8787), RAMP_PUBLIC_URL, RAMP_ADMIN_TOKEN (enables paid-plan
 * apps), RAMP_DATA_DIR (.data/ramp), RAMP_ASSET (XLM on testnet, USDC on
 * mainnet), CORRIDOR_ANCHOR_BASE_URL (a SEP server; otherwise the mock),
 * DATABASE_URL (a Postgres server; otherwise PGlite in RAMP_DATA_DIR),
 * RAMP_RATE_LIMIT (requests per minute per API key, 600).
 */
import { rampServer } from "@corridor/ramp";
import { NETWORK } from "./runtime.ts";
import { RAMP_ASSET, openRamp } from "./ramp-env.ts";

const port = Number(process.env.RAMP_PORT ?? 8787);
const publicUrl = process.env.RAMP_PUBLIC_URL ?? `http://localhost:${port}`;
const { ramp, sponsor, anchor } = await openRamp({ publicUrl, dataDir: process.env.RAMP_DATA_DIR ?? ".data/ramp", partnerWebhookBase: publicUrl });

const server = rampServer(ramp, {
  adminToken: process.env.RAMP_ADMIN_TOKEN,
  selfServeSignup: NETWORK === "testnet",
  rateLimit: { requestsPerMinute: Number(process.env.RAMP_RATE_LIMIT ?? 600) },
  // Route templates, status and ids only: the handler never passes headers or bodies to the log.
  log: (entry) => console.log(JSON.stringify(entry)),
});
setInterval(() => void ramp.deliverPending().catch((e) => console.error("webhook retry:", e)), 30_000).unref();
// Orders settle only from what Horizon shows (ADR 0008).
setInterval(() => void ramp.reconcile().catch((e) => console.error("reconcile:", e)), 10_000).unref();
// The Tron lane's first step waits on a solver, which takes minutes, so it is
// moved along here rather than inside a request. A no-op unless the lane is
// configured (see apps/docs/integrations/tron.mdx).
setInterval(() => void ramp.advanceTronDeposits().catch((e) => console.error("tron:", e)), 15_000).unref();
server.listen(port, () => {
  console.log(`Ramp API on ${publicUrl} (${NETWORK}, settling in ${RAMP_ASSET})`);
  console.log(`sponsor ${sponsor.address}, anchor ${anchor.id}`);
  if (NETWORK === "testnet") console.log(`sandbox signup: curl -X POST ${publicUrl}/v1/signup -H 'content-type: application/json' -d '{"name":"My app"}'`);
});
