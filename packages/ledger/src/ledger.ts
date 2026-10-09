import { randomUUID } from "node:crypto";
import type { Asset, CorridorCode, Money, Venue } from "@corridor/core";
import { SCHEMA } from "./schema.ts";

/** Minimal SQL surface satisfied by PGlite (dev/test) and a node-postgres adapter (prod). */
export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Db extends Sql {
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
}

export type AccountType = "asset" | "liability" | "revenue" | "expense" | "clearing" | "equity";

export interface AccountSpec {
  type: AccountType;
  ownerType: string;
  ownerId: string;
  corridor?: CorridorCode;
  asset: Asset;
  venue: Venue;
  /** Enforced at post time: the account's natural balance may never go below zero. */
  noOverdraft?: boolean;
}

export type Direction = "D" | "C";

export interface PostingLine {
  account: string;
  direction: Direction;
  money: Money;
}

export interface EntryInput {
  kind: string;
  lines: PostingLine[];
  /** Corridor Reference (hex) linking this entry across chains. */
  reference?: string;
  sagaId?: string;
  /**
   * Identity of the movement: an on-chain / partner venue, or "internal" for
   * ledger-only bookings keyed by a saga idempotency key. Booking is idempotent on it.
   */
  external?: { venue: Venue | "internal"; ref: string };
  metadata?: Record<string, unknown>;
  /**
   * Runs first inside the posting transaction; throwing aborts the entry. The
   * saga engine uses it to check its fencing token, so a worker whose lease
   * expired can never commit a booking.
   */
  precondition?: (tx: Sql) => Promise<void>;
}

export interface PostResult {
  entryId: string;
  /** True when this external movement was already booked; nothing was written. */
  duplicate: boolean;
}

export class LedgerError extends Error {}

const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set(["asset", "expense", "clearing"]);

export function accountId(s: Omit<AccountSpec, "noOverdraft">): string {
  return [s.type, s.ownerType, s.ownerId, s.corridor ?? "*", s.asset, s.venue].join(":");
}

export class Ledger {
  private constructor(private readonly db: Db) {}

  static async open(db: Db): Promise<Ledger> {
    await db.exec(SCHEMA);
    return new Ledger(db);
  }

  async openAccount(spec: AccountSpec): Promise<string> {
    const id = accountId(spec);
    await this.db.transaction(async (tx) => {
      await tx.query(
        `insert into accounts (id, type, owner_type, owner_id, corridor, asset, venue, no_overdraft)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict (id) do nothing`,
        [id, spec.type, spec.ownerType, spec.ownerId, spec.corridor ?? null, spec.asset, spec.venue, spec.noOverdraft ?? false],
      );
      await tx.query(`insert into balances (account_id, asset) values ($1,$2) on conflict do nothing`, [id, spec.asset]);
    });
    return id;
  }

  async post(input: EntryInput): Promise<PostResult> {
    assertBalanced(input.lines);

    if (input.external) {
      const existing = await this.findExternal(this.db, input.external);
      if (existing) return { entryId: existing, duplicate: true };
    }

    try {
      return await this.db.transaction(async (tx) => {
        if (input.precondition) await input.precondition(tx);
        const entryId = randomUUID();
        await tx.query(
          `insert into journal_entries (id, kind, saga_id, reference, external_venue, external_ref, metadata)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [
            entryId,
            input.kind,
            input.sagaId ?? null,
            input.reference ?? null,
            input.external?.venue ?? null,
            input.external?.ref ?? null,
            JSON.stringify(input.metadata ?? {}),
          ],
        );

        // Lock touched balance rows in a stable order to avoid deadlocks.
        const ids = [...new Set(input.lines.map((l) => l.account))].sort();
        const { rows } = await tx.query<{ id: string; type: AccountType; asset: string; no_overdraft: boolean }>(
          `select a.id, a.type, a.asset, a.no_overdraft
             from accounts a join balances b on b.account_id = a.id
            where a.id = any($1::text[]) order by a.id for update of b`,
          [ids],
        );
        const accounts = new Map(rows.map((r) => [r.id, r]));

        for (const line of input.lines) {
          const acct = accounts.get(line.account);
          if (!acct) throw new LedgerError(`unknown account ${line.account}`);
          if (acct.asset !== line.money.asset) {
            throw new LedgerError(`account ${line.account} holds ${acct.asset}, posting is ${line.money.asset}`);
          }
          await tx.query(
            `insert into postings (entry_id, account_id, asset, direction, amount) values ($1,$2,$3,$4,$5)`,
            [entryId, line.account, line.money.asset, line.direction, line.money.amount.toString()],
          );
          const col = line.direction === "D" ? "debits" : "credits";
          await tx.query(`update balances set ${col} = ${col} + $2::numeric where account_id = $1`, [
            line.account,
            line.money.amount.toString(),
          ]);
        }

        for (const acct of accounts.values()) {
          if (!acct.no_overdraft) continue;
          const bal = await naturalBalance(tx, acct.id, acct.type);
          if (bal < 0n) throw new LedgerError(`insufficient funds: ${acct.id} would be ${bal}`);
        }
        return { entryId, duplicate: false };
      });
    } catch (err) {
      // Two workers observed the same on-chain event: the unique index decides the winner.
      if (input.external && isUniqueViolation(err)) {
        const existing = await this.findExternal(this.db, input.external);
        if (existing) return { entryId: existing, duplicate: true };
      }
      throw err;
    }
  }

  /** Natural balance: debit-normal for assets/expenses/clearing, credit-normal otherwise. */
  async balance(account: string): Promise<Money> {
    const { rows } = await this.db.query<{ type: AccountType; asset: Asset }>(
      `select type, asset from accounts where id = $1`,
      [account],
    );
    const acct = rows[0];
    if (!acct) throw new LedgerError(`unknown account ${account}`);
    return { asset: acct.asset, amount: await naturalBalance(this.db, account, acct.type) };
  }

  async entriesByReference(reference: string) {
    const { rows } = await this.db.query<{ id: string; kind: string; external_venue: string | null; external_ref: string | null }>(
      `select id, kind, external_venue, external_ref from journal_entries where reference = $1 order by created_at`,
      [reference],
    );
    return rows;
  }

  /**
   * Global invariants, run in tests and by a nightly job:
   *  1. every entry balances per asset;
   *  2. the balance projection equals a full recompute from postings.
   */
  async checkInvariants(): Promise<string[]> {
    const problems: string[] = [];
    const unbalanced = await this.db.query<{ entry_id: string; asset: string }>(
      `select entry_id, asset from postings group by entry_id, asset
       having sum(case when direction = 'D' then amount else -amount end) <> 0`,
    );
    for (const r of unbalanced.rows) problems.push(`entry ${r.entry_id} unbalanced in ${r.asset}`);

    const drift = await this.db.query<{ account_id: string }>(
      `select b.account_id from balances b
         left join (select account_id,
                           sum(case when direction='D' then amount else 0 end) d,
                           sum(case when direction='C' then amount else 0 end) c
                      from postings group by account_id) p on p.account_id = b.account_id
        where b.debits <> coalesce(p.d, 0) or b.credits <> coalesce(p.c, 0)`,
    );
    for (const r of drift.rows) problems.push(`projection drift on ${r.account_id}`);
    return problems;
  }

  /** Sum of debits in `asset` on an entry: the amount the entry moved in that asset. */
  async entryTotal(entryId: string, asset: Asset): Promise<bigint> {
    const { rows } = await this.db.query<{ total: string | null }>(
      `select sum(amount)::text total from postings where entry_id = $1 and asset = $2 and direction = 'D'`,
      [entryId, asset],
    );
    return BigInt(rows[0]?.total ?? "0");
  }

  /** Entry id already booked for this external movement, if any. */
  async findByExternal(venue: Venue | "internal", ref: string): Promise<string | undefined> {
    return this.findExternal(this.db, { venue, ref });
  }

  private async findExternal(sql: Sql, ext: { venue: Venue | "internal"; ref: string }): Promise<string | undefined> {
    const { rows } = await sql.query<{ id: string }>(
      `select id from journal_entries where external_venue = $1 and external_ref = $2`,
      [ext.venue, ext.ref],
    );
    return rows[0]?.id;
  }
}

function assertBalanced(lines: PostingLine[]): void {
  if (lines.length < 2) throw new LedgerError("an entry needs at least two postings");
  const net = new Map<string, bigint>();
  for (const l of lines) {
    if (l.money.amount <= 0n) throw new LedgerError("posting amounts must be positive");
    const signed = l.direction === "D" ? l.money.amount : -l.money.amount;
    net.set(l.money.asset, (net.get(l.money.asset) ?? 0n) + signed);
  }
  for (const [asset, n] of net) {
    if (n !== 0n) throw new LedgerError(`entry does not balance in ${asset} (net ${n})`);
  }
}

async function naturalBalance(sql: Sql, account: string, type: AccountType): Promise<bigint> {
  const { rows } = await sql.query<{ d: string; c: string }>(
    `select debits::text d, credits::text c from balances where account_id = $1`,
    [account],
  );
  const r = rows[0];
  if (!r) throw new LedgerError(`no balance row for ${account}`);
  const d = BigInt(r.d);
  const c = BigInt(r.c);
  return DEBIT_NORMAL.has(type) ? d - c : c - d;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
