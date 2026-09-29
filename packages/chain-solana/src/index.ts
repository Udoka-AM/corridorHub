import { readFileSync } from "node:fs";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { MEMO_PROGRAM_ADDRESS, getAddMemoInstruction } from "@solana-program/memo";
import { fromSolanaMemo, toSolanaMemo, tryDecodeRef, type Hex, type Observation } from "@corridor/core";

/**
 * Solana leg: USDC transfers that carry the Corridor Reference as an SPL Memo
 * in the same transaction, so a partner deposit (e.g. into Paj's one-off
 * funding address) is tied to its payout on-chain.
 */

export type SolanaCluster = "mainnet" | "devnet";

export const SOLANA_RPC: Record<SolanaCluster, { http: string; ws: string }> = {
  mainnet: { http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com" },
};

export const USDC_MINT: Record<SolanaCluster, Address> = {
  mainnet: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  devnet: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
};

export function explorerTx(cluster: SolanaCluster, signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${cluster === "devnet" ? "?cluster=devnet" : ""}`;
}

/** Load a signer from a solana-keygen JSON keypair file. */
export async function signerFromKeypairFile(path: string): Promise<KeyPairSigner> {
  return createKeyPairSignerFromBytes(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

/**
 * Instructions for: create the recipient's token account if missing,
 * transfer `amount` of `mint`, and attach the Corridor Reference as memo.
 * Pure (no network), so it is unit-testable.
 */
export async function buildTransferWithMemo(args: {
  from: KeyPairSigner;
  toOwner: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  reference: Hex;
}): Promise<Instruction[]> {
  const [source] = await findAssociatedTokenPda({ owner: args.from.address, mint: args.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const [destination] = await findAssociatedTokenPda({ owner: args.toOwner, mint: args.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: args.from,
      ata: destination,
      owner: args.toOwner,
      mint: args.mint,
    }),
    getTransferCheckedInstruction({
      source,
      mint: args.mint,
      destination,
      authority: args.from,
      amount: args.amount,
      decimals: args.decimals,
    }),
    getAddMemoInstruction({ memo: toSolanaMemo(args.reference) }),
  ];
}

export class SolanaVault {
  private readonly rpc;
  private readonly send;

  constructor(
    private readonly signer: KeyPairSigner,
    readonly cluster: SolanaCluster,
    rpcUrl?: { http: string; ws: string },
  ) {
    const urls = rpcUrl ?? SOLANA_RPC[cluster];
    this.rpc = createSolanaRpc(urls.http);
    this.send = sendAndConfirmTransactionFactory({ rpc: this.rpc, rpcSubscriptions: createSolanaRpcSubscriptions(urls.ws) });
  }

  get address(): Address {
    return this.signer.address;
  }

  async tokenBalance(mint: Address = USDC_MINT[this.cluster]): Promise<bigint> {
    const [ata] = await findAssociatedTokenPda({ owner: this.signer.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    try {
      const { value } = await this.rpc.getTokenAccountBalance(ata).send();
      return BigInt(value.amount);
    } catch {
      return 0n;
    }
  }

  /** Send `amount` (base units) of `mint` to `toOwner` with the reference as memo. Returns the signature. */
  async transferWithReference(args: { toOwner: string; amount: bigint; reference: Hex; mint?: Address; decimals?: number }): Promise<string> {
    const instructions = await buildTransferWithMemo({
      from: this.signer,
      toOwner: address(args.toOwner),
      mint: args.mint ?? USDC_MINT[this.cluster],
      amount: args.amount,
      decimals: args.decimals ?? 6,
      reference: args.reference,
    });
    const { value: blockhash } = await this.rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(this.signer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    );
    const tx = await signTransactionMessageWithSigners(message);
    await this.send(tx as Parameters<typeof this.send>[0], { commitment: "confirmed" });
    return getSignatureFromTransaction(tx);
  }

  /**
   * Observer: recent transactions touching this vault that carry a Corridor
   * memo. The memo program logs "Memo (len N): \"…\"" in the transaction logs.
   */
  async recentReferencedTransfers(limit = 20): Promise<Observation[]> {
    const sigs = await this.rpc.getSignaturesForAddress(this.signer.address, { limit }).send();
    const out: Observation[] = [];
    for (const s of sigs) {
      if (s.err || !s.memo) continue;
      const hex = extractReference(s.memo);
      if (!hex) continue;
      out.push({
        venue: "solana",
        externalRef: s.signature,
        reference: hex,
        asset: "USDC",
        amount: 0n, // amount is resolved from the transaction's token balance deltas when reconciling
        observedAt: new Date(Number(s.blockTime ?? 0) * 1000),
        blockNumber: BigInt(s.slot),
      });
    }
    return out;
  }
}

/** RPC `memo` fields look like `[N] corridor:<hex>`; pull the Corridor Reference out if present. */
export function extractReference(memoField: string): Hex | null {
  const m = /corridor:[0-9a-f]{64}/.exec(memoField);
  const hex = m ? fromSolanaMemo(m[0]) : null;
  return hex && tryDecodeRef(hex) ? hex : null;
}

export { MEMO_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
