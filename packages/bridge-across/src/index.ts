import type { Address, Hex } from "viem";

/**
 * Across adapter. One code path for testnet and mainnet: the Swap API returns
 * a firm quote plus the approval and deposit transactions to sign; the deposit
 * status API tracks the relayer's fill on the destination chain.
 *
 * Mainnet route (ARCHITECTURE §6.4): Tempo pathUSD → Base USDC → Solana USDC,
 * two hops, since Across has no direct Tempo↔Solana route.
 * Testnet route: Base Sepolia USDC → Solana devnet USDC (Across has no Tempo testnet).
 */

export type AcrossEnv = "mainnet" | "testnet";

export const ACROSS_API: Record<AcrossEnv, string> = {
  mainnet: "https://app.across.to/api",
  testnet: "https://testnet.across.to/api",
};

export const CHAINS = {
  tempo: 4217,
  base: 8453,
  solana: 34268394551451,
  baseSepolia: 84532,
  solanaDevnet: 133268194659241,
} as const;

export const TOKENS = {
  tempoPathUSD: "0x20c0000000000000000000000000000000000000",
  tempoUSDCe: "0x20C000000000000000000000b9537d11c60E8b50",
  baseUSDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  solanaUSDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  baseSepoliaUSDC: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  solanaDevnetUSDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
} as const;

export interface QuoteRequest {
  env: AcrossEnv;
  originChainId: number;
  destinationChainId: number;
  inputToken: string;
  outputToken: string;
  /** Input amount in the input token's base units. */
  amount: bigint;
  depositor: string;
  recipient: string;
}

export interface EvmTx {
  chainId: number;
  to: Address;
  data: Hex;
  value?: string;
}

export interface AcrossQuote {
  id: string;
  env: AcrossEnv;
  originChainId: number;
  destinationChainId: number;
  inputAmount: bigint;
  expectedOutputAmount: bigint;
  minOutputAmount: bigint;
  /** Seconds. */
  expectedFillTime: number;
  /** Unix seconds; 0 when the route has no quote expiry. */
  quoteExpiryTimestamp: number;
  feeTotal: bigint;
  approvalTxns: EvmTx[];
  swapTx: EvmTx & { ecosystem: string };
}

export class AcrossError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

type Fetch = typeof fetch;

async function getJson(url: string, fetchImpl: Fetch): Promise<Record<string, any>> {
  const res = await fetchImpl(url);
  const body = (await res.json()) as Record<string, any>;
  if (!res.ok || body.type === "AcrossApiError" || body.error) {
    throw new AcrossError(body.message ?? `Across API ${res.status}`, body.code ?? body.error);
  }
  return body;
}

export async function quote(req: QuoteRequest, fetchImpl: Fetch = fetch): Promise<AcrossQuote> {
  const qs = new URLSearchParams({
    tradeType: "exactInput",
    amount: req.amount.toString(),
    inputToken: req.inputToken,
    outputToken: req.outputToken,
    originChainId: String(req.originChainId),
    destinationChainId: String(req.destinationChainId),
    depositor: req.depositor,
    recipient: req.recipient,
  });
  const q = await getJson(`${ACROSS_API[req.env]}/swap/approval?${qs}`, fetchImpl);
  return {
    id: q.id,
    env: req.env,
    originChainId: req.originChainId,
    destinationChainId: req.destinationChainId,
    inputAmount: BigInt(q.inputAmount),
    expectedOutputAmount: BigInt(q.expectedOutputAmount),
    minOutputAmount: BigInt(q.minOutputAmount),
    expectedFillTime: Number(q.expectedFillTime),
    quoteExpiryTimestamp: Number(q.quoteExpiryTimestamp),
    feeTotal: BigInt(q.fees?.total?.amount ?? 0),
    approvalTxns: (q.approvalTxns ?? []).map((t: EvmTx) => ({ chainId: t.chainId, to: t.to, data: t.data, value: t.value })),
    swapTx: q.swapTx,
  };
}

/** The subset of a viem wallet client the adapter needs; Tempo and Base clients both satisfy it. */
export interface EvmSender {
  sendTransaction(args: { to: Address; data: Hex; value?: bigint; chain?: any; account?: any }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted"; transactionHash: Hex }>;
}

/** Sign and send the approvals, then the deposit. Returns the origin-chain deposit transaction. */
export async function executeEvm(sender: EvmSender, q: AcrossQuote): Promise<{ depositTxHash: Hex; approvals: Hex[] }> {
  if (q.swapTx.ecosystem !== "evm") throw new AcrossError(`origin ecosystem ${q.swapTx.ecosystem} is not EVM`);
  // 0 means the route has no quote expiry (e.g. CCTP-backed routes).
  if (q.quoteExpiryTimestamp > 0 && Date.now() / 1000 > q.quoteExpiryTimestamp) {
    throw new AcrossError("quote expired; re-quote before sending");
  }
  const approvals: Hex[] = [];
  for (const tx of q.approvalTxns) {
    const hash = await sender.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ? BigInt(tx.value) : undefined });
    const r = await sender.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new AcrossError(`approval reverted: ${hash}`);
    approvals.push(hash);
  }
  const hash = await sender.sendTransaction({
    to: q.swapTx.to,
    data: q.swapTx.data,
    value: q.swapTx.value ? BigInt(q.swapTx.value) : undefined,
  });
  const r = await sender.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new AcrossError(`deposit reverted: ${hash}`);
  return { depositTxHash: hash, approvals };
}

export type FillStatus = "pending" | "filled" | "expired" | "refunded" | "slowFillRequested" | "not_found";

export interface DepositStatus {
  status: FillStatus;
  fillTx?: string;
  depositId?: string;
  destinationChainId?: number;
}

export async function depositStatus(
  env: AcrossEnv,
  originChainId: number,
  depositTxHash: string,
  fetchImpl: Fetch = fetch,
): Promise<DepositStatus> {
  const qs = new URLSearchParams({ originChainId: String(originChainId), depositTxHash });
  try {
    const s = await getJson(`${ACROSS_API[env]}/deposit/status?${qs}`, fetchImpl);
    return {
      status: s.status as FillStatus,
      fillTx: s.fillTx ?? s.fillTxnRef ?? s.fillTxHash ?? undefined,
      depositId: s.depositId != null ? String(s.depositId) : undefined,
      destinationChainId: s.destinationChainId,
    };
  } catch (err) {
    // The indexer can lag the chain by a few seconds after a deposit lands.
    if (err instanceof AcrossError && err.code === "DepositNotFoundException") return { status: "not_found" };
    throw err;
  }
}

export async function waitForFill(
  env: AcrossEnv,
  originChainId: number,
  depositTxHash: string,
  opts: { timeoutMs?: number; pollMs?: number; fetchImpl?: Fetch; onPoll?: (s: DepositStatus) => void } = {},
): Promise<DepositStatus> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (true) {
    const s = await depositStatus(env, originChainId, depositTxHash, opts.fetchImpl);
    opts.onPoll?.(s);
    if (s.status === "filled" || s.status === "expired" || s.status === "refunded") return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 5_000));
  }
}
