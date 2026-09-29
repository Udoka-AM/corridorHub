/**
 * NEAR Intents (1Click API) client: the funding leg of Corridor's shielded
 * lane. Swaps USDC into ZEC delivered straight to a shielded vault's unified
 * address. A dry quote prices the swap; a live quote returns a one-off deposit
 * address; status tracks delivery.
 * https://1click.chaindefuser.com
 */

export const ONE_CLICK = "https://1click.chaindefuser.com/v0";

export const NEAR_ASSETS = {
  baseUSDC: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  solanaUSDC: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  ZEC: "nep141:zec.omft.near",
} as const;

export interface SwapQuoteRequest {
  originAsset: string;
  destinationAsset: string;
  /** Input amount in the origin asset's base units. */
  amount: bigint;
  /** Where the destination asset is delivered (for ZEC: a unified or transparent address). */
  recipient: string;
  /** Where the origin asset is refunded if the swap cannot complete. */
  refundTo: string;
  slippageBps?: number;
  /** Dry quotes price the swap without reserving a deposit address. */
  dry?: boolean;
  validForMinutes?: number;
}

export interface SwapQuote {
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  amountInUsd: number;
  amountOutUsd: number;
  /** Seconds. */
  timeEstimate: number;
  /** Present on live (non-dry) quotes: send the origin asset here. */
  depositAddress?: string;
  deadline: string;
  raw: Record<string, unknown>;
}

export type SwapStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "SUCCESS"
  | "INCOMPLETE_DEPOSIT"
  | "REFUNDED"
  | "FAILED";

export class NearIntentsError extends Error {}

type Fetch = typeof fetch;

export async function quoteSwap(req: SwapQuoteRequest, opts: { fetchImpl?: Fetch; jwt?: string } = {}): Promise<SwapQuote> {
  const deadline = new Date(Date.now() + (req.validForMinutes ?? 30) * 60_000).toISOString();
  const res = await (opts.fetchImpl ?? fetch)(`${ONE_CLICK}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(opts.jwt ? { authorization: `Bearer ${opts.jwt}` } : {}) },
    body: JSON.stringify({
      dry: req.dry ?? true,
      swapType: "EXACT_INPUT",
      slippageTolerance: req.slippageBps ?? 100,
      originAsset: req.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: req.destinationAsset,
      amount: req.amount.toString(),
      refundTo: req.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient: req.recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline,
    }),
  });
  const body = (await res.json()) as { quote?: Record<string, any>; message?: string };
  if (!res.ok || !body.quote) throw new NearIntentsError(body.message ?? `1Click quote failed (${res.status})`);
  const q = body.quote;
  return {
    amountIn: BigInt(q.amountIn),
    amountOut: BigInt(q.amountOut),
    minAmountOut: BigInt(q.minAmountOut),
    amountInUsd: Number(q.amountInUsd),
    amountOutUsd: Number(q.amountOutUsd),
    timeEstimate: Number(q.timeEstimate),
    depositAddress: q.depositAddress,
    deadline,
    raw: q,
  };
}

export async function swapStatus(depositAddress: string, opts: { fetchImpl?: Fetch } = {}): Promise<SwapStatus> {
  const res = await (opts.fetchImpl ?? fetch)(`${ONE_CLICK}/status?depositAddress=${encodeURIComponent(depositAddress)}`);
  const body = (await res.json()) as { status?: SwapStatus; message?: string };
  if (!res.ok || !body.status) throw new NearIntentsError(body.message ?? `1Click status failed (${res.status})`);
  return body.status;
}

/** Effective price in USD per ZEC implied by a quote (ZEC has 8 decimals, USDC 6). */
export function usdPerZec(q: SwapQuote): number {
  return Number(q.amountIn) / 1e6 / (Number(q.amountOut) / 1e8);
}
