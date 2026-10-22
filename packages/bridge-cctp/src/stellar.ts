import { Contract, TransactionBuilder, nativeToScVal, rpc } from "@stellar/stellar-sdk";
import type { StellarSigner } from "@corridor/chain-stellar";
import { STELLAR_CONTRACTS, type CctpNetwork } from "./domains.ts";
import { decodeForwardHook } from "./hook.ts";
import type { CctpMessage } from "./iris.ts";

/**
 * The receiving half on Stellar. `mint_and_forward` hands Circle's message
 * and attestation to the forwarder contract, which verifies them, mints the
 * USDC to itself and pays it straight on to the account named in the hook
 * data — one transaction, with Circle never holding the balance in between.
 */

/** Soroban RPC. SDF publishes a testnet endpoint; mainnet is a provider or your own node. */
const DEFAULT_RPC: Partial<Record<CctpNetwork, string>> = {
  testnet: "https://soroban-testnet.stellar.org",
};

export interface StellarMintOptions {
  network: CctpNetwork;
  /** Required on mainnet, where there is no public SDF endpoint. */
  rpcUrl?: string;
  signer: StellarSigner;
  passphrase: string;
  /** Overrides the forwarder from the registry (a local or forked network). */
  forwarder?: string;
  fee?: string;
  /** Swapped out in tests. */
  server?: Pick<rpc.Server, "getAccount" | "prepareTransaction" | "sendTransaction" | "getTransaction">;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with the hash the moment the mint is submitted, before waiting for
   * it to settle. A caller that must not mint twice records it here, so a
   * crash in the wait is recoverable.
   */
  onSubmitted?: (hash: string) => Promise<void>;
}

function serverFor(opts: StellarMintOptions) {
  if (opts.server) return opts.server;
  const url = opts.rpcUrl ?? DEFAULT_RPC[opts.network];
  if (!url) throw new Error(`set rpcUrl: there is no default Soroban RPC for ${opts.network}`);
  return new rpc.Server(url);
}

export interface MintResult {
  txHash: string;
  /** The account the forwarder paid, read back out of the hook data. */
  recipient: string;
}

/**
 * Replay an attested CCTP message on Stellar.
 *
 * The hook data is decoded first, so the recipient this will actually pay is
 * checked before anything is signed — the same habit as verifying a SEP-10
 * challenge. CCTP is replay-protected by nonce on the contract side, so a
 * retry after a crash costs a failed simulation rather than a double mint.
 */
export async function mintAndForward(
  message: CctpMessage,
  hookData: Uint8Array,
  opts: StellarMintOptions,
): Promise<MintResult> {
  const { recipient } = decodeForwardHook(hookData);
  const forwarder = opts.forwarder ?? STELLAR_CONTRACTS[opts.network].cctpForwarder;
  const server = serverFor(opts);

  const source = await server.getAccount(opts.signer.address);
  const contract = new Contract(forwarder);
  const built = new TransactionBuilder(source, { fee: opts.fee ?? "100", networkPassphrase: opts.passphrase })
    .addOperation(
      contract.call(
        "mint_and_forward",
        nativeToScVal(Buffer.from(message.message.replace(/^0x/, ""), "hex"), { type: "bytes" }),
        nativeToScVal(Buffer.from(message.attestation.replace(/^0x/, ""), "hex"), { type: "bytes" }),
      ),
    )
    .setTimeout(180)
    .build();

  // Simulation decides the footprint and the resource fee, so it has to run
  // before signing: the prepared transaction is a different transaction.
  const prepared = await server.prepareTransaction(built);
  prepared.addSignature(opts.signer.address, Buffer.from(await opts.signer.sign(prepared.hash())).toString("base64"));

  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`Stellar refused the CCTP mint: ${JSON.stringify(sent.errorResult ?? {})}`);
  await opts.onSubmitted?.(sent.hash);

  const settled = await waitForTx(server, sent.hash, opts.sleep);
  if (settled.status !== "SUCCESS") throw new Error(`CCTP mint ${sent.hash} did not succeed: ${settled.status}`);
  return { txHash: sent.hash, recipient };
}

async function waitForTx(
  server: Pick<rpc.Server, "getTransaction">,
  hash: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  attempts = 30,
) {
  for (let i = 0; ; i++) {
    const got = await server.getTransaction(hash);
    if (got.status !== "NOT_FOUND") return got;
    if (i >= attempts) throw new Error(`CCTP mint ${hash} was submitted but never settled`);
    await sleep(1_000);
  }
}

/**
 * Whether this message has already been minted on Stellar.
 *
 * Circle reports a message as `complete` once it is attested, not once it is
 * minted, so a resumed saga asks the chain. A mint is a contract call, so the
 * evidence is the transaction, not a classic payment operation.
 */
export async function receivedOnStellar(txHash: string, opts: StellarMintOptions): Promise<boolean> {
  const server = serverFor(opts);
  const got = await server.getTransaction(txHash);
  return got.status === "SUCCESS";
}
