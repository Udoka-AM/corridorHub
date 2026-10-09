import { getAbiItem, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Account as TempoAccount, Actions, Addresses, createClient } from "viem/tempo";
import { tryDecodeRef, type Asset, type Hex, type Observation } from "@corridor/core";
import { tokenAddress } from "./tokens.ts";

export { TEMPO_TOKENS, tokenAddress } from "./tokens.ts";
export { FEE_MANAGER, TempoObserver, blockTimes, type CursorStore } from "./observer.ts";
import { blockTimes } from "./observer.ts";

export type TempoNetwork = "moderato" | "mainnet";

export const EXPLORER: Record<TempoNetwork, string> = {
  moderato: "https://explore.testnet.tempo.xyz",
  mainnet: "https://explore.tempo.xyz",
};


const TRANSFER_WITH_MEMO = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

export type TempoClient = ReturnType<typeof tempoClient>;

/** Any viem account that can sign Tempo transactions, e.g. `await tempoAccount(awsKmsSigner(...))`. */
export type TempoSigningAccount = ReturnType<typeof privateKeyToAccount> | Awaited<ReturnType<typeof TempoAccount.from>>;

/**
 * A vault client. Gas is paid in pathUSD through the Fee AMM; there is no
 * native gas token. Pass `account` to sign with the customer's own signer
 * (KMS, MPC: see @corridor/signer's `tempoAccount`); `privateKey` is for
 * development and testnet only.
 */
export function tempoClient(
  opts: { network: TempoNetwork; rpcUrl?: string } & ({ privateKey: Hex; account?: never } | { account: TempoSigningAccount; privateKey?: never }),
) {
  return createClient({
    account: opts.account ?? privateKeyToAccount(opts.privateKey!),
    testnet: opts.network === "moderato",
    feeToken: Addresses.pathUsd,
    // Public RPCs stall under load; one slow call shouldn't fail a saga step or a recon run.
    transport: http(opts.rpcUrl, { timeout: 30_000, retryCount: 5 }),
  });
}

/** A key-less client for watch-only observation (read-only pilots). */
export function tempoReader(opts: { network: TempoNetwork; rpcUrl?: string }) {
  return createClient({ testnet: opts.network === "moderato", transport: http(opts.rpcUrl, { timeout: 30_000, retryCount: 5 }) });
}

/** Moderato only: fund an address from the testnet faucet and wait for inclusion. */
export async function fundFromFaucet(client: TempoClient, address: Address) {
  return Actions.faucet.fundSync(client, { account: address });
}

export async function balanceOf(client: TempoClient, asset: Asset, account: Address): Promise<bigint> {
  const { amount } = await Actions.token.getBalance(client, { token: tokenAddress(asset), account });
  return amount;
}

/**
 * First block at which `account` held any `asset`, found by bisecting
 * historical balances. Lets an observer replay a vault's whole history
 * (funding, fees) without scanning the chain from genesis.
 */
export async function firstFundedBlock(client: TempoClient, asset: Asset, account: Address): Promise<bigint | undefined> {
  const at = async (blockNumber: bigint) =>
    (await client.readContract({ address: tokenAddress(asset), abi: Abis.tip20, functionName: "balanceOf", args: [account], blockNumber })) as bigint;
  let hi = await client.getBlockNumber();
  if ((await at(hi)) === 0n) return undefined;
  let lo = 0n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await at(mid)) > 0n) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/**
 * Move a TIP-20 with the Corridor Reference as its memo. Returns the
 * observation for the resulting `TransferWithMemo` log, which is what gets
 * booked in the ledger.
 */
export async function transferWithReference(
  client: TempoClient,
  args: { asset: Asset; to: Address; amount: bigint; reference: Hex },
): Promise<Observation & { txHash: Hex }> {
  const token = tokenAddress(args.asset);
  const { receipt } = await Actions.token.transferSync(client, {
    token,
    to: args.to,
    amount: args.amount,
    memo: args.reference,
  });
  if (receipt.status !== "success") throw new Error(`Tempo transfer reverted: ${receipt.transactionHash}`);
  const [obs] = await findTransfersByReference(client, {
    asset: args.asset,
    reference: args.reference,
    fromBlock: receipt.blockNumber,
    toBlock: receipt.blockNumber,
  });
  if (!obs) throw new Error(`no TransferWithMemo log found in ${receipt.transactionHash}`);
  return { ...obs, txHash: receipt.transactionHash };
}

/**
 * Tempo indexes the memo as an event topic, so reconciliation can ask the
 * node directly for every movement carrying a given reference, with no
 * separate indexer.
 */
export async function findTransfersByReference(
  client: TempoClient,
  args: { asset: Asset; reference: Hex; fromBlock: bigint; toBlock?: bigint },
): Promise<Observation[]> {
  const logs = await client.getLogs({
    address: tokenAddress(args.asset),
    event: TRANSFER_WITH_MEMO,
    args: { memo: args.reference },
    fromBlock: args.fromBlock,
    toBlock: args.toBlock ?? "latest",
  });
  const times = await blockTimes(client, logs.flatMap((l) => (l.blockNumber === null ? [] : [l.blockNumber])));
  return logs.map((log) => ({
    venue: "tempo" as const,
    externalRef: `${log.transactionHash}:${log.logIndex}`,
    reference: tryDecodeRef(log.args.memo!) ? (log.args.memo as Hex) : null,
    asset: args.asset,
    amount: log.args.amount!,
    from: log.args.from,
    to: log.args.to,
    blockNumber: log.blockNumber ?? undefined,
    observedAt: (log.blockNumber !== null && times.get(log.blockNumber)) || new Date(),
  }));
}

export function explorerTx(network: TempoNetwork, hash: string): string {
  return `${EXPLORER[network]}/tx/${hash}`;
}
