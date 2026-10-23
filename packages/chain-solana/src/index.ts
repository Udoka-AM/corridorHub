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
  type TransactionSigner,
} from "@solana/kit";
import {
  TOKEN_PROGRAM_ADDRESS,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token";
import { MEMO_PROGRAM_ADDRESS, getAddMemoInstruction } from "@solana-program/memo";
import { toSolanaMemo, type Hex, type Observation, type Stablecoin } from "@corridor/core";
import { solanaStable, type SolanaCluster } from "./stables.ts";
import { SolanaWatcher } from "./watcher.ts";

export { SOLANA_STABLES, TOKEN_2022_PROGRAM_ADDRESS, solanaStable, stableByMint, type SolanaCluster, type SolanaStable } from "./stables.ts";
export { SOLANA_ACCOUNT_RENT, SOLANA_FEES, SolanaWatcher, extractReference, nativeMovements, tokenDeltas, type NativeTx, type TokenBalanceMeta, type TokenDelta } from "./watcher.ts";

/**
 * Solana leg: stablecoin transfers (USDC by default; USDT, PYUSD and EURC
 * through the registry) that carry the Corridor Reference as an SPL Memo in
 * the same transaction, so a partner deposit (e.g. into Paj's one-off funding
 * address) is tied to its payout on-chain.
 */

export const SOLANA_RPC: Record<SolanaCluster, { http: string; ws: string }> = {
  mainnet: { http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com" },
};

export const USDC_MINT: Record<SolanaCluster, Address> = {
  mainnet: solanaStable("mainnet", "USDC").mint,
  devnet: solanaStable("devnet", "USDC").mint,
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
  from: TransactionSigner;
  toOwner: Address;
  mint: Address;
  amount: bigint;
  decimals: number;
  reference: Hex;
  /** Token-2022 mints (e.g. PYUSD) need their own program for ATAs and transfers. */
  tokenProgram?: Address;
}): Promise<Instruction[]> {
  const tokenProgram = args.tokenProgram ?? TOKEN_PROGRAM_ADDRESS;
  const [source] = await findAssociatedTokenPda({ owner: args.from.address, mint: args.mint, tokenProgram });
  const [destination] = await findAssociatedTokenPda({ owner: args.toOwner, mint: args.mint, tokenProgram });
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: args.from,
      ata: destination,
      owner: args.toOwner,
      mint: args.mint,
      tokenProgram,
    }),
    getTransferCheckedInstruction(
      {
        source,
        mint: args.mint,
        destination,
        authority: args.from,
        amount: args.amount,
        decimals: args.decimals,
      },
      { programAddress: tokenProgram },
    ),
    getAddMemoInstruction({ memo: toSolanaMemo(args.reference) }),
  ];
}

export class SolanaVault {
  private readonly rpc;
  private readonly send;

  private readonly watcher: SolanaWatcher;

  /**
   * `signer` is any @solana/kit transaction signer: a local keypair in
   * development, or `solanaSigner(...)` from @corridor/signer wrapping the
   * customer's KMS or MPC key.
   */
  constructor(
    private readonly signer: TransactionSigner,
    readonly cluster: SolanaCluster,
    rpcUrl?: { http: string; ws: string },
  ) {
    const urls = rpcUrl ?? SOLANA_RPC[cluster];
    this.rpc = createSolanaRpc(urls.http);
    this.watcher = new SolanaWatcher(signer.address, cluster, urls.http);
    this.send = sendAndConfirmTransactionFactory({ rpc: this.rpc, rpcSubscriptions: createSolanaRpcSubscriptions(urls.ws) });
  }

  get address(): Address {
    return this.signer.address;
  }

  async tokenBalance(asset: Stablecoin = "USDC"): Promise<bigint> {
    const { mint, tokenProgram } = solanaStable(this.cluster, asset);
    const [ata] = await findAssociatedTokenPda({ owner: this.signer.address, mint, tokenProgram });
    try {
      const { value } = await this.rpc.getTokenAccountBalance(ata).send();
      return BigInt(value.amount);
    } catch {
      return 0n;
    }
  }

  /** Send `amount` (base units) of a stablecoin (USDC by default) to `toOwner` with the reference as memo. Returns the signature. */
  async transferWithReference(args: { toOwner: string; amount: bigint; reference: Hex; asset?: Stablecoin }): Promise<string> {
    const stable = solanaStable(this.cluster, args.asset ?? "USDC");
    const instructions = await buildTransferWithMemo({
      from: this.signer,
      toOwner: address(args.toOwner),
      mint: stable.mint,
      amount: args.amount,
      decimals: stable.decimals,
      reference: args.reference,
      tokenProgram: stable.tokenProgram,
    });
    return this.sendInstructions(instructions);
  }

  /**
   * Sign and send instructions this vault pays for. Any signer carried on an
   * instruction's accounts — a one-off account a program writes an event to,
   * for instance — is resolved along with the vault's own key.
   */
  async sendInstructions(instructions: Instruction[]): Promise<string> {
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
   * Observer: recent stablecoin movements in or out of this vault that carry
   * a Corridor memo, with amounts read from the transaction's balance changes.
   */
  async recentReferencedTransfers(limit = 20): Promise<Observation[]> {
    return this.watcher.recent({ limit, onlyReferenced: true });
  }
}

export { MEMO_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS };
