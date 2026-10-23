import { describe, expect, it, vi } from "vitest";
import { Account, Keypair, Networks, StrKey, Transaction } from "@stellar/stellar-sdk";
import { localStellarSigner } from "@corridor/chain-stellar";
import { DOMAIN, STELLAR_CONTRACTS, chainOfDomain } from "./domains.ts";
import { bytes32ToContract, contractToBytes32, decodeForwardHook, encodeForwardHook, evmToBytes32 } from "./hook.ts";
import { STANDARD_FINALITY_THRESHOLD, depositInstruction, hubAmountOf } from "./deposit.ts";
import { Iris, IrisError, type CctpMessage } from "./iris.ts";
import { mintAndForward } from "./stellar.ts";

const FORWARDER = STELLAR_CONTRACTS.testnet.cctpForwarder;
const account = () => Keypair.random().publicKey();

describe("CCTP domains", () => {
  it("uses Circle's own numbering, not chain ids", () => {
    expect(DOMAIN).toMatchObject({ ethereum: 0, solana: 5, base: 6, stellar: 27 });
    expect(chainOfDomain(27)).toBe("stellar");
    expect(() => chainOfDomain(99)).toThrow(/no CCTP chain for domain 99/);
  });
});

describe("hook data", () => {
  it("lays the recipient out behind the 32-byte header Circle specifies", () => {
    const recipient = account();
    const hook = Buffer.from(encodeForwardHook(recipient));
    expect(hook.length).toBe(32 + recipient.length);
    expect(hook.subarray(0, 24).every((b) => b === 0)).toBe(true);
    expect(hook.readUInt32BE(24)).toBe(0); // hook version
    expect(hook.readUInt32BE(28)).toBe(recipient.length);
    expect(hook.subarray(32).toString("utf8")).toBe(recipient);
  });

  it("round-trips accounts, contracts and muxed accounts", () => {
    for (const recipient of [account(), FORWARDER]) {
      expect(decodeForwardHook(encodeForwardHook(recipient))).toEqual({ version: 0, recipient });
    }
  });

  it("refuses anything that is not a Stellar address", () => {
    expect(() => encodeForwardHook("0x1234")).toThrow(/not a Stellar account, contract or muxed address/);
    expect(() => encodeForwardHook("")).toThrow();
  });

  it("refuses hook data whose declared length does not match its body", () => {
    const hook = Buffer.from(encodeForwardHook(account()));
    hook.writeUInt32BE(99, 28);
    expect(() => decodeForwardHook(hook)).toThrow(/carries/);
  });

  it("refuses a header that is not zero-padded", () => {
    const hook = Buffer.from(encodeForwardHook(account()));
    hook[0] = 1;
    expect(() => decodeForwardHook(hook)).toThrow(/zero-padded/);
  });

  it("converts a contract id to the 32-byte field and back", () => {
    const bytes = contractToBytes32(FORWARDER);
    expect(bytes).toHaveLength(32);
    expect(bytes32ToContract(bytes)).toBe(FORWARDER);
    expect(() => contractToBytes32(account())).toThrow(/not a Stellar contract id/);
  });

  it("left-pads an EVM address into the 32-byte field", () => {
    const bytes = evmToBytes32("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
    expect(bytes).toHaveLength(32);
    expect(bytes.subarray(0, 12).every((b) => b === 0)).toBe(true);
    expect(Buffer.from(bytes.subarray(12)).toString("hex")).toBe("28b5a0e9c621a5badaa536219b3a228c8168cf5d");
    expect(() => evmToBytes32("0xdeadbeef")).toThrow(/not an EVM address/);
  });
});

describe("deposit instruction", () => {
  it("points CCTP at the forwarder, never at the beneficiary", () => {
    const recipient = account();
    const i = depositInstruction({ recipient, network: "testnet" });

    // The whole point: a burn aimed at the beneficiary mints nowhere.
    const forwarderField = `0x${Buffer.from(contractToBytes32(FORWARDER)).toString("hex")}`;
    expect(i.mintRecipient).toBe(forwarderField);
    expect(i.destinationCaller).toBe(forwarderField);
    expect(i.mintRecipient).not.toContain(Buffer.from(recipient, "utf8").toString("hex"));
    expect(StrKey.isValidContract(bytes32ToContract(Buffer.from(i.mintRecipient.slice(2), "hex")))).toBe(true);

    // And the beneficiary travels in the hook instead.
    expect(decodeForwardHook(Buffer.from(i.hookData.slice(2), "hex")).recipient).toBe(recipient);
    expect(i).toMatchObject({ destinationDomain: 27, amountDecimals: 6, minFinalityThreshold: STANDARD_FINALITY_THRESHOLD });
  });
});

describe("amounts across the boundary", () => {
  it("scales a 6 dp burn into the hub's 7 dp exactly", () => {
    expect(hubAmountOf(1_000_000n)).toBe(10_000_000n); // 1 USDC
    expect(hubAmountOf(2_900_000n)).toBe(29_000_000n);
  });
});

describe("Iris", () => {
  const burn = { sourceDomain: DOMAIN.base, transactionHash: "0xabc" };
  const iris = (impl: typeof fetch) => new Iris({ network: "testnet", fetch: impl });
  const complete: CctpMessage = { message: "0x01", attestation: "0xaa", status: "complete" };

  it("treats a 404 as not indexed yet, not an error", async () => {
    const seen = await iris((async () => new Response("", { status: 404 })) as unknown as typeof fetch).messages(burn);
    expect(seen).toEqual([]);
  });

  it("waits while Circle is still confirming", async () => {
    const pending = { ...complete, status: "pending_confirmations", attestation: "0x" as const };
    const got = await iris((async () => Response.json({ messages: [pending] })) as unknown as typeof fetch).attested(burn);
    expect(got).toBeNull();
  });

  it("returns the attested message once it is complete", async () => {
    const got = await iris((async () => Response.json({ messages: [complete] })) as unknown as typeof fetch).attested(burn);
    expect(got).toMatchObject({ status: "complete", attestation: "0xaa" });
  });

  it("asks the right url for the source domain", async () => {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return Response.json({ messages: [complete] });
    }) as unknown as typeof fetch;
    await iris(impl).attested(burn);
    expect(calls[0]).toBe("https://iris-api-sandbox.circle.com/v2/messages/6?transactionHash=0xabc");
  });

  it("refuses a domain Corridor does not know before calling out", async () => {
    const impl = vi.fn() as unknown as typeof fetch;
    await expect(iris(impl).messages({ sourceDomain: 99, transactionHash: "0x1" })).rejects.toThrow(/no CCTP chain/);
    expect(impl).not.toHaveBeenCalled();
  });

  it("backs off on a rate limit rather than hammering Circle", async () => {
    let calls = 0;
    const impl = (async () => {
      calls++;
      return calls === 1 ? new Response("", { status: 429 }) : Response.json({ messages: [complete] });
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const got = await iris(impl).waitForAttestation({ ...burn, pollMs: 100, sleep: async (ms) => void waits.push(ms) });
    expect(got.status).toBe("complete");
    expect(waits).toEqual([200]); // doubled from the poll interval
  });

  it("gives up with a retryable error at the timeout", async () => {
    const impl = (async () => Response.json({ messages: [] })) as unknown as typeof fetch;
    await expect(
      iris(impl).waitForAttestation({ ...burn, pollMs: 10, timeoutMs: 0, sleep: async () => {} }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe("minting on Stellar", () => {
  const message: CctpMessage = { message: "0xdeadbeef", attestation: "0xfeed", status: "complete" };

  function fakeServer(over: { status?: "SUCCESS" | "FAILED"; sendStatus?: "PENDING" | "ERROR" } = {}) {
    const calls: string[] = [];
    let prepared: Transaction | undefined;
    return {
      calls,
      get prepared() {
        return prepared;
      },
      server: {
        getAccount: async (address: string) => {
          calls.push("getAccount");
          return new Account(address, "7");
        },
        prepareTransaction: async (tx: Transaction) => {
          calls.push("prepareTransaction");
          prepared = tx;
          return tx;
        },
        sendTransaction: async (tx: Transaction) => {
          calls.push("sendTransaction");
          // Signing must happen before submission, on the prepared transaction.
          expect(tx.signatures).toHaveLength(1);
          return { status: over.sendStatus ?? "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), errorResult: {} };
        },
        getTransaction: async () => {
          calls.push("getTransaction");
          return { status: over.status ?? "SUCCESS" };
        },
      },
    };
  }

  const opts = (server: ReturnType<typeof fakeServer>["server"]) => ({
    network: "testnet" as const,
    signer: localStellarSigner(Keypair.random().secret()),
    passphrase: Networks.TESTNET,
    server: server as never,
    sleep: async () => {},
  });

  it("checks the hook, simulates, then signs the prepared transaction", async () => {
    const recipient = account();
    const fake = fakeServer();
    const result = await mintAndForward(message, encodeForwardHook(recipient), opts(fake.server));

    expect(result.recipient).toBe(recipient);
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/);
    // Simulation decides the footprint, so it has to come before signing.
    expect(fake.calls.indexOf("prepareTransaction")).toBeLessThan(fake.calls.indexOf("sendTransaction"));
    expect(fake.prepared!.operations[0]!.type).toBe("invokeHostFunction");
  });

  it("refuses to mint for hook data it cannot read", async () => {
    const fake = fakeServer();
    await expect(mintAndForward(message, new Uint8Array(8), opts(fake.server))).rejects.toThrow(/shorter than its header/);
    expect(fake.calls).toEqual([]); // nothing was signed or sent
  });

  it("raises when the network refuses the mint", async () => {
    const fake = fakeServer({ sendStatus: "ERROR" });
    await expect(mintAndForward(message, encodeForwardHook(account()), opts(fake.server))).rejects.toThrow(/refused the CCTP mint/);
  });

  it("raises when the mint lands but fails", async () => {
    const fake = fakeServer({ status: "FAILED" });
    await expect(mintAndForward(message, encodeForwardHook(account()), opts(fake.server))).rejects.toThrow(/did not succeed: FAILED/);
  });
});
