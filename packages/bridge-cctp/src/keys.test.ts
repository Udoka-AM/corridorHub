import { describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { solanaAddressOfStellar, stellarAccountOfSolana } from "./keys.ts";

describe("one key on two chains", () => {
  it("round-trips a Stellar account through its Solana address", () => {
    for (let i = 0; i < 5; i++) {
      const account = Keypair.random().publicKey();
      const solana = solanaAddressOfStellar(account);
      expect(solana).not.toBe(account);
      expect(stellarAccountOfSolana(solana)).toBe(account);
    }
  });

  it("gives a 32-byte base58 address Solana will accept", () => {
    const solana = solanaAddressOfStellar(Keypair.random().publicKey());
    // base58 of 32 bytes is 43 or 44 characters, and excludes 0, O, I and l.
    expect(solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("refuses a Stellar secret where an account was meant", () => {
    // S… decodes as a valid StrKey, so a mix-up would otherwise produce a
    // plausible Solana address that nobody holds the key for.
    expect(() => solanaAddressOfStellar(Keypair.random().secret())).toThrow();
  });

  it("refuses a muxed account", () => {
    // M… addresses carry a 64-bit id after the key, so they are not 32 bytes
    // and cannot name a Solana account.
    expect(() => solanaAddressOfStellar("MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK")).toThrow();
  });
});
