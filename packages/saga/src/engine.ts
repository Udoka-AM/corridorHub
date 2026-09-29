import { randomUUID } from "node:crypto";
import type { Accounts, Db, EntryInput, Ledger } from "@corridor/ledger";
import type { LegKind, PlannedStep, RoutePlan } from "@corridor/routing";

/**
 * Durable settlement saga (carried over from Arc). Each planned step runs
 * `forward()` with retries; its ledger bookings are posted idempotently; its
 * output is persisted. If a step exhausts its retries, completed steps are
 * compensated in reverse order. A saga can be re-run after a crash and
 * resumes from the first unfinished step.
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export type SagaStatus = "running" | "completed" | "compensating" | "compensated" | "manual_review";
export type StepStatus = "pending" | "done" | "failed" | "compensated" | "compensation_failed";

/** `data` must be JSON-serialisable: it is persisted with the saga. */
export interface SagaInput<D extends object = object> {
  kind: string;
  reference?: string;
  plan: RoutePlan;
  data: D;
  /** Demo/test only: make the named leg fail without retries. */
  faults?: { failAt?: LegKind };
}

export interface LegContext<D = Record<string, Json>> {
  sagaId: string;
  step: PlannedStep;
  plan: RoutePlan;
  data: D;
  /** Stable per (saga, step). Legs use it to detect work they already did. */
  idempotencyKey: string;
  /** Outputs of earlier steps, by step index. */
  outputs: Record<number, Json>;
  accounts: Accounts;
}

export interface LegOutcome {
  output: Json;
  /** Posted to the ledger after the leg succeeds. Entries without `external` get an internal idempotency key. */
  bookings?: EntryInput[];
}

export interface Leg<D = any> {
  kind: LegKind;
  forward(ctx: LegContext<D>): Promise<LegOutcome>;
  /** Undo a completed forward. Omit for legs with nothing to undo. */
  compensate?(ctx: LegContext<D>, output: Json): Promise<LegOutcome>;
  maxAttempts?: number;
  backoffMs?: number;
}

export class FaultInjected extends Error {}

const SCHEMA = /* sql */ `
create table if not exists sagas (
  id         text primary key,
  kind       text not null,
  reference  text,
  status     text not null,
  input      jsonb not null,
  lease_owner text,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists sagas_reference on sagas (reference);

create table if not exists saga_steps (
  saga_id     text not null references sagas (id),
  idx         int not null,
  kind        text not null,
  status      text not null,
  attempts    int not null default 0,
  output      jsonb,
  error       text,
  updated_at  timestamptz not null default now(),
  primary key (saga_id, idx)
);

create table if not exists saga_events (
  id       bigserial primary key,
  saga_id  text not null references sagas (id),
  idx      int,
  event    text not null,
  detail   text,
  at       timestamptz not null default now()
);
`;

export interface SagaView {
  id: string;
  kind: string;
  reference: string | null;
  status: SagaStatus;
  steps: { idx: number; kind: LegKind; status: StepStatus; attempts: number; output: Json; error: string | null }[];
  events: { idx: number | null; event: string; detail: string | null; at: Date }[];
}

export interface EngineOptions {
  /** How long a runner owns a saga before another worker may take over (crash recovery). */
  leaseMs?: number;
}

export class SagaEngine {
  private readonly legs: Map<LegKind, Leg>;
  private readonly workerId = randomUUID();
  private readonly leaseMs: number;

  private constructor(
    private readonly db: Db,
    private readonly ledger: Ledger,
    private readonly accounts: Accounts,
    legs: Leg[],
    opts: EngineOptions,
  ) {
    this.legs = new Map(legs.map((l) => [l.kind, l]));
    this.leaseMs = opts.leaseMs ?? 120_000;
  }

  static async open(db: Db, ledger: Ledger, accounts: Accounts, legs: Leg[], opts: EngineOptions = {}): Promise<SagaEngine> {
    await db.exec(SCHEMA);
    return new SagaEngine(db, ledger, accounts, legs, opts);
  }

  async start(input: SagaInput): Promise<string> {
    for (const s of input.plan.steps) {
      if (!this.legs.has(s.kind)) throw new Error(`no leg registered for ${s.kind}`);
    }
    const id = randomUUID();
    await this.db.transaction(async (tx) => {
      await tx.query(`insert into sagas (id, kind, reference, status, input) values ($1,$2,$3,'running',$4)`, [
        id,
        input.kind,
        input.reference ?? null,
        JSON.stringify(input),
      ]);
      for (const s of input.plan.steps) {
        await tx.query(`insert into saga_steps (saga_id, idx, kind, status) values ($1,$2,$3,'pending')`, [id, s.index, s.kind]);
      }
      await tx.query(`insert into saga_events (saga_id, event) values ($1, 'started')`, [id]);
    });
    return id;
  }

  /**
   * Drive the saga as far as it can go. Safe to call again after a crash.
   * If another live worker holds the lease, returns the current status without doing work.
   */
  async run(sagaId: string): Promise<SagaStatus> {
    if (!(await this.acquireLease(sagaId))) return (await this.get(sagaId)).status;
    try {
      return await this.drive(sagaId);
    } finally {
      await this.db.query(`update sagas set lease_owner = null, lease_until = null where id = $1 and lease_owner = $2`, [
        sagaId,
        this.workerId,
      ]);
    }
  }

  private async acquireLease(sagaId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `update sagas set lease_owner = $2, lease_until = now() + ($3::int * interval '1 millisecond')
        where id = $1 and (lease_until is null or lease_until < now() or lease_owner = $2)
        returning id`,
      [sagaId, this.workerId, this.leaseMs],
    );
    return rows.length === 1;
  }

  private async drive(sagaId: string): Promise<SagaStatus> {
    let view = await this.get(sagaId);
    const input = await this.input(sagaId);

    if (view.status === "running") {
      for (const step of input.plan.steps) {
        const row = view.steps[step.index]!;
        if (row.status === "done") continue;
        const ok = await this.forward(sagaId, input, step, view);
        view = await this.get(sagaId);
        if (!ok) {
          await this.setStatus(sagaId, "compensating");
          break;
        }
      }
      view = await this.get(sagaId);
      if (view.status === "running") await this.setStatus(sagaId, "completed");
    }

    view = await this.get(sagaId);
    if (view.status === "compensating") {
      for (const step of [...input.plan.steps].reverse()) {
        const row = view.steps[step.index]!;
        if (row.status !== "done") continue;
        const ok = await this.compensate(sagaId, input, step, view);
        if (!ok) {
          await this.setStatus(sagaId, "manual_review");
          return "manual_review";
        }
        view = await this.get(sagaId);
      }
      await this.setStatus(sagaId, "compensated");
    }
    return (await this.get(sagaId)).status;
  }

  async get(sagaId: string): Promise<SagaView> {
    const saga = (
      await this.db.query<{ id: string; kind: string; reference: string | null; status: SagaStatus }>(
        `select id, kind, reference, status from sagas where id = $1`,
        [sagaId],
      )
    ).rows[0];
    if (!saga) throw new Error(`unknown saga ${sagaId}`);
    const steps = (
      await this.db.query<SagaView["steps"][number]>(
        `select idx, kind, status, attempts, output, error from saga_steps where saga_id = $1 order by idx`,
        [sagaId],
      )
    ).rows;
    const events = (
      await this.db.query<SagaView["events"][number]>(
        `select idx, event, detail, at from saga_events where saga_id = $1 order by id`,
        [sagaId],
      )
    ).rows;
    return { ...saga, steps, events };
  }

  // ---- internals ----

  private async forward(sagaId: string, input: SagaInput, step: PlannedStep, view: SagaView): Promise<boolean> {
    const leg = this.legs.get(step.kind)!;
    const max = leg.maxAttempts ?? 3;
    let attempts = view.steps[step.index]!.attempts;

    while (attempts < max) {
      attempts++;
      if (!(await this.acquireLease(sagaId))) throw new Error(`lost lease on saga ${sagaId}`);
      await this.db.query(`update saga_steps set attempts = $3, updated_at = now() where saga_id = $1 and idx = $2`, [
        sagaId,
        step.index,
        attempts,
      ]);
      try {
        if (input.faults?.failAt === step.kind) throw new FaultInjected(`injected failure at ${step.kind}`);
        const ctx = this.context(sagaId, input, step, view);
        const outcome = await leg.forward(ctx);
        await this.book(outcome, ctx.idempotencyKey);
        await this.db.query(
          `update saga_steps set status = 'done', output = $3, error = null, updated_at = now() where saga_id = $1 and idx = $2`,
          [sagaId, step.index, JSON.stringify(outcome.output)],
        );
        await this.event(sagaId, step.index, "forward.done");
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.event(sagaId, step.index, "forward.error", msg);
        if (err instanceof FaultInjected || attempts >= max) {
          await this.db.query(
            `update saga_steps set status = 'failed', error = $3, updated_at = now() where saga_id = $1 and idx = $2`,
            [sagaId, step.index, msg],
          );
          return false;
        }
        await sleep((leg.backoffMs ?? 500) * 2 ** (attempts - 1));
      }
    }
    return false;
  }

  private async compensate(sagaId: string, input: SagaInput, step: PlannedStep, view: SagaView): Promise<boolean> {
    const leg = this.legs.get(step.kind)!;
    const row = view.steps[step.index]!;
    if (!leg.compensate) {
      await this.markCompensated(sagaId, step.index, "nothing to undo");
      return true;
    }
    const max = leg.maxAttempts ?? 3;
    for (let attempt = 1; attempt <= max; attempt++) {
      try {
        const ctx = this.context(sagaId, input, step, view);
        const outcome = await leg.compensate(ctx, row.output);
        await this.book(outcome, `${ctx.idempotencyKey}:compensate`);
        await this.markCompensated(sagaId, step.index, JSON.stringify(outcome.output));
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.event(sagaId, step.index, "compensate.error", msg);
        if (attempt < max) await sleep((leg.backoffMs ?? 500) * 2 ** (attempt - 1));
      }
    }
    await this.db.query(
      `update saga_steps set status = 'compensation_failed', updated_at = now() where saga_id = $1 and idx = $2`,
      [sagaId, step.index],
    );
    return false;
  }

  private async book(outcome: LegOutcome, idempotencyKey: string): Promise<void> {
    for (const [i, entry] of (outcome.bookings ?? []).entries()) {
      await this.ledger.post({
        ...entry,
        external: entry.external ?? { venue: "internal", ref: `${idempotencyKey}:${i}` },
      });
    }
  }

  private context(sagaId: string, input: SagaInput, step: PlannedStep, view: SagaView): LegContext {
    const outputs: Record<number, Json> = {};
    for (const s of view.steps) if (s.output !== null) outputs[s.idx] = s.output;
    return {
      sagaId,
      step,
      plan: input.plan,
      data: input.data as LegContext["data"],
      idempotencyKey: `${sagaId}:${step.index}`,
      outputs,
      accounts: this.accounts,
    };
  }

  private async input(sagaId: string): Promise<SagaInput> {
    const { rows } = await this.db.query<{ input: SagaInput }>(`select input from sagas where id = $1`, [sagaId]);
    return rows[0]!.input;
  }

  private async setStatus(sagaId: string, status: SagaStatus) {
    await this.db.query(`update sagas set status = $2, updated_at = now() where id = $1`, [sagaId, status]);
    await this.event(sagaId, null, status);
  }

  private async markCompensated(sagaId: string, idx: number, detail: string) {
    await this.db.query(`update saga_steps set status = 'compensated', updated_at = now() where saga_id = $1 and idx = $2`, [
      sagaId,
      idx,
    ]);
    await this.event(sagaId, idx, "compensated", detail);
  }

  private async event(sagaId: string, idx: number | null, event: string, detail?: string) {
    await this.db.query(`insert into saga_events (saga_id, idx, event, detail) values ($1,$2,$3,$4)`, [
      sagaId,
      idx,
      event,
      detail ?? null,
    ]);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
