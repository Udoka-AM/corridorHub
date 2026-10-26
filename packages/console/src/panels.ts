import type { Db } from "@corridor/ledger";

/**
 * The treasury console's reads.
 *
 * Every panel is one query against the ledger and the saga tables, and
 * nothing here writes: the console is a window on the engines, not a second
 * source of truth (ADR 0011). They live in a package rather than in the
 * server so they can be tested against a real ledger with real postings,
 * which is the only way to catch a balance read the wrong way round.
 *
 * Direction matters. `asset`, `expense` and `clearing` accounts are
 * debit-normal, so their balance is debits − credits; `liability`, `revenue`
 * and `equity` are the other way about. Reading a customer's balance as
 * debit-normal would report what Corridor owes as a negative number.
 */

const DEBIT_NORMAL = new Set(["asset", "expense", "clearing"]);

function signed(type: string, debits: string, credits: string): bigint {
  const d = BigInt(debits);
  const c = BigInt(credits);
  return DEBIT_NORMAL.has(type) ? d - c : c - d;
}

interface BalanceRow {
  type: string;
  owner_type: string;
  owner_id: string;
  corridor: string | null;
  asset: string;
  venue: string;
  debits: string;
  credits: string;
}

const BALANCES = `
  select a.type, a.owner_type, a.owner_id, a.corridor, a.asset, a.venue, b.debits, b.credits
    from accounts a join balances b on b.account_id = a.id
`;

export interface CorridorRow {
  customerId: string;
  corridor: string;
  asset: string;
  venue: string;
  /** What Corridor owes the customer and they may spend, in the asset's minor units. */
  available: string;
  /** Of that, held against an in-flight payout. */
  held: string;
}

/**
 * The corridor board: what each customer holds, per corridor and asset, and
 * how much of it is committed to a payout that has not finished.
 *
 * Available and held are separate accounts, so a payout in flight shows as
 * both — the money has left `available` without leaving Corridor.
 */
export async function corridorBoard(db: Db): Promise<CorridorRow[]> {
  const { rows } = await db.query<BalanceRow>(`${BALANCES} where a.owner_type in ('customer','customer_hold')`);
  const out = new Map<string, CorridorRow>();
  for (const r of rows) {
    const key = [r.owner_id, r.corridor ?? "*", r.asset, r.venue].join("|");
    const row =
      out.get(key) ??
      { customerId: r.owner_id, corridor: r.corridor ?? "*", asset: r.asset, venue: r.venue, available: "0", held: "0" };
    const amount = signed(r.type, r.debits, r.credits);
    if (r.owner_type === "customer_hold") row.held = (BigInt(row.held) + amount).toString();
    else row.available = (BigInt(row.available) + amount).toString();
    out.set(key, row);
  }
  return [...out.values()].sort((a, b) => a.customerId.localeCompare(b.customerId) || a.asset.localeCompare(b.asset));
}

export interface VenueRow {
  venue: string;
  asset: string;
  /** Real funds Corridor controls on that venue. */
  vaults: { name: string; balance: string }[];
  /** Total across the vaults. */
  total: string;
}

export interface ClearingRow {
  name: string;
  asset: string;
  /** Per-venue legs of the pair. */
  legs: { venue: string; balance: string }[];
  /** The pair's sum. Anything other than zero is money in transit or a bug. */
  net: string;
}

/**
 * Venue balances, and the clearing pairs that should net to zero.
 *
 * A clearing pair is opened by the leg that moves money between two venues
 * and closed by the leg that completes it, so a non-zero net is either a
 * transfer still in flight or an entry that never got its other half. The
 * console shows the number rather than hiding it behind a tick.
 */
export async function venueBalances(db: Db): Promise<{ venues: VenueRow[]; clearing: ClearingRow[] }> {
  const { rows } = await db.query<BalanceRow>(`${BALANCES} where a.type in ('asset','clearing')`);
  const venues = new Map<string, VenueRow>();
  const clearing = new Map<string, ClearingRow>();
  for (const r of rows) {
    const balance = signed(r.type, r.debits, r.credits);
    if (r.type === "clearing") {
      const key = `${r.owner_id}|${r.asset}`;
      const row = clearing.get(key) ?? { name: r.owner_id, asset: r.asset, legs: [], net: "0" };
      row.legs.push({ venue: r.venue, balance: balance.toString() });
      row.net = (BigInt(row.net) + balance).toString();
      clearing.set(key, row);
      continue;
    }
    const key = `${r.venue}|${r.asset}`;
    const row = venues.get(key) ?? { venue: r.venue, asset: r.asset, vaults: [], total: "0" };
    row.vaults.push({ name: r.owner_id, balance: balance.toString() });
    row.total = (BigInt(row.total) + balance).toString();
    venues.set(key, row);
  }
  const byName = <T extends { asset: string }>(a: T & { venue?: string; name?: string }, b: T & { venue?: string; name?: string }) =>
    (a.venue ?? a.name ?? "").localeCompare(b.venue ?? b.name ?? "") || a.asset.localeCompare(b.asset);
  return { venues: [...venues.values()].sort(byName), clearing: [...clearing.values()].sort(byName) };
}

export interface TimelineStep {
  idx: number;
  kind: string;
  status: string;
  attempts: number;
  error: string | null;
  /** The on-chain transaction the step produced, when it made one. */
  txHash?: string;
}

export interface TimelineRow {
  sagaId: string;
  kind: string;
  reference: string | null;
  status: string;
  updatedAt: string;
  steps: TimelineStep[];
}

/** Transaction-shaped fields a leg's output may carry, in the order a step is most likely to name them. */
const TX_FIELDS = ["txHash", "burnTx", "mintTx", "solanaTx", "paymentTx", "hash"] as const;

function txOf(output: unknown): string | undefined {
  if (!output || typeof output !== "object") return undefined;
  const o = output as Record<string, unknown>;
  for (const f of TX_FIELDS) if (typeof o[f] === "string" && o[f]) return o[f] as string;
  return undefined;
}

/**
 * The settlement timeline: recent sagas and the steps they ran.
 *
 * Each step carries the transaction it produced where it made one, so a
 * reviewer can follow a payout from the ledger to the chain and back without
 * being asked to trust the console.
 */
export async function settlementTimeline(db: Db, limit = 25): Promise<TimelineRow[]> {
  const { rows: sagas } = await db.query<{ id: string; kind: string; reference: string | null; status: string; updated_at: Date }>(
    `select id, kind, reference, status, updated_at from sagas order by updated_at desc limit $1`,
    [limit],
  );
  if (sagas.length === 0) return [];
  const ids = sagas.map((s) => s.id);
  const { rows: steps } = await db.query<{
    saga_id: string;
    idx: number;
    kind: string;
    status: string;
    attempts: number;
    output: unknown;
    error: string | null;
  }>(
    `select saga_id, idx, kind, status, attempts, output, error from saga_steps
      where saga_id = any($1) order by saga_id, idx`,
    [ids],
  );
  const byId = new Map<string, TimelineStep[]>();
  for (const s of steps) {
    const list = byId.get(s.saga_id) ?? [];
    list.push({ idx: s.idx, kind: s.kind, status: s.status, attempts: s.attempts, error: s.error, txHash: txOf(s.output) });
    byId.set(s.saga_id, list);
  }
  return sagas.map((s) => ({
    sagaId: s.id,
    kind: s.kind,
    reference: s.reference,
    status: s.status,
    updatedAt: new Date(s.updated_at).toISOString(),
    steps: byId.get(s.id) ?? [],
  }));
}

export interface ExceptionRow {
  sagaId: string;
  sagaKind: string;
  sagaStatus: string;
  reference: string | null;
  stepIdx: number | null;
  stepKind: string | null;
  stepStatus: string | null;
  attempts: number | null;
  error: string | null;
  updatedAt: string;
}

/**
 * The exceptions queue: everything that stopped and needs a person.
 *
 * A saga in `manual_review` is the deliberate stop — a leg found something it
 * refused to decide, such as an anchor taking more than was quoted. A failed
 * or `compensation_failed` step is the other kind: an undo that did not
 * finish, which is the one that leaves money somewhere it should not be, so
 * it sorts first.
 */
export async function exceptionsQueue(db: Db, limit = 50): Promise<ExceptionRow[]> {
  const { rows } = await db.query<{
    id: string;
    kind: string;
    status: string;
    reference: string | null;
    idx: number | null;
    step_kind: string | null;
    step_status: string | null;
    attempts: number | null;
    error: string | null;
    updated_at: Date;
  }>(
    `select s.id, s.kind, s.status, s.reference,
            st.idx, st.kind as step_kind, st.status as step_status, st.attempts, st.error,
            coalesce(st.updated_at, s.updated_at) as updated_at
       from sagas s
       left join saga_steps st
         on st.saga_id = s.id and st.status in ('failed','compensation_failed')
      where s.status in ('manual_review','compensating','compensated')
         or st.idx is not null
      order by case when st.status = 'compensation_failed' then 0
                    when s.status = 'manual_review' then 1
                    else 2 end,
               updated_at desc
      limit $1`,
    [limit],
  );
  return rows.map((r) => ({
    sagaId: r.id,
    sagaKind: r.kind,
    sagaStatus: r.status,
    reference: r.reference,
    stepIdx: r.idx,
    stepKind: r.step_kind,
    stepStatus: r.step_status,
    attempts: r.attempts,
    error: r.error,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

export interface FeeRow {
  name: string;
  asset: string;
  venue: string;
  booked: string;
}

/** Fees Corridor has actually booked, from the revenue accounts. */
export async function bookedFees(db: Db): Promise<FeeRow[]> {
  const { rows } = await db.query<BalanceRow>(`${BALANCES} where a.type = 'revenue'`);
  return rows
    .map((r) => ({ name: r.owner_id, asset: r.asset, venue: r.venue, booked: signed(r.type, r.debits, r.credits).toString() }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.asset.localeCompare(b.asset));
}

export interface ForecastRow {
  customerId: string;
  asset: string;
  /** What left this customer's balance over the window, in minor units. */
  outflow: string;
  /** The daily average over the window. */
  perDay: string;
  /** What the customer still has available. */
  available: string;
  /** Days of cover at that rate, or null when nothing has moved yet. */
  daysOfCover: number | null;
}

/**
 * Pre-funding forecast: what each customer has been spending per day, and how
 * long their balance covers it.
 *
 * Outflow is read from the postings, not from the sagas, so a payout that
 * moved money without finishing still counts. `daysOfCover` is null rather
 * than infinite when nothing has moved — a customer who has not paid out yet
 * has no rate to forecast from, and showing them as well funded would be a
 * guess dressed as a number.
 */
export interface ForecastOptions {
  /** How many days of postings the rate is averaged over. Default 7. */
  days?: number;
  /** The window's end. Injectable because the journal is append-only, so a test cannot backdate an entry to move it out of range. */
  now?: Date;
}

export async function fundingForecast(db: Db, opts: ForecastOptions = {}): Promise<ForecastRow[]> {
  const days = opts.days ?? 7;
  const { rows } = await db.query<{ owner_id: string; asset: string; outflow: string }>(
    `select a.owner_id, a.asset, coalesce(sum(p.amount), 0) as outflow
       from postings p
       join accounts a on a.id = p.account_id
       join journal_entries e on e.id = p.entry_id
      where a.owner_type = 'customer' and p.direction = 'D'
        and e.created_at > $2::timestamptz - ($1 || ' days')::interval
        and e.created_at <= $2::timestamptz
      group by a.owner_id, a.asset`,
    [String(days), (opts.now ?? new Date()).toISOString()],
  );
  const board = await corridorBoard(db);
  const available = new Map<string, bigint>();
  for (const b of board) {
    available.set(`${b.customerId}|${b.asset}`, (available.get(`${b.customerId}|${b.asset}`) ?? 0n) + BigInt(b.available));
  }
  const seen = new Map<string, ForecastRow>();
  const put = (customerId: string, asset: string, outflow: bigint) => {
    const perDay = outflow / BigInt(days);
    const have = available.get(`${customerId}|${asset}`) ?? 0n;
    seen.set(`${customerId}|${asset}`, {
      customerId,
      asset,
      outflow: outflow.toString(),
      perDay: perDay.toString(),
      available: have.toString(),
      daysOfCover: perDay > 0n ? Number(have / perDay) : null,
    });
  };
  for (const r of rows) put(r.owner_id, r.asset, BigInt(r.outflow));
  // A customer holding a balance but spending nothing still belongs on the
  // board; they simply have no rate to forecast from.
  for (const b of board) {
    if (!seen.has(`${b.customerId}|${b.asset}`)) put(b.customerId, b.asset, 0n);
  }
  return [...seen.values()].sort((a, b) => a.customerId.localeCompare(b.customerId) || a.asset.localeCompare(b.asset));
}
