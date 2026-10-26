import { INTENT_ASSETS, MIN_SWAP_USD, type IntentAssetKey } from "./assets.ts";

/**
 * NEAR Intents' 1Click API: a solver network that takes a deposit on one
 * chain and pays out on another.
 *
 * It is quote-then-deposit, not a bridge Corridor drives. A live quote
 * returns a one-off deposit address; whatever arrives there is swapped and
 * delivered to the recipient that quote named, or sent back to `refundTo`.
 * Corridor never holds the funds and never signs the swap — so the recorded
 * steps are "quoted", "deposit seen", "delivered", which is the shape the
 * saga engine already expects.
 */

const BASE_URL = "https://1click.chaindefuser.com/v0";

export interface SwapQuoteRequest {
  origin: IntentAssetKey;
  destination: IntentAssetKey;
  /** Amount of the origin asset, in its own base units. */
  amount: bigint;
  /** Where the solver pays out: an address on the destination chain. */
  recipient: string;
  /** Where the origin funds go back to if the swap cannot be filled. */
  refundTo: string;
  /** Hundredths of a percent; 100 is 1%. Defaults to 1%. */
  slippageBps?: number;
  /** How long the deposit address stays good for. Defaults to 15 minutes. */
  deadline?: Date;
}

export interface SwapQuote {
  /** Base units of the origin asset the solver priced. */
  amountIn: bigint;
  /** Base units of the destination asset it expects to deliver. */
  amountOut: bigint;
  /** The least it will deliver; below this it refunds instead of filling. */
  minAmountOut: bigint;
  amountInUsd: string;
  amountOutUsd: string;
  /** Seconds the solver expects to need. */
  timeEstimateSeconds: number;
  /**
   * The one-off address to send the origin asset to. Absent on a dry quote,
   * which is priced but not executable.
   */
  depositAddress?: string;
  /** The solver's signature over the quote, kept for the dispute trail. */
  signature: string;
  /** 1Click's own id for the request, which its support asks for. */
  correlationId?: string;
  deadline: string;
}

/**
 * 1Click's execution states, as its own SDK enumerates them.
 *
 * `INCOMPLETE_DEPOSIT` is the one that needs a human: less arrived at the
 * deposit address than the quote priced, so the solver holds it without
 * filling or refunding.
 */
export type SwapState =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "INCOMPLETE_DEPOSIT"
  | "PROCESSING"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

export interface SwapStatus {
  state: SwapState;
  /** Base units actually delivered, once the swap has settled. */
  amountOut?: bigint;
  /** The deposit that started it, once seen on the origin chain. */
  originTxs: string[];
  /** The payout, once made. For the Tron lane this is the Solana transfer. */
  destinationTxs: string[];
  /** Base units sent back to `refundTo`, when the state is REFUNDED. */
  refundedAmount?: bigint;
  updatedAt?: string;
  correlationId?: string;
}

export class OneClickError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export interface OneClickOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  /** 1Click issues JWTs for higher rate limits and for referral fees. */
  jwt?: string;
}

/** 1Click returns every amount as a decimal string of base units. */
function units(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new OneClickError(`1Click returned a ${field} that is not base units: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function hashes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((t) => (t as { hash?: unknown }).hash).filter((h): h is string => typeof h === "string");
}

export class OneClick {
  private readonly http: typeof fetch;

  constructor(private readonly opts: OneClickOptions = {}) {
    this.http = opts.fetch ?? fetch;
  }

  private get baseUrl(): string {
    return (this.opts.baseUrl ?? BASE_URL).replace(/\/$/, "");
  }

  private get authHeaders(): Record<string, string> {
    return this.opts.jwt ? { authorization: `Bearer ${this.opts.jwt}` } : {};
  }

  /**
   * Price a swap. `dry` prices it without reserving anything and returns no
   * deposit address, which is what a rate shown in a UI should use; a live
   * quote is a commitment the solver signed, so it is only asked for once the
   * user has agreed to the amount.
   */
  async quote(req: SwapQuoteRequest, opts: { dry?: boolean } = {}): Promise<SwapQuote> {
    const origin = INTENT_ASSETS[req.origin];
    const destination = INTENT_ASSETS[req.destination];
    // Both legs Corridor routes are 6-decimal dollar stables, so base units
    // convert to dollars directly. Checked here so the caller sees Corridor's
    // own message instead of a 400 from the solver network.
    const approxUsd = Number(req.amount) / 10 ** origin.decimals;
    if (approxUsd < MIN_SWAP_USD) {
      throw new OneClickError(
        `1Click will not swap less than $${MIN_SWAP_USD}; this is about $${approxUsd.toFixed(2)} of ${origin.symbol}`,
        400,
      );
    }
    const deadline = req.deadline ?? new Date(Date.now() + 15 * 60_000);
    const res = await this.http(`${this.baseUrl}/quote`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.authHeaders },
      body: JSON.stringify({
        dry: opts.dry ?? false,
        swapType: "EXACT_INPUT",
        slippageTolerance: req.slippageBps ?? 100,
        originAsset: origin.id,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: destination.id,
        amount: req.amount.toString(),
        refundTo: req.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: req.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: deadline.toISOString(),
      }),
    });
    const body = (await res.json().catch(() => undefined)) as
      | { quote?: Record<string, unknown>; signature?: string; correlationId?: string; message?: string }
      | undefined;
    if (!res.ok) {
      // The solver network's own refusal is more specific than anything
      // Corridor could say — a moved swap limit, an unroutable pair, a
      // malformed address — so it is passed through verbatim.
      throw new OneClickError(
        body?.message ?? `1Click refused the quote (${res.status})`,
        res.status,
        res.status === 429 || res.status >= 500,
      );
    }
    const q = body?.quote;
    if (!q) throw new OneClickError("1Click returned no quote");
    if (!opts.dry && typeof q.depositAddress !== "string") {
      throw new OneClickError("1Click returned a live quote with no deposit address");
    }
    return {
      amountIn: units(q.amountIn, "amountIn"),
      amountOut: units(q.amountOut, "amountOut"),
      minAmountOut: units(q.minAmountOut, "minAmountOut"),
      amountInUsd: String(q.amountInUsd ?? ""),
      amountOutUsd: String(q.amountOutUsd ?? ""),
      timeEstimateSeconds: Number(q.timeEstimate ?? 0),
      depositAddress: typeof q.depositAddress === "string" ? q.depositAddress : undefined,
      signature: body?.signature ?? "",
      correlationId: body?.correlationId,
      deadline: String(q.deadline ?? ""),
    };
  }

  /**
   * Where a swap has got to, by the deposit address its quote returned.
   *
   * Returns undefined while 1Click has not seen that address yet, which is
   * not an error — the same shape as Circle answering 404 before it has
   * indexed a burn.
   */
  async status(depositAddress: string): Promise<SwapStatus | undefined> {
    const url = `${this.baseUrl}/status?depositAddress=${encodeURIComponent(depositAddress)}`;
    const res = await this.http(url, { headers: this.authHeaders });
    if (res.status === 404) return undefined;
    if (res.status === 429) throw new OneClickError("1Click rate limit; back off before retrying", 429, true);
    const body = (await res.json().catch(() => undefined)) as
      | { status?: string; updatedAt?: string; correlationId?: string; swapDetails?: Record<string, unknown>; message?: string }
      | undefined;
    if (!res.ok) {
      throw new OneClickError(body?.message ?? `1Click status failed (${res.status})`, res.status, res.status >= 500);
    }
    if (typeof body?.status !== "string") throw new OneClickError("1Click status response carried no state");
    const d = body.swapDetails ?? {};
    return {
      state: body.status as SwapState,
      amountOut: typeof d.amountOut === "string" ? units(d.amountOut, "amountOut") : undefined,
      originTxs: hashes(d.originChainTxHashes),
      destinationTxs: hashes(d.destinationChainTxHashes),
      refundedAmount: typeof d.refundedAmount === "string" ? units(d.refundedAmount, "refundedAmount") : undefined,
      updatedAt: body.updatedAt,
      correlationId: body.correlationId,
    };
  }

  /**
   * Poll until the swap reaches a state it will not leave.
   *
   * Mirrors the attestation wait on the CCTP side: a retryable error backs
   * off, anything else is raised at once. `INCOMPLETE_DEPOSIT` is returned
   * rather than waited on — the solver holds a short deposit without filling
   * or refunding it, so no amount of polling resolves it.
   */
  async waitForSwap(args: {
    depositAddress: string;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<SwapStatus> {
    const pollMs = args.pollMs ?? 5_000;
    const deadline = Date.now() + (args.timeoutMs ?? 20 * 60_000);
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let wait = pollMs;
    let last: SwapStatus | undefined;
    while (true) {
      try {
        const status = await this.status(args.depositAddress);
        if (status) {
          last = status;
          if (isTerminal(status.state) || status.state === "INCOMPLETE_DEPOSIT") return status;
        }
        wait = pollMs;
      } catch (e) {
        if (!(e instanceof OneClickError) || !e.retryable) throw e;
        wait = Math.min(wait * 2, 60_000);
      }
      if (Date.now() + wait > deadline) {
        throw new OneClickError(
          `the swap at ${args.depositAddress} did not settle within the timeout (last seen: ${last?.state ?? "unseen"})`,
          undefined,
          true,
        );
      }
      await sleep(wait);
    }
  }
}

/** States 1Click will not move on from, so a watcher can stop polling. */
export function isTerminal(state: SwapState): boolean {
  return state === "SUCCESS" || state === "REFUNDED" || state === "FAILED";
}
