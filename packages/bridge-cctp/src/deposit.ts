import { rescale } from "@corridor/core";
import { DOMAIN, SOURCE_USDC_DECIMALS, STELLAR_CONTRACTS, type CctpNetwork } from "./domains.ts";
import { contractToBytes32, encodeForwardHook } from "./hook.ts";

/**
 * What a sender has to put in a CCTP burn for the funds to land on a Stellar
 * account. Corridor hands this out rather than burning itself: on the way in,
 * the USDC is the user's, on the user's own chain, and Corridor never holds
 * it. Ramp gives an app these fields; the app's wallet makes the burn.
 *
 * The two addresses are the forwarder, not the beneficiary. CCTP treats
 * `mintRecipient` as a contract, so a burn aimed at a G… account mints
 * nowhere and the funds cannot be recovered — which is why this is computed
 * in one place and tested.
 */
export interface DepositInstruction {
  /** Circle's id for Stellar. */
  destinationDomain: number;
  /** The forwarder contract, as the 32-byte field CCTP carries. */
  mintRecipient: `0x${string}`;
  /** The same contract: only it may replay the message. */
  destinationCaller: `0x${string}`;
  /** The beneficiary, for the forwarder to pay on to. */
  hookData: `0x${string}`;
  /** For a human or a log: the contract the two address fields point at. */
  forwarder: string;
  /** The account the forwarder will pay. */
  recipient: string;
  /** Decimals the amount must be expressed in on the source chain. */
  amountDecimals: number;
  /** `minFinalityThreshold` for a standard (finalized) transfer. */
  minFinalityThreshold: number;
}

/** Circle attests a standard transfer at the finalized level. */
export const STANDARD_FINALITY_THRESHOLD = 2000;

export function depositInstruction(args: { recipient: string; network: CctpNetwork; forwarder?: string }): DepositInstruction {
  const forwarder = args.forwarder ?? STELLAR_CONTRACTS[args.network].cctpForwarder;
  const asHex = (b: Uint8Array) => `0x${Buffer.from(b).toString("hex")}` as `0x${string}`;
  const address = asHex(contractToBytes32(forwarder));
  return {
    destinationDomain: DOMAIN.stellar,
    mintRecipient: address,
    destinationCaller: address,
    hookData: asHex(encodeForwardHook(args.recipient)),
    forwarder,
    recipient: args.recipient,
    amountDecimals: SOURCE_USDC_DECIMALS,
    minFinalityThreshold: STANDARD_FINALITY_THRESHOLD,
  };
}

/**
 * The amount to book on the hub for a burn of `sourceAmount`.
 *
 * USDC is 6 decimals on the chains Corridor receives from and 7 on Stellar,
 * so this is an exact scale up. `rescale` is used rather than a multiply so
 * the direction that *can* lose value is refused everywhere by one rule.
 */
export function hubAmountOf(sourceAmount: bigint): bigint {
  return rescale(sourceAmount, SOURCE_USDC_DECIMALS, 7);
}
