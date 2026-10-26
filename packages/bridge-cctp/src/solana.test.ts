import { describe, expect, it } from "vitest";
import { AccountRole, address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { DOMAIN, STELLAR_CONTRACTS } from "./domains.ts";
import { depositForBurnArgs } from "./stellar.ts";
import { contractToBytes32, decodeForwardHook } from "./hook.ts";
import {
  DISCRIMINATOR,
  SOLANA_CCTP,
  STANDARD_FINALITY_THRESHOLD,
  buildBurnToStellar,
  depositForBurnAccounts,
  encodeDepositForBurn,
} from "./solana.ts";

const PAYER = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const OWNER = address("DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK");
const USDC = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const EVENT = address("11111111111111111111111111111112");

const thirtyTwo = (fill: number) => new Uint8Array(32).fill(fill);

const base = {
  amount: 2_900_000n, // 2.90 USDC at Solana's 6 dp
  destinationDomain: DOMAIN.stellar,
  mintRecipient: thirtyTwo(0xaa),
  destinationCaller: thirtyTwo(0xbb),
  maxFee: 500n,
};

describe("depositForBurn instruction data", () => {
  it("lays the arguments out in Anchor's order, little-endian", () => {
    const data = Buffer.from(encodeDepositForBurn(base));
    expect(data.length).toBe(96);
    expect(data.subarray(0, 8)).toEqual(Buffer.from(DISCRIMINATOR.depositForBurn));
    expect(data.readBigUInt64LE(8)).toBe(2_900_000n);
    expect(data.readUInt32LE(16)).toBe(27); // Stellar
    expect(data.subarray(20, 52).every((b) => b === 0xaa)).toBe(true);
    expect(data.subarray(52, 84).every((b) => b === 0xbb)).toBe(true);
    expect(data.readBigUInt64LE(84)).toBe(500n);
    expect(data.readUInt32LE(92)).toBe(STANDARD_FINALITY_THRESHOLD);
  });

  it("defaults to the standard finality threshold, and takes an override", () => {
    expect(Buffer.from(encodeDepositForBurn(base)).readUInt32LE(92)).toBe(2000);
    expect(Buffer.from(encodeDepositForBurn({ ...base, minFinalityThreshold: 1000 })).readUInt32LE(92)).toBe(1000);
  });

  it("switches discriminator and appends the hook as a Borsh vector", () => {
    const hook = Uint8Array.from([1, 2, 3, 4, 5]);
    const data = Buffer.from(encodeDepositForBurn({ ...base, hookData: hook }));
    expect(data.subarray(0, 8)).toEqual(Buffer.from(DISCRIMINATOR.depositForBurnWithHook));
    expect(data.length).toBe(96 + 4 + hook.length);
    expect(data.readUInt32LE(96)).toBe(hook.length);
    expect(data.subarray(100)).toEqual(Buffer.from(hook));
  });

  it("refuses an address field that is not 32 bytes", () => {
    expect(() => encodeDepositForBurn({ ...base, mintRecipient: new Uint8Array(20) })).toThrow(/mintRecipient must be 32 bytes/);
    expect(() => encodeDepositForBurn({ ...base, destinationCaller: new Uint8Array(0) })).toThrow(/destinationCaller must be 32 bytes/);
  });
});

describe("depositForBurn accounts", () => {
  const accounts = () =>
    depositForBurnAccounts({ payer: PAYER, owner: OWNER, usdcMint: USDC, destinationDomain: DOMAIN.stellar, messageSentEventAccount: EVENT });

  it("passes twenty accounts, in the order the program expects", async () => {
    const list = (await accounts())!;
    expect(list).toHaveLength(20);
    expect(list.map((a) => a.address)).toEqual([
      PAYER,
      OWNER,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      USDC,
      EVENT,
      SOLANA_CCTP.messageTransmitter,
      SOLANA_CCTP.tokenMessengerMinter,
      TOKEN_PROGRAM_ADDRESS,
      SYSTEM_PROGRAM_ADDRESS,
      expect.any(String),
      SOLANA_CCTP.tokenMessengerMinter,
      expect.any(String),
      SOLANA_CCTP.messageTransmitter,
    ]);
  });

  it("marks exactly the payer, the owner and the event account as signers", async () => {
    const list = (await accounts())!;
    const signers = list.flatMap((a, i) => (a.role === AccountRole.WRITABLE_SIGNER ? [i] : []));
    expect(signers).toEqual([0, 1, 11]);
  });

  it("marks the accounts the program writes to", async () => {
    const list = (await accounts())!;
    const writable = list.flatMap((a, i) => (a.role === AccountRole.WRITABLE ? [i] : []));
    // The sender's token account, the message transmitter, the local token and the mint.
    expect(writable).toEqual([3, 5, 9, 10]);
  });

  it("carries a signer object through, so the transaction can be signed", async () => {
    // The event account is generated per burn, so its signer has to reach the
    // transaction builder rather than just its address.
    const eventSigner = { address: EVENT, signTransactions: async () => [] };
    const list = (await depositForBurnAccounts({
      payer: PAYER,
      owner: OWNER,
      usdcMint: USDC,
      destinationDomain: DOMAIN.stellar,
      messageSentEventAccount: eventSigner as never,
    }))!;
    expect(list[11]).toMatchObject({ address: EVENT, role: AccountRole.WRITABLE_SIGNER, signer: eventSigner });
    // An address alone carries no signer, which is right for a build-only call.
    expect(list[0]).toEqual({ address: PAYER, role: AccountRole.WRITABLE_SIGNER });
  });

  it("derives the remote token messenger from the destination domain", async () => {
    const forStellar = (await accounts())!;
    const forBase = (await depositForBurnAccounts({
      payer: PAYER,
      owner: OWNER,
      usdcMint: USDC,
      destinationDomain: DOMAIN.base,
      messageSentEventAccount: EVENT,
    }))!;
    expect(forStellar[7]!.address).not.toBe(forBase[7]!.address);
    // Everything else is the same.
    expect(forStellar.filter((_, i) => i !== 7).map((a) => a.address)).toEqual(forBase.filter((_, i) => i !== 7).map((a) => a.address));
  });
});

describe("burning to Stellar", () => {
  it("addresses the forwarder, not the beneficiary, and agrees with the deposit instruction", async () => {
    const recipient = Keypair.random().publicKey();
    const ix = await buildBurnToStellar({
      payer: PAYER,
      owner: OWNER,
      usdcMint: USDC,
      messageSentEventAccount: EVENT,
      amount: 2_900_000n,
      recipient,
      network: "testnet",
    });

    expect(ix.programAddress).toBe(SOLANA_CCTP.tokenMessengerMinter);
    const data = Buffer.from(ix.data!);
    expect(data.subarray(0, 8)).toEqual(Buffer.from(DISCRIMINATOR.depositForBurnWithHook));
    expect(data.readUInt32LE(16)).toBe(DOMAIN.stellar);

    // The two address fields are the forwarder contract — a burn aimed at the
    // beneficiary mints nowhere and cannot be recovered.
    const forwarder = Buffer.from(contractToBytes32(STELLAR_CONTRACTS.testnet.cctpForwarder));
    expect(data.subarray(20, 52)).toEqual(forwarder);
    expect(data.subarray(52, 84)).toEqual(forwarder);

    // And the beneficiary rides in the hook, readable by the same decoder the
    // Stellar side uses: the two halves of the lane cannot disagree.
    const hookLength = data.readUInt32LE(96);
    expect(decodeForwardHook(data.subarray(100, 100 + hookLength))).toEqual({ version: 0, recipient });
  });
});

describe("burning on Stellar", () => {
  const base = {
    amount: 29_000_000n, // 2.90 USDC at the hub's 7 dp
    destinationDomain: DOMAIN.solana,
    mintRecipient: new Uint8Array(32).fill(0xcc),
  };
  const caller = Keypair.random().publicKey();
  const burnToken = STELLAR_CONTRACTS.testnet.tokenMessengerMinter; // any contract id will do here

  const kinds = (vals: ReturnType<typeof depositForBurnArgs>) => vals.map((v) => (v as unknown as { type: string }).type);

  it("orders the arguments the way the deployed contract declares them", () => {
    // Read off the contract's own interface spec: burn_token sits between
    // mint_recipient and destination_caller, which is not where the EVM or
    // Solana entry points put it.
    expect(kinds(depositForBurnArgs(caller, burnToken, base))).toEqual([
      "scvAddress", // caller
      "scvI128", // amount
      "scvU32", // destination_domain
      "scvBytes", // mint_recipient
      "scvAddress", // burn_token
      "scvBytes", // destination_caller
      "scvI128", // max_fee
      "scvU32", // min_finality_threshold
    ]);
  });

  it("appends hook data only for the hook variant", () => {
    const withHook = depositForBurnArgs(caller, burnToken, { ...base, hookData: Uint8Array.from([1, 2, 3]) });
    expect(kinds(withHook)).toHaveLength(9);
    expect(kinds(withHook).at(-1)).toBe("scvBytes");
  });

  it("carries the amount as i128, not a 64-bit number", () => {
    // A u64 would silently truncate a large balance; the contract takes i128.
    const big = 2n ** 80n;
    const [, amount] = depositForBurnArgs(caller, burnToken, { ...base, amount: big });
    expect(scValToNative(amount!)).toBe(big);
  });

  it("defaults to an open destination caller and the standard finality", () => {
    const vals = depositForBurnArgs(caller, burnToken, base);
    expect(Uint8Array.from(scValToNative(vals[5]!))).toEqual(new Uint8Array(32)); // anyone may call it
    expect(scValToNative(vals[7]!)).toBe(2000);
  });

  it("refuses an address field that is not 32 bytes", () => {
    expect(() => depositForBurnArgs(caller, burnToken, { ...base, mintRecipient: new Uint8Array(20) })).toThrow(/mintRecipient must be 32 bytes/);
  });
});
