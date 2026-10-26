/**
 * The treasury console: a read-only window on the engines.
 *
 *   pnpm console:serve
 *
 * Env: CONSOLE_PORT (8788), CONSOLE_HOST (127.0.0.1), RAMP_DATA_DIR
 * (.data/ramp — the same ledger the Ramp server writes), DATABASE_URL (a
 * Postgres server instead), CORRIDOR_NETWORK.
 *
 * It opens no keys and posts nothing. Every panel is a select, so the console
 * cannot be the reason a number changed (ADR 0011). It binds to localhost by
 * default because it is Corridor's own operations view, not a tenant's: there
 * is no authentication to put in front of it, so it is not put on a network.
 *
 * Chain-side reconciliation deliberately stays out. Matching Horizon against
 * the books means polling as an observer, and an observer advances its
 * cursors — a write, and one that would consume movements `watch:report` has
 * not seen yet. A console that quietly starved the reconciler would be worse
 * than one that sends you to it, so `pnpm watch:report` keeps that job.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bookedFees,
  corridorBoard,
  exceptionsQueue,
  fundingForecast,
  settlementTimeline,
  venueBalances,
} from "@corridor/console";
import { openLocalDb, openPostgresDb } from "@corridor/ledger";
import { DIGITAL_ASSETS, FIAT } from "@corridor/core";

/**
 * How many decimals each asset's minor units carry, sent with every response.
 *
 * The ledger stores minor units, and they are not all the same scale: the
 * stablecoins are 7 dp to match Stellar, SOL is 9, fiat is mostly 2 and CLP
 * is 0. A page that assumed one scale would misprice the rest by orders of
 * magnitude, so it is told rather than left to guess.
 */
const DECIMALS: Record<string, number> = {
  ...Object.fromEntries(Object.entries(DIGITAL_ASSETS).map(([a, v]) => [a, v.decimals])),
  ...Object.fromEntries(Object.entries(FIAT).map(([a, v]) => [a, v.decimals])),
};

const port = Number(process.env.CONSOLE_PORT ?? 8788);
const host = process.env.CONSOLE_HOST ?? "127.0.0.1";
const network = process.env.CORRIDOR_NETWORK ?? "testnet";
const dataDir = process.env.RAMP_DATA_DIR ?? ".data/ramp";
const page = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");

if (!process.env.DATABASE_URL) mkdirSync(dataDir, { recursive: true });
const db = process.env.DATABASE_URL ? await openPostgresDb(process.env.DATABASE_URL) : await openLocalDb(dataDir);

/**
 * Every panel at once. The console is one screen, so one request fills it —
 * and all six then describe the same instant, which matters when a reviewer
 * is checking a hold against a timeline.
 */
async function panels() {
  const [board, balances, timeline, exceptions, fees, forecast] = await Promise.all([
    corridorBoard(db),
    venueBalances(db),
    settlementTimeline(db, 25),
    exceptionsQueue(db, 50),
    bookedFees(db),
    fundingForecast(db),
  ]);
  return {
    network,
    generatedAt: new Date().toISOString(),
    decimals: DECIMALS,
    board,
    venues: balances.venues,
    clearing: balances.clearing,
    timeline,
    exceptions,
    fees,
    forecast,
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  // A read-only console answers reads. Anything else is a mistake worth
  // naming rather than a route to add later.
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD" }).end("the console only reads");
    return;
  }
  try {
    if (url.pathname === "/api/panels") {
      const body = JSON.stringify(await panels());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(body);
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(page));
      return;
    }
    if (url.pathname === "/prototype.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(await readFile(page.replace("index.html", "prototype.html")));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: (e as Error).message }));
  }
});

server.listen(port, host, () => {
  console.log(`Treasury console on http://${host}:${port} (${network}, reading ${process.env.DATABASE_URL ? "Postgres" : dataDir})`);
  console.log("read-only: no keys are opened and nothing is posted");
});

const shut = async () => {
  server.close();
  await db.close();
  process.exit(0);
};
process.on("SIGINT", shut);
process.on("SIGTERM", shut);
