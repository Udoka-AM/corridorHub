import type { Address } from "viem";
import { money, type Asset, type Venue } from "@corridor/core";
import { executeEvm, quote, waitForFill, CHAINS, TOKENS, type AcrossEnv, type AcrossQuote, type DepositStatus, type EvmSender } from "@corridor/bridge-across";
import { ManualReviewError, NonRetryableError, type Json, type Leg, type LegContext, type PayoutData } from "@corridor/saga";
import type { EntryInput } from "@corridor/ledger";
import type { ArtifactStore } from "./shielded.ts";

/**
 * The live `across.bridge` leg (mainnet): one hop of the hub's route out to
 * Solana, Tempo pathUSD → Base USDC or Base USDC → Solana USDC.
 *
 * Exactly once: the deposit hash is written to the artifact store as soon as
 * the origin chain confirms it, and a retry only waits for that deposit's
 * fill. A crash between signing and recording leaves a `sending` marker and
 * stops the saga for a human instead of sending twice.
 *
 * Booked from the chain: the amount that actually arrived is read from the
 * fill, the difference is Across's fee (booked to `expense:bridge-fee`), and
 * origin gas comes from the transaction receipts.
 */

export type Hop = "tempo-base" | "base-solana";

interface HopSpec {
  originChainId: number;
  destinationChainId: number;
  inputToken: string;
  outputToken: string;
  from: { vault: string; asset: Asset; venue: Venue };
  to: { vault: string; asset: Asset; venue: Venue };
}

const HOPS: Record<Hop, HopSpec> = {
  "tempo-base": {
    originChainId: CHAINS.tempo,
    destinationChainId: CHAINS.base,
    inputToken: TOKENS.tempoPathUSD,
    outputToken: TOKENS.baseUSDC,
    from: { vault: "treasury", asset: "pathUSD", venue: "tempo" },
    to: { vault: "base-relay", asset: "USDC", venue: "base" },
  },
  "base-solana": {
    originChainId: CHAINS.base,
    destinationChainId: CHAINS.solana,
    inputToken: TOKENS.baseUSDC,
    outputToken: TOKENS.solanaUSDC,
    from: { vault: "base-relay", asset: "USDC", venue: "base" },
    to: { vault: "solana-egress", asset: "USDC", venue: "solana" },
  },
};

export function hopOf(from: Venue, to: Venue): Hop {
  const hop = `${from}-${to}`;
  if (hop in HOPS) return hop as Hop;
  throw new NonRetryableError(`across.bridge has no ${from} → ${to} hop`);
}

/** Network cost of the origin transactions, in the paying vault's native ledger asset. */
export interface GasCost {
  txHash: string;
  asset: Asset;
  venue: Venue;
  /** Vault that paid it. */
  vault: string;
  amount: bigint;
}

export interface AcrossLegOptions {
  env: AcrossEnv;
  artifacts: ArtifactStore;
  /** Signs on the hop's origin chain (the Tempo treasury, or the Base relay). */
  sender(hop: Hop): EvmSender;
  depositor(hop: Hop): Address;
  /** Who receives on the destination chain (the Base relay, or the Solana vault). */
  recipient(hop: Hop): string;
  /** Amount of the output token the fill delivered to the recipient, read from the destination chain. */
  received(hop: Hop, fillTx: string): Promise<bigint>;
  /** What the origin transactions cost, read from their receipts. */
  gas(hop: Hop, txs: { txHash: string; wei: bigint }[]): Promise<GasCost[]>;
  fillTimeoutMs?: number;
  fillPollMs?: number;
  /** For tests: Across's HTTP API. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

interface Artifact {
  [k: string]: Json | undefined;
  sending?: boolean;
  quoteId?: string;
  depositTx?: string;
  gasTxs?: { txHash: string; wei: string }[];
}

/** The amount entering this hop: the payout amount on the first hop, then whatever the previous hop delivered. */
function amountIn(ctx: LegContext<PayoutData>): bigint {
  const prev = ctx.outputs[ctx.step.index - 1] as { received?: string } | undefined;
  return prev?.received ? BigInt(prev.received) : BigInt(ctx.data.amount);
}

export function acrossBridgeLeg(opts: AcrossLegOptions): Leg<PayoutData> {
  const log = opts.log ?? (() => {});
  return {
    kind: "across.bridge",
    maxAttempts: 3,
    backoffMs: 5_000,
    async forward(ctx) {
      const hop = hopOf(ctx.step.from.venue, ctx.step.to.venue);
      const spec = HOPS[hop];
      const input = amountIn(ctx);
      const key = `across:${ctx.idempotencyKey}`;
      let art = ((await opts.artifacts.get<{ [k: string]: Json }>(key)) ?? {}) as Artifact;

      if (!art.depositTx) {
        if (art.sending) {
          throw new ManualReviewError(`across ${hop}: a deposit may have been sent before a crash; check ${opts.depositor(hop)} on the origin explorer before retrying`);
        }
        const q: AcrossQuote = await quote({
          env: opts.env,
          originChainId: spec.originChainId,
          destinationChainId: spec.destinationChainId,
          inputToken: spec.inputToken,
          outputToken: spec.outputToken,
          amount: input,
          depositor: opts.depositor(hop),
          recipient: opts.recipient(hop),
        }, opts.fetchImpl);
        log(`across ${hop}: ${input} in → ${q.expectedOutputAmount} expected, ~${q.expectedFillTime}s`);
        await opts.artifacts.merge(key, { sending: true, quoteId: q.id });
        const sent = await executeEvm(opts.sender(hop), q);
        art = { ...art, depositTx: sent.depositTxHash, gasTxs: sent.gas.map((g) => ({ txHash: g.txHash, wei: g.wei.toString() })) };
        await opts.artifacts.merge(key, { depositTx: art.depositTx!, gasTxs: art.gasTxs! });
        log(`across ${hop}: deposit ${sent.depositTxHash}`);
      }

      const fill: DepositStatus = await waitForFill(opts.env, spec.originChainId, art.depositTx!, {
        timeoutMs: opts.fillTimeoutMs ?? 15 * 60_000,
        pollMs: opts.fillPollMs,
        fetchImpl: opts.fetchImpl,
      });
      if (fill.status === "expired" || fill.status === "refunded") {
        throw new ManualReviewError(`across ${hop}: deposit ${art.depositTx} was ${fill.status}; confirm the refund before undoing anything`);
      }
      // Still pending: retry waits on the same deposit (it never resends).
      if (fill.status !== "filled" || !fill.fillTx) throw new Error(`across ${hop}: deposit ${art.depositTx} still ${fill.status}`);

      const received = await opts.received(hop, fill.fillTx);
      if (received <= 0n || received > input) throw new ManualReviewError(`across ${hop}: fill ${fill.fillTx} delivered ${received} for ${input} in`);
      const fee = input - received;
      const gas = await opts.gas(hop, (art.gasTxs ?? []).map((g) => ({ txHash: g.txHash, wei: BigInt(g.wei) })));
      log(`across ${hop}: filled ${fill.fillTx}, received ${received} (fee ${fee})`);

      const a = ctx.accounts;
      const d = ctx.data;
      const from = await a.vault(spec.from.vault, spec.from.asset, spec.from.venue);
      const to = await a.vault(spec.to.vault, spec.to.asset, spec.to.venue);
      const feeLine = async (asset: Asset, venue: Venue) =>
        fee > 0n ? [{ account: await a.expense("bridge-fee", asset, venue), direction: "D" as const, money: money(asset, fee) }] : [];

      const bookings: EntryInput[] = [];
      if (hop === "tempo-base") {
        // Out of the hub: pathUSD leaves the treasury into the USD peg …
        bookings.push({
          kind: "bridge.deposit",
          reference: d.reference,
          sagaId: ctx.sagaId,
          external: { venue: "tempo", ref: art.depositTx! },
          lines: [
            { account: await a.clearing("usd-peg", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", input) },
            { account: from, direction: "C", money: money("pathUSD", input) },
          ],
        });
        // … and comes out as USDC on Base, less Across's fee. The peg's USDC side is
        // the account the partner leg settles against when the USDC reaches Solana.
        bookings.push({
          kind: "bridge.fill",
          reference: d.reference,
          sagaId: ctx.sagaId,
          external: { venue: "base", ref: fill.fillTx },
          metadata: { hop, depositTx: art.depositTx, fee: fee.toString() },
          lines: [
            { account: to, direction: "D", money: money("USDC", received) },
            ...(await feeLine("USDC", "base")),
            { account: await a.clearing("usd-peg", "USDC", "solana"), direction: "C", money: money("USDC", input) },
          ],
        });
      } else {
        // Same asset, two venues: one entry moves the USDC and books the fee.
        bookings.push({
          kind: "bridge.fill",
          reference: d.reference,
          sagaId: ctx.sagaId,
          external: { venue: "solana", ref: fill.fillTx },
          metadata: { hop, depositTx: art.depositTx, fee: fee.toString() },
          lines: [
            { account: to, direction: "D", money: money("USDC", received) },
            ...(await feeLine("USDC", "solana")),
            { account: from, direction: "C", money: money("USDC", input) },
          ],
        });
      }
      for (const g of gas.filter((g) => g.amount > 0n)) {
        bookings.push({
          kind: "gas",
          reference: d.reference,
          sagaId: ctx.sagaId,
          external: { venue: g.venue, ref: `${g.txHash}:gas` },
          lines: [
            { account: await a.expense("gas", g.asset, g.venue), direction: "D", money: money(g.asset, g.amount) },
            { account: await a.vault(g.vault, g.asset, g.venue), direction: "C", money: money(g.asset, g.amount) },
          ],
        });
      }

      return {
        output: {
          hop,
          depositTx: art.depositTx!,
          fillTx: fill.fillTx,
          amountIn: input.toString(),
          received: received.toString(),
          fee: fee.toString(),
          gas: gas.map((g) => ({ txHash: g.txHash, asset: g.asset, amount: g.amount.toString() })),
        },
        bookings,
      };
    },
    async compensate() {
      // Value already crossed chains: a person returns it, then closes the saga.
      throw new ManualReviewError("across.bridge cannot be undone automatically; return the bridged funds and close the saga by hand");
    },
  };
}
