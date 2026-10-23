import { AccountRole, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction, type TransactionSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { DOMAIN, type CctpNetwork } from "./domains.ts";
import { depositInstruction } from "./deposit.ts";

/**
 * Burning USDC on Solana, the outbound half of CCTP.
 *
 * This is the part that was deliberately left unwritten: the shape is an
 * Anchor instruction whose argument order and twenty-account list are the
 * whole risk, and Circle's prose did not give them. They come from Circle's
 * own Solana quickstart and its Solana programs reference, checked on
 * 23 October 2026, and the encoder is tested byte for byte.
 */

export const SOLANA_CCTP = {
  tokenMessengerMinter: "CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe" as Address,
  messageTransmitter: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" as Address,
  associatedToken: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address,
} as const;

/** Anchor instruction discriminators, as Circle's quickstart lists them. */
export const DISCRIMINATOR = {
  depositForBurn: Uint8Array.from([215, 60, 61, 46, 114, 55, 128, 176]),
  depositForBurnWithHook: Uint8Array.from([111, 245, 62, 131, 204, 108, 223, 155]),
} as const;

/** Circle attests a standard transfer at the finalized level. 1000 is the fast lane. */
export const STANDARD_FINALITY_THRESHOLD = 2000;

export interface DepositForBurnArgs {
  amount: bigint;
  destinationDomain: number;
  /** 32 bytes. On Stellar this is the forwarder contract, never an account. */
  mintRecipient: Uint8Array;
  /** 32 bytes; all zeros leaves the message callable by anyone. */
  destinationCaller: Uint8Array;
  maxFee: bigint;
  minFinalityThreshold?: number;
  /** Present for `depositForBurnWithHook`. */
  hookData?: Uint8Array;
}

/**
 * The instruction data, in Anchor's layout: the discriminator, then each
 * argument little-endian in declaration order, with `hookData` as a Borsh
 * `Vec<u8>` — a u32 length followed by the bytes.
 */
export function encodeDepositForBurn(args: DepositForBurnArgs): Uint8Array {
  assertBytes32("mintRecipient", args.mintRecipient);
  assertBytes32("destinationCaller", args.destinationCaller);
  const hook = args.hookData;
  const head = Buffer.alloc(8 + 8 + 4 + 32 + 32 + 8 + 4);
  Buffer.from(hook ? DISCRIMINATOR.depositForBurnWithHook : DISCRIMINATOR.depositForBurn).copy(head, 0);
  head.writeBigUInt64LE(args.amount, 8);
  head.writeUInt32LE(args.destinationDomain, 16);
  Buffer.from(args.mintRecipient).copy(head, 20);
  Buffer.from(args.destinationCaller).copy(head, 52);
  head.writeBigUInt64LE(args.maxFee, 84);
  head.writeUInt32LE(args.minFinalityThreshold ?? STANDARD_FINALITY_THRESHOLD, 92);
  if (!hook) return new Uint8Array(head);
  const tail = Buffer.alloc(4 + hook.length);
  tail.writeUInt32LE(hook.length, 0);
  Buffer.from(hook).copy(tail, 4);
  return new Uint8Array(Buffer.concat([head, tail]));
}

function assertBytes32(name: string, value: Uint8Array): void {
  if (value.length !== 32) throw new Error(`${name} must be 32 bytes, got ${value.length}`);
}

const addresses = getAddressEncoder();
/** The kit's encoder hands back a readonly view; PDA seeds want a plain array. */
const encoder = { encode: (a: Address) => Uint8Array.from(addresses.encode(a)) };
const seed = (text: string) => new TextEncoder().encode(text);

/**
 * Every account `depositForBurn` takes, in the order the program expects.
 * Order is part of the ABI, so it is written out once and tested.
 */
export type Party = Address | TransactionSigner;

const addressOf = (party: Party): Address => (typeof party === "string" ? party : party.address);

export async function depositForBurnAccounts(args: {
  payer: Party;
  owner: Party;
  usdcMint: Address;
  destinationDomain: number;
  /** Fresh each burn: the message transmitter stores its `MessageSent` event here. */
  messageSentEventAccount: Party;
}): Promise<Instruction["accounts"]> {
  const tmm = SOLANA_CCTP.tokenMessengerMinter;
  const mtp = SOLANA_CCTP.messageTransmitter;
  const pda = async (programAddress: Address, seeds: Uint8Array[]) => (await getProgramDerivedAddress({ programAddress, seeds }))[0];

  const [senderAuthority, denylist, messageTransmitter, tokenMessenger, remoteTokenMessenger, tokenMinter, localToken, eventAuthority, mtpEventAuthority] =
    await Promise.all([
      pda(tmm, [seed("sender_authority")]),
      pda(tmm, [seed("denylist_account"), encoder.encode(addressOf(args.owner))]),
      pda(mtp, [seed("message_transmitter")]),
      pda(tmm, [seed("token_messenger")]),
      pda(tmm, [seed("remote_token_messenger"), seed(String(args.destinationDomain))]),
      pda(tmm, [seed("token_minter")]),
      pda(tmm, [seed("local_token"), encoder.encode(args.usdcMint)]),
      pda(tmm, [seed("__event_authority")]),
      pda(mtp, [seed("__event_authority")]),
    ]);

  // The owner's USDC account, derived the way the associated-token program does.
  const senderUsdc = await pda(SOLANA_CCTP.associatedToken, [
    encoder.encode(addressOf(args.owner)),
    encoder.encode(TOKEN_PROGRAM_ADDRESS),
    encoder.encode(args.usdcMint),
  ]);

  const ro = (address: Address) => ({ address, role: AccountRole.READONLY });
  const rw = (address: Address) => ({ address, role: AccountRole.WRITABLE });
  /** Carries the signer itself when given one, so the kit can resolve it. */
  const signer = (party: Party) =>
    typeof party === "string"
      ? { address: party, role: AccountRole.WRITABLE_SIGNER }
      : { address: party.address, role: AccountRole.WRITABLE_SIGNER, signer: party };

  return [
    signer(args.payer),
    signer(args.owner),
    ro(senderAuthority),
    rw(senderUsdc),
    ro(denylist),
    rw(messageTransmitter),
    ro(tokenMessenger),
    ro(remoteTokenMessenger),
    ro(tokenMinter),
    rw(localToken),
    rw(args.usdcMint),
    signer(args.messageSentEventAccount),
    ro(mtp),
    ro(tmm),
    ro(TOKEN_PROGRAM_ADDRESS),
    ro(SYSTEM_PROGRAM_ADDRESS),
    ro(eventAuthority),
    ro(tmm),
    ro(mtpEventAuthority),
    ro(mtp),
  ];
}

/** The whole instruction, ready to sign. */
export async function buildDepositForBurn(args: {
  payer: Party;
  owner: Party;
  usdcMint: Address;
  messageSentEventAccount: Party;
} & DepositForBurnArgs): Promise<Instruction> {
  return {
    programAddress: SOLANA_CCTP.tokenMessengerMinter,
    accounts: await depositForBurnAccounts(args),
    data: encodeDepositForBurn(args),
  };
}

/**
 * Burn USDC on Solana so it mints on Stellar, for a Stellar account.
 *
 * The addressing comes from `depositInstruction`, the same function that
 * tells an external sender what to put in a burn — so the two halves of the
 * lane cannot disagree about where the money goes. CCTP treats
 * `mintRecipient` as a contract, so it is the forwarder and the beneficiary
 * rides in hook data.
 */
export async function buildBurnToStellar(args: {
  payer: Party;
  owner: Party;
  usdcMint: Address;
  messageSentEventAccount: Party;
  /** Amount in Solana's 6-decimal USDC base units. */
  amount: bigint;
  recipient: string;
  network: CctpNetwork;
  maxFee?: bigint;
  minFinalityThreshold?: number;
}): Promise<Instruction> {
  const target = depositInstruction({ recipient: args.recipient, network: args.network });
  if (target.destinationDomain !== DOMAIN.stellar) throw new Error("this burn targets Stellar");
  const hex = (value: `0x${string}`) => Uint8Array.from(Buffer.from(value.slice(2), "hex"));
  return buildDepositForBurn({
    payer: args.payer,
    owner: args.owner,
    usdcMint: args.usdcMint,
    messageSentEventAccount: args.messageSentEventAccount,
    amount: args.amount,
    destinationDomain: target.destinationDomain,
    mintRecipient: hex(target.mintRecipient),
    destinationCaller: hex(target.destinationCaller),
    maxFee: args.maxFee ?? 0n,
    minFinalityThreshold: args.minFinalityThreshold ?? target.minFinalityThreshold,
    hookData: hex(target.hookData),
  });
}
