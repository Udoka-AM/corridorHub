import { getAbiItem, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Abis, Actions, Addresses, createClient } from "viem/tempo";
import { tryDecodeRef, type Asset, type Hex, type Observation } from "@corridor/core";

export type TempoNetwork = "moderato" | "mainnet";

export const EXPLORER: Record<TempoNetwork, string> = {
  moderato: "https://explore.testnet.tempo.xyz",
  mainnet: "https://explore.tempo.xyz",
};

/** USD TIP-20s Corridor handles. pathUSD is the canonical settlement unit (ARCHITECTURE §0.1). */
export const TEMPO_TOKENS: Partial<Record<Asset, Address>> = {
  pathUSD: Addresses.pathUsd,
  "USDC.e": "0x20C000000000000000000000b9537d11c60E8b50",
};

const TRANSFER_WITH_MEMO = getAbiItem({ abi: Abis.tip20, name: "TransferWithMemo" });

export type TempoClient = ReturnType<typeof tempoClient>;

/** A vault client. Gas is paid in pathUSD through the Fee AMM; there is no native gas token. */
export function tempoClient(opts: { network: TempoNetwork; privateKey: Hex; rpcUrl?: string }) {
  return createClient({
    account: privateKeyToAccount(opts.privateKey),
    testnet: opts.network === "moderato",
    feeToken: Addresses.pathUsd,
    transport: http(opts.rpcUrl),
  });
}

export function tokenAddress(asset: Asset): Address {
  const addr = TEMPO_TOKENS[asset];
  if (!addr) throw new Error(`${asset} is not a Tempo TIP-20 Corridor settles in`);
  return addr;
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
  return logs.map((log) => ({
    venue: "tempo" as const,
    externalRef: `${log.transactionHash}:${log.logIndex}`,
    reference: tryDecodeRef(log.args.memo!) ? (log.args.memo as Hex) : null,
    asset: args.asset,
    amount: log.args.amount!,
    from: log.args.from,
    to: log.args.to,
    blockNumber: log.blockNumber ?? undefined,
    observedAt: new Date(),
  }));
}

export function explorerTx(network: TempoNetwork, hash: string): string {
  return `${EXPLORER[network]}/tx/${hash}`;
}
