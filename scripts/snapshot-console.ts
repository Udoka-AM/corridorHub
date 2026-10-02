/**
 * Record the running console (pnpm console) as a static, read-only replay
 * published with the site at /console/ (apps/site/public/console).
 *
 *   pnpm console            # in one terminal
 *   pnpm console:snapshot   # in another
 *
 * Every API response is saved as JSON next to a copy of the console page that
 * reads them instead of the live API. The snapshot is refused if any value
 * from .env.local or .keys/ appears in it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE = process.env.CONSOLE_URL ?? "http://localhost:4400";
const OUT = "apps/site/public/console";
const GETS = ["overview", "sagas", "reconciliation", "shielded", "forecast", "network", "approvals"];
const POSTS = ["disclosures"]; // read-only on the server: builds the auditor package

// The console calls public testnet RPCs, which time out now and then: retry each endpoint.
async function record(name: string, method: "GET" | "POST"): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${BASE}/api/${name}`, { method, signal: AbortSignal.timeout(600_000) });
    const body = await res.json();
    if (res.ok && !(body && typeof body === "object" && "error" in body)) return JSON.stringify(body, null, 1);
    if (attempt === 4) throw new Error(`${name}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    console.log(`${name} failed (attempt ${attempt}), retrying…`);
    await new Promise((r) => setTimeout(r, 5_000 * attempt));
  }
}

const files: Record<string, string> = {};
for (const name of GETS) {
  files[name] = await record(name, "GET");
  console.log(`recorded ${name}`);
}
for (const name of POSTS) {
  files[name] = await record(name, "POST");
  console.log(`recorded ${name}`);
}

// The journal is append-only, so customer ids from early runs stay in the
// books. Ids that name a real company are shown under a neutral demo name.
const DISPLAY_ALIASES: Record<string, string> = { "zynta-demo": "eu-payco-demo" };
for (const name of Object.keys(files)) {
  for (const [from, to] of Object.entries(DISPLAY_ALIASES)) files[name] = files[name]!.replaceAll(`"${from}"`, `"${to}"`);
}

// Nothing secret may leave the machine.
const secrets: string[] = [];
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const value = line.split("=").slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    if (value.length >= 16) secrets.push(value, value.replace(/^0x/, ""));
  }
}
const walk = (dir: string): string[] =>
  existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)])) : [];
for (const file of walk(".keys").filter((f) => !f.endsWith("public.json"))) {
  const text = readFileSync(file, "utf8");
  for (const token of text.match(/[A-Za-z0-9+/_-]{32,}/g) ?? []) secrets.push(token);
}
for (const [name, body] of Object.entries(files)) {
  const leak = secrets.find((s) => body.includes(s));
  if (leak) throw new Error(`refusing to publish: ${name} contains a value from .env.local or .keys (${leak.slice(0, 6)}…)`);
}

mkdirSync(join(OUT, "data"), { recursive: true });
for (const [name, body] of Object.entries(files)) writeFileSync(join(OUT, "data", `${name}.json`), body + "\n");
const snapshotDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
const page = readFileSync("apps/console/public/index.html", "utf8").replace(
  "<script>\n// Set by scripts/snapshot-console.ts",
  `<script>window.CORRIDOR_REPLAY = ${JSON.stringify({ snapshotDate, recordedAt: new Date().toISOString() })};</script>\n<script>\n// Set by scripts/snapshot-console.ts`,
);
if (!page.includes("window.CORRIDOR_REPLAY =")) throw new Error("could not inject replay flag into the console page");
writeFileSync(join(OUT, "index.html"), page);
for (const asset of readdirSync("apps/console/public").filter((f) => f !== "index.html")) copyFileSync(join("apps/console/public", asset), join(OUT, asset));
console.log(`replay written to ${OUT}/ (${snapshotDate})`);
