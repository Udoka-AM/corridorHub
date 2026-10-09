/**
 * Corridor treasury console.
 *
 *   pnpm console        # http://localhost:4400
 *
 * One process owns the ledger and the runtime (Tempo Moderato vaults, partner
 * webhooks, saga engine), serves a JSON API and the dashboard, and runs demo
 * flows on request. Stop CLI demos before starting it: the embedded Postgres
 * has a single owner.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatMoney, fromZcashMemo, parseCorridor, type Asset, type CorridorCode, type Fiat, type Observation } from "@corridor/core";
import { EXPLORER, FEE_MANAGER, TempoObserver, balanceOf, firstFundedBlock } from "@corridor/chain-tempo";
import { ZcashWallet, formatZec, shieldedObservations } from "@corridor/chain-zcash";
import { SOLANA_ACCOUNT_RENT, SOLANA_FEES, SolanaWatcher } from "@corridor/chain-solana";
import { bookVaultMovements, checkVaults, reconcile, summarize, type VaultCheck, type VaultRef } from "@corridor/recon";
import { COLLECTION_CURRENCIES, PAYOUT_CURRENCIES, planRoute } from "@corridor/routing";
import type { PartnerOrder } from "@corridor/partners";
import { PgCursorStore } from "@corridor/recon";
import { partnerObservation } from "@corridor/webhooks";
import { startRuntime } from "../../../scripts/runtime.ts";
import { collect, payout, prefund, shieldedBatch } from "../../../scripts/flows.ts";
import { runWatch } from "../../../scripts/watch.ts";
import { exceptions, summarizeReadOnly } from "@corridor/recon";

const PORT = Number(process.env.PORT ?? 4400);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEVTOOL = process.env.ZCASH_DEVTOOL ?? "/Users/udoka/Wfiar/tools/zcash-devtool/target/release/zcash-devtool";

const rt = await startRuntime({
  onCollectionOpened: async (order, mock) => {
    // Testnet stand-in for the importer paying from their bank app.
    setTimeout(() => void mock.payerTransferred(order.id), 4_000);
  },
});
const db = rt.db;
const suppliersWallet = existsSync(".data/zcash-testnet-suppliers/data.sqlite")
  ? new ZcashWallet({ bin: DEVTOOL, walletDir: ".data/zcash-testnet-suppliers" })
  : undefined;
const SUPPLIERS = suppliersWallet
  ? [
      { name: "Shenzhen Brightline Electronics", account: "supplier-shenzhen" },
      { name: "Kowloon Precision Parts", account: "supplier-hongkong" },
      { name: "Lagos contractor (logistics)", account: "contractor-lagos" },
    ].map((s) => ({ name: s.name, address: suppliersWallet.defaultAddress(suppliersWallet.account(s.account).uuid) }))
  : [];

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

type Row = Record<string, any>;
const q = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const natural = (type: string, d: string, c: string) =>
  ["asset", "expense", "clearing"].includes(type) ? BigInt(d) - BigInt(c) : BigInt(c) - BigInt(d);
const fmt = (asset: string, amount: bigint) => {
  const [num, unit] = formatMoney({ asset: asset as Asset, amount }).split(" ");
  const [whole, frac] = num!.split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${frac ? "." + frac : ""} ${unit}`;
};

async function overview() {
  const rows = await q(
    `select a.id, a.type, a.owner_type, a.owner_id, a.corridor, a.asset, a.venue, b.debits::text d, b.credits::text c
       from accounts a join balances b on b.account_id = a.id order by a.id`,
  );
  const accounts: Row[] = rows.map((r) => ({ ...r, balance: natural(r.type, r.d, r.c) }));

  const customers = new Map<string, Row>();
  for (const a of accounts.filter((x) => x.owner_type === "customer" || x.owner_type === "customer_hold")) {
    const key = `${a.owner_id}|${a.corridor}|${a.asset}|${a.venue}`;
    const c = customers.get(key) ?? { customer: a.owner_id, corridor: a.corridor, asset: a.asset, venue: a.venue, available: 0n, held: 0n };
    if (a.owner_type === "customer") c.available += a.balance;
    else c.held += a.balance;
    customers.set(key, c);
  }

  const vaults = accounts
    .filter((a) => a.owner_type === "vault")
    .map((a) => ({ name: a.owner_id, venue: a.venue, asset: a.asset, balance: fmt(a.asset, a.balance), raw: a.balance.toString() }));
  const clearing = accounts
    .filter((a) => a.type === "clearing")
    .map((a) => ({ name: a.owner_id, venue: a.venue, asset: a.asset, balance: fmt(a.asset, a.balance) }));

  const hubTotal = accounts
    .filter((a) => a.owner_type === "customer" && a.venue === "tempo")
    .reduce((s, a) => s + a.balance, 0n);
  const inFlight = accounts.filter((a) => a.owner_type === "customer_hold").reduce((s, a) => s + a.balance, 0n);
  const sagaCounts = await q(`select status, count(*)::int n from sagas group by status`);
  const settled = await q(
    `select coalesce(sum(p.amount), 0)::text total from postings p join journal_entries e on e.id = p.entry_id
      where e.kind = 'partner.payout' and p.asset = 'USDC' and p.direction = 'D'`,
  );

  return {
    network: { tempo: "Tempo Moderato testnet", solana: "Solana devnet", zcash: "Zcash testnet · Ironwood", partner: "Paj-shaped partner (mock)" },
    kpis: {
      hubBalance: fmt("pathUSD", hubTotal),
      inFlight: fmt("pathUSD", inFlight),
      settled: fmt("USDC", BigInt(settled[0]?.total ?? "0")),
      sagas: Object.fromEntries(sagaCounts.map((r) => [r.status, r.n])),
    },
    customers: [...customers.values()].map((c) => ({
      ...c,
      available: fmt(c.asset, c.available),
      held: fmt(c.asset, c.held),
    })),
    vaults,
    clearing,
    invariants: await rt.ledger.checkInvariants(),
  };
}

function explorerFor(kind: string, output: Row | null): { label: string; url: string }[] {
  if (!output) return [];
  const links: { label: string; url: string }[] = [];
  for (const k of ["tempoMove", "tempoRefund", "tempoDeposit"]) {
    if (typeof output[k] === "string") links.push({ label: "Tempo tx", url: `${EXPLORER.moderato}/tx/${output[k].split(":")[0]}` });
  }
  if (typeof output.deliveryTx === "string") {
    links.push({ label: "ZEC delivery", url: `https://testnet.zcashexplorer.app/transactions/${output.deliveryTx}` });
  }
  if (typeof output.explorer === "string") links.push({ label: "Shielded batch", url: output.explorer });
  if (typeof output.fundingRef === "string" && !output.fundingRef.startsWith("sim:")) {
    links.push({ label: "Solana funding", url: `https://explorer.solana.com/tx/${output.fundingRef}?cluster=devnet` });
  }
  void kind;
  return links;
}

async function sagas(limit = 25) {
  const list = await q(`select id, kind, reference, status, input, created_at from sagas order by created_at desc limit $1`, [limit]);
  const out = [];
  for (const s of list) {
    const steps = await q(`select idx, kind, status, attempts, output, error from saga_steps where saga_id = $1 order by idx`, [s.id]);
    const events = await q(`select idx, event, detail, at from saga_events where saga_id = $1 order by id`, [s.id]);
    const data = s.input.data ?? {};
    const refunds = events
      .filter((e: Row) => e.event === "compensated" && e.detail?.includes("tempoRefund"))
      .map((e: Row) => `${EXPLORER.moderato}/tx/${JSON.parse(e.detail).tempoRefund.split(":")[0]}`);
    out.push({
      id: s.id,
      kind: s.kind,
      status: s.status,
      createdAt: s.created_at,
      corridor: data.corridor,
      customer: data.customerId,
      amount: data.amount ? fmt("pathUSD", BigInt(data.amount)) : data.fiatAmount ? fmt(data.currency, BigInt(data.fiatAmount)) : null,
      recipient: data.recipient?.name ?? (data.recipient?.items ? `${data.recipient.items.length} recipients (shielded)` : null),
      route: s.input.plan.steps.map((p: Row) => `${p.kind}`),
      steps: steps.map((st: Row) => ({ ...st, links: explorerFor(st.kind, st.output) })),
      refunds,
    });
  }
  return out;
}

// Observations accumulate across polls: the Tempo observer only reports what is new since its cursor.
const seen = new Map<string, Observation>();
const firstBlock = (
  await q<{ b: string | null }>(`select min((input->'data'->>'tempoStartBlock')::numeric)::text b from sagas`)
)[0]?.b;
const consoleObserver = new TempoObserver(rt.treasury, {
  name: `console-${Date.now()}`,
  asset: "pathUSD",
  addresses: [rt.treasury.account.address, rt.escrow.account.address],
  cursors: await PgCursorStore.open(db),
  startBlock: firstBlock ? BigInt(firstBlock) : rt.startBlock,
});

// Vault accounting: replay each Tempo vault's whole history (faucet funding,
// gas) so its on-chain balance can be checked against the ledger.
const TEMPO_VAULTS: VaultRef[] = [{ name: "treasury", address: rt.treasury.account.address, asset: "pathUSD", venue: "tempo" }];
// Testnet faucet funding arrives as mints from the zero address; on mainnet list the owner's top-up wallets.
const FUNDING_SOURCES = ["0x0000000000000000000000000000000000000000", ...(process.env.CORRIDOR_FUNDING_SOURCES ?? "").split(",").filter(Boolean)];
const vaultSince = (await firstFundedBlock(rt.treasury, "pathUSD", rt.treasury.account.address)) ?? rt.startBlock;
const vaultObserver = new TempoObserver(rt.treasury, {
  name: `console-vaults-${Date.now()}`,
  asset: "pathUSD",
  addresses: TEMPO_VAULTS.map((v) => v.address as `0x${string}`),
  cursors: await PgCursorStore.open(db),
  startBlock: vaultSince,
  maxRange: 100_000n,
  unreferenced: true,
});

// Solana vault: network fees and account rent are paid in SOL and booked from
// each transaction the vault signed, like Tempo gas. Devnet SOL comes from the
// faucet; on mainnet list the owner's top-up wallets.
const SOLANA_VAULTS: VaultRef[] = rt.solana ? [{ name: "solana", address: rt.solana.address, asset: "SOL", venue: "solana" }] : [];
const SOLANA_FUNDING = ["dev2JBjyB5CshoGsiJCwzdmJYiEUwAXMdqDR7txoFBJ", ...(process.env.SOLANA_FUNDING_SOURCES ?? "").split(",").filter(Boolean)];
let solanaCache: { at: number; checks: VaultCheck[] } | undefined;
async function solanaVaultAccounting(): Promise<VaultCheck[]> {
  if (!SOLANA_VAULTS.length) return [];
  if (solanaCache && Date.now() - solanaCache.at < 5 * 60_000) return solanaCache.checks;
  const watcher = new SolanaWatcher(SOLANA_VAULTS[0]!.address, "devnet");
  const movements = (await watcher.history({ native: true })).filter((o) => o.asset === "SOL");
  const booked = await bookVaultMovements(rt.ledger, rt.accounts, movements, {
    vaults: SOLANA_VAULTS,
    fundingSources: SOLANA_FUNDING,
    feeCollector: SOLANA_FEES,
    expenses: { [SOLANA_ACCOUNT_RENT]: "account-rent" },
  });
  for (const f of booked.failed) console.warn(`solana vault booking pending for ${f.externalRef}: ${f.error}`);
  const checks = await checkVaults(rt.accounts, rt.ledger, [{ ...SOLANA_VAULTS[0]!, onchain: await watcher.nativeBalance() }]);
  solanaCache = { at: Date.now(), checks };
  return checks;
}

/** Partner orders as last reported by their (verified) webhooks; survives restarts. */
async function partnerObservations(): Promise<Observation[]> {
  const rows = await q<{ body: Row }>(`select body from partner_events where status = 'completed'`);
  return rows
    .map(({ body }) =>
      partnerObservation({ ...body, usdcAmount: BigInt(body.usdcAmount), fiatAmount: BigInt(body.fiatAmount), createdAt: new Date(body.createdAt) } as PartnerOrder),
    )
    .filter((o): o is Observation => o !== null);
}

/** Shielded payouts as the vault wallets can decrypt them (the same data an auditor's viewing key yields). */
function zcashObservations(): Observation[] {
  const walletDir = ".data/zcash-testnet";
  if (!existsSync(`${walletDir}/data.sqlite`)) return [];
  const outputs = new ZcashWallet({ bin: DEVTOOL, walletDir }).outputs().filter((o) => o.fromAccount);
  return shieldedObservations(outputs).filter((o) => o.reference);
}

async function reconciliation() {
  for (const o of [...(await consoleObserver.poll()), ...(await vaultObserver.poll())]) seen.set(o.externalRef, o);
  const booked = await bookVaultMovements(rt.ledger, rt.accounts, [...seen.values()], {
    vaults: TEMPO_VAULTS,
    fundingSources: FUNDING_SOURCES,
    feeCollector: FEE_MANAGER,
  });
  for (const f of booked.failed) console.warn(`vault booking pending for ${f.externalRef}: ${f.error}`);
  const all = [...seen.values(), ...(await partnerObservations()), ...zcashObservations()];
  const results = await reconcile(rt.ledger, all);
  const vaults = [
    ...(await checkVaults(
      rt.accounts,
      rt.ledger,
      await Promise.all(TEMPO_VAULTS.map(async (v) => ({ ...v, onchain: await balanceOf(rt.treasury, v.asset, v.address as `0x${string}`) }))),
    )),
    ...(await solanaVaultAccounting()),
  ];
  const gas = (await rt.ledger.balance(await rt.accounts.expense("gas", "pathUSD", "tempo"))).amount;
  const gasTxs = (await q<{ n: number }>(`select count(*)::int n from journal_entries where kind = 'gas' and external_venue = 'tempo'`))[0]?.n ?? 0;
  const solGas = (await rt.ledger.balance(await rt.accounts.expense("gas", "SOL", "solana"))).amount;
  const solRent = (await rt.ledger.balance(await rt.accounts.expense("account-rent", "SOL", "solana"))).amount;
  const solTxs = (await q<{ n: number }>(`select count(*)::int n from journal_entries where kind = 'gas' and external_venue = 'solana'`))[0]?.n ?? 0;
  return {
    vaults: vaults.map((v) => ({ ...v, onchain: fmt(v.asset, v.onchain), ledger: fmt(v.asset, v.ledger), diff: fmt(v.asset, v.diff < 0n ? -v.diff : v.diff), short: v.diff < 0n })),
    gas: { total: fmt("pathUSD", gas), transactions: gasTxs },
    solanaGas: SOLANA_VAULTS.length ? { fees: fmt("SOL", solGas), rent: fmt("SOL", solRent), transactions: solTxs } : null,
    summary: summarize(results),
    byVenue: Object.fromEntries(
      ["tempo", "partner_fiat", "zcash_ironwood"].map((v) => [v, summarize(results.filter((r) => r.observation.venue === v))]),
    ),
    rows: results.slice(-40).map((r) => ({
      status: r.status,
      venue: r.observation.venue,
      ref: r.observation.externalRef,
      amount: fmt(r.observation.asset, r.observation.amount),
      reference: r.observation.reference,
    })),
  };
}

function shielded() {
  const publicInfo = ".keys/frost-treasury/public.json";
  const vault = existsSync(publicInfo) ? JSON.parse(readFileSync(publicInfo, "utf8")) : null;
  const walletDir = ".data/zcash-testnet";
  if (!existsSync(`${walletDir}/data.sqlite`)) return { vault: null, batches: [] };
  const wallet = new ZcashWallet({ bin: DEVTOOL, walletDir });
  const outputs = wallet.outputs();
  // The FROST vault is the account whose UFVK is the threshold group key's and which holds no spending key.
  const zdb = new DatabaseSync(`${walletDir}/data.sqlite`, { readOnly: true });
  const frostRow = vault
    ? (zdb.prepare(`select lower(hex(uuid)) u from accounts where ufvk = ? and has_spend_key = 0`).get(vault.ufvk) as { u: string } | undefined)
    : undefined;
  zdb.close();
  const frostUuid = frostRow ? frostRow.u.replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5") : undefined;
  const approvals: Record<string, Row> = {};
  if (existsSync(".data/pczt")) {
    for (const f of readdirSync(".data/pczt").filter((f) => f.endsWith(".approval.json"))) {
      approvals[f.replace(".approval.json", "")] = JSON.parse(readFileSync(`.data/pczt/${f}`, "utf8"));
    }
  }
  const byTx = new Map<string, Row[]>();
  for (const o of outputs.filter((o) => o.fromAccount && !o.isChange)) {
    const list = byTx.get(o.txid) ?? [];
    list.push(o);
    byTx.set(o.txid, list);
  }
  const batches = [...byTx.entries()]
    .map(([txid, outs]) => {
      const items = outs
        .map((o) => ({ o, memo: o.memo ? fromZcashMemo(o.memo) : null }))
        .filter((x) => x.memo);
      if (items.length === 0) return null;
      const known = outs[0]?.minedHeight;
      return {
        txid,
        explorer: `https://testnet.zcashexplorer.app/transactions/${txid}`,
        pool: outs[0]?.pool,
        minedHeight: known,
        recipients: items.length,
        total: `${formatZec(items.reduce((s, x) => s + x.o.zatoshi, 0n))} TAZ`,
        invoices: items.map((x) => x.memo!.invoiceRef),
        control: outs[0]?.fromAccount === frostUuid ? "frost" : "single-key",
        approval: approvals[txid] ? { signers: approvals[txid].approvedBy, threshold: vault?.threshold ?? 2 } : null,
      };
    })
    .filter(Boolean);
  return {
    vault: vault && { threshold: vault.threshold, signers: vault.signers, address: vault.address, groupKey: vault.group_key },
    batches,
    observations: shieldedObservations(outputs).filter((o) => o.reference).length,
  };
}

/** Disclosure package for an auditor: the vault's viewing key and what it reveals. */
function disclosure() {
  const info = JSON.parse(readFileSync(".keys/frost-treasury/public.json", "utf8"));
  return {
    scope: "acme-2026-10 vault (one customer, one period)",
    viewingKey: info.ufvk,
    reveals: "Every payout from this vault: recipients, amounts, invoice memos",
    doesNotReveal: "Any other customer or period, the treasury, or spend authority",
    howToVerify: "zcash-devtool wallet init-fvk --fvk <viewingKey> --birthday <height>; wallet sync; list-tx",
  };
}

async function forecast() {
  // Average daily payout outflow per corridor vs available hub balance.
  const flows = await q(
    `select s.input->'data'->>'corridor' corridor, s.input->'data'->>'customerId' customer,
            sum((s.input->'data'->>'amount')::numeric)::text total, min(s.created_at) since
       from sagas s where s.kind = 'payout' and s.status = 'completed'
        and not exists (select 1 from sagas c where c.kind = 'collection'
                         and c.input->'data'->>'customerId' = s.input->'data'->>'customerId')
      group by 1, 2`,
  );
  const now = Date.now();
  const rows = [];
  for (const f of flows) {
    const days = Math.max(1, (now - new Date(f.since).getTime()) / 86_400_000);
    const daily = BigInt(Math.round(Number(f.total) / days));
    const avail = await rt.ledger.balance(await rt.accounts.customer(f.customer, f.corridor as CorridorCode, "pathUSD", "tempo"));
    const need7 = daily * 7n;
    rows.push({
      customer: f.customer,
      corridor: f.corridor,
      dailyOutflow: fmt("pathUSD", daily),
      available: fmt("pathUSD", avail.amount),
      runwayDays: daily > 0n ? Number((avail.amount * 10n) / daily) / 10 : null,
      topUpFor7Days: fmt("pathUSD", need7 > avail.amount ? need7 - avail.amount : 0n),
    });
  }
  return rows;
}

function network() {
  const route = (corridor: CorridorCode, dest: Fiat, env: "mainnet" | "testnet") =>
    planRoute({ corridor, privacy: "public", source: { venue: "tempo", asset: "pathUSD" }, destination: { venue: "partner_fiat", asset: dest }, env })
      .steps.map((s) => `${s.kind}:${s.to.venue}`);
  return {
    collections: COLLECTION_CURRENCIES,
    payouts: PAYOUT_CURRENCIES,
    examples: {
      "EUR-NGN (mainnet)": route("EUR-NGN", "NGN", "mainnet"),
      "NGN-CNY (mainnet)": route("NGN-CNY", "CNY", "mainnet"),
      "EUR-NGN (testnet)": route("EUR-NGN", "NGN", "testnet"),
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const running = new Set<string>();

async function body(req: IncomingMessage): Promise<Row> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

/**
 * Read-only pilot for the demo customer: its wallets on Tempo, Solana and Base
 * matched against its payout records (examples/watch). Public RPC scans are
 * slow, so the result is cached for five minutes.
 */
const WATCH_CONFIG = process.env.CORRIDOR_WATCH ?? "examples/watch/eu-payco-demo.json";
let readOnlyCache: { at: number; body: unknown } | undefined;
async function readOnly() {
  if (readOnlyCache && Date.now() - readOnlyCache.at < 5 * 60_000) return readOnlyCache.body;
  const { config, errors, observations, records, results } = await runWatch(WATCH_CONFIG);
  const row = (r: (typeof results)[number]) => ({
    status: r.status,
    record: r.record?.id ?? null,
    venue: r.record?.venue ?? r.observation?.venue,
    asset: r.record?.asset ?? r.observation?.asset,
    expected: r.record ? formatMoney({ asset: r.record.asset, amount: r.record.amount }) : null,
    observed: r.observation ? formatMoney({ asset: r.observation.asset, amount: r.observation.amount }) : null,
    difference: r.difference === undefined ? null : r.difference.toString(),
    matchedBy: r.matchedBy ?? null,
    ref: r.observation?.externalRef ?? null,
    at: (r.observation?.observedAt ?? r.record?.createdAt)?.toISOString() ?? null,
  });
  const body = {
    customer: config.name,
    errors,
    generatedAt: new Date().toISOString(),
    observed: observations.length,
    records: records.length,
    summary: summarizeReadOnly(results),
    exceptions: exceptions(results).map(row),
    matched: results.filter((r) => r.status === "matched").map(row),
  };
  readOnlyCache = { at: Date.now(), body };
  return body;
}

function send(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
}

async function action(name: string, fn: () => Promise<unknown>) {
  if (running.has(name)) throw new Error(`${name} already running`);
  running.add(name);
  fn()
    .catch((e) => console.error(`${name} failed`, e))
    .finally(() => running.delete(name));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(ROOT, "public/index.html")));
      return;
    }
    if (req.method === "GET") {
      switch (url.pathname) {
        case "/api/overview": return send(res, 200, { ...(await overview()), running: [...running] });
        case "/api/sagas": return send(res, 200, await sagas());
        case "/api/reconciliation": return send(res, 200, await reconciliation());
        case "/api/shielded": return send(res, 200, shielded());
        case "/api/forecast": return send(res, 200, await forecast());
        case "/api/network": return send(res, 200, network());
        case "/api/approvals": return send(res, 200, await rt.approvals.list());
        case "/api/readonly": return send(res, 200, await readOnly());
      }
    }
    if (req.method === "POST") {
      const b = await body(req);
      switch (url.pathname) {
        case "/api/disclosures": return send(res, 200, disclosure());
        case "/api/approvals": {
          await rt.approvals.approve(String(b.subject), Number(b.signer));
          return send(res, 200, { approvedBy: await rt.approvals.approvedBy(String(b.subject)) });
        }
        case "/api/actions/shielded": {
          if (!rt.shielded || SUPPLIERS.length === 0) return send(res, 409, { error: "shielded lane not configured (run pnpm zcash:frost once)" });
          await action("shielded", async () => {
            const cust = "acme-imports";
            const usd = String(b.usdEach ?? "5");
            const total = Number(usd) * SUPPLIERS.length;
            const avail = await rt.ledger.balance(await rt.accounts.customer(cust, "NGN-CNY", "pathUSD", "tempo"));
            if (avail.amount < BigInt(Math.round(total * 1e6))) await prefund(rt, cust, "NGN-CNY", String(Math.max(20, total * 2)));
            const month = new Date().toISOString().slice(0, 7);
            await shieldedBatch(rt, {
              customerId: cust,
              corridor: "NGN-CNY",
              items: SUPPLIERS.map((sp, i) => ({ ...sp, usd, invoiceRef: `INV-${month}-S${String(i + 1).padStart(2, "0")}` })),
            });
          });
          return send(res, 202, { started: "shielded" });
        }
        case "/api/actions/payout": {
          const corridor = (b.corridor ?? "EUR-NGN") as CorridorCode;
          const { destination } = parseCorridor(corridor);
          await action("payout", async () => {
            const cust = b.customer ?? "eu-payco-demo";
            const avail = await rt.ledger.balance(await rt.accounts.customer(cust, corridor, "pathUSD", "tempo"));
            const amount = String(b.amount ?? "5");
            if (avail.amount < BigInt(Math.round(Number(amount) * 1e6))) await prefund(rt, cust, corridor, String(Math.max(20, Number(amount) * 2)));
            await payout(rt, {
              customerId: cust,
              corridor,
              currency: destination,
              amount,
              recipient: b.recipient ?? { bankCode: "058", accountNumber: "0123456789", name: "Ada Obi" },
              failAtPartner: Boolean(b.failAtPartner),
            });
          });
          return send(res, 202, { started: "payout" });
        }
        case "/api/actions/importer": {
          await action("importer", async () => {
            const cust = b.customer ?? "adeola-imports";
            const c = await collect(rt, { customerId: cust, corridor: "NGN-CNY", currency: "NGN", fiatAmount: String(b.fiatAmount ?? "780000") });
            if (c.status !== "completed") return;
            const bal = await rt.ledger.balance(await rt.accounts.customer(cust, "NGN-CNY", "pathUSD", "tempo"));
            await payout(rt, {
              customerId: cust,
              corridor: "NGN-CNY",
              currency: "CNY",
              amount: (Number(bal.amount) / 1e6).toString(),
              recipient: { bankCode: "CN-ICBC", accountNumber: "6222020200112233445", name: "Shenzhen Brightline Electronics" },
            });
          });
          return send(res, 202, { started: "importer" });
        }
      }
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => console.log(`Corridor treasury console: http://localhost:${PORT}`));
process.on("SIGINT", async () => {
  server.close();
  await rt.close();
  process.exit(0);
});
