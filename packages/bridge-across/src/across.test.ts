import { describe, expect, it } from "vitest";
import { AcrossError, CHAINS, TOKENS, depositStatus, executeEvm, quote, waitForFill, type EvmSender } from "./index.ts";

const QUOTE = {
  id: "q-1",
  inputAmount: "5000000",
  expectedOutputAmount: "4995813",
  minOutputAmount: "4995813",
  expectedFillTime: 1,
  quoteExpiryTimestamp: Math.floor(Date.now() / 1000) + 60,
  fees: { total: { amount: "4187" } },
  approvalTxns: [{ chainId: 4217, to: "0x20C000000000000000000000b9537d11c60E8b50", data: "0x095ea7b3" }],
  swapTx: { ecosystem: "evm", chainId: 4217, to: "0x82B564983aE7274c86695917BBf8C99ECb6F0F8F", data: "0xad5425c6" },
};

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (url: string) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    const body = hit ? hit[1] : { type: "AcrossApiError", message: "no route" };
    return { ok: !(body as any).type && !(body as any).error, json: async () => body } as Response;
  }) as typeof fetch;
}

describe("Across adapter", () => {
  it("requests a firm exact-input quote for the Tempo → Base hop", async () => {
    const calls: string[] = [];
    const q = await quote(
      {
        env: "mainnet",
        originChainId: CHAINS.tempo,
        destinationChainId: CHAINS.base,
        inputToken: TOKENS.tempoPathUSD,
        outputToken: TOKENS.baseUSDC,
        amount: 5_000_000n,
        depositor: "0x0c6D2434C4540706FAA987775C8D2D6bB2e92981",
        recipient: "0x7b54A95E0708b32C6a1299C3930b9aBc06EBe43a",
      },
      fakeFetch({ "/swap/approval": QUOTE }, calls),
    );
    expect(calls[0]).toContain("https://app.across.to/api/swap/approval?tradeType=exactInput&amount=5000000");
    expect(calls[0]).toContain("originChainId=4217&destinationChainId=8453");
    expect(q.expectedOutputAmount).toBe(4_995_813n);
    expect(q.feeTotal).toBe(4_187n);
  });

  it("surfaces API errors", async () => {
    await expect(
      quote(
        { env: "testnet", originChainId: 1, destinationChainId: 2, inputToken: "a", outputToken: "b", amount: 1n, depositor: "d", recipient: "r" },
        fakeFetch({ "/swap/approval": { type: "AcrossApiError", code: "INVALID_PARAM", message: "Recipient's associated token account does not exist" } }),
      ),
    ).rejects.toThrow(/associated token account/);
  });

  it("sends approvals before the deposit and fails loudly on a revert", async () => {
    const sent: string[] = [];
    const sender: EvmSender = {
      sendTransaction: async ({ data }) => {
        sent.push(data);
        return `0x${sent.length.toString(16).padStart(64, "0")}`;
      },
      waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash }),
    };
    const q = await quote(
      { env: "mainnet", originChainId: 4217, destinationChainId: 8453, inputToken: "a", outputToken: "b", amount: 1n, depositor: "d", recipient: "r" },
      fakeFetch({ "/swap/approval": QUOTE }),
    );
    const out = await executeEvm(sender, q);
    expect(sent).toEqual(["0x095ea7b3", "0xad5425c6"]);
    expect(out.approvals).toHaveLength(1);

    const reverting: EvmSender = { ...sender, waitForTransactionReceipt: async ({ hash }) => ({ status: "reverted", transactionHash: hash }) };
    await expect(executeEvm(reverting, q)).rejects.toThrow(AcrossError);
  });

  it("reports what each transaction cost from its receipt, including Base's L1 data fee", async () => {
    let n = 0;
    const sender: EvmSender = {
      sendTransaction: async () => `0x${(++n).toString(16).padStart(64, "0")}`,
      waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash, gasUsed: 50_000n, effectiveGasPrice: 2_000_000n, l1Fee: 300_000_000n }),
    };
    const q = await quote(
      { env: "mainnet", originChainId: 8453, destinationChainId: 34268394551451, inputToken: "a", outputToken: "b", amount: 1n, depositor: "d", recipient: "r" },
      fakeFetch({ "/swap/approval": QUOTE }),
    );
    const out = await executeEvm(sender, q);
    expect(out.gas).toHaveLength(2);
    expect(out.gas.every((g) => g.wei === 50_000n * 2_000_000n + 300_000_000n)).toBe(true);
  });

  it("refuses to send on an expired quote", async () => {
    const q = await quote(
      { env: "mainnet", originChainId: 4217, destinationChainId: 8453, inputToken: "a", outputToken: "b", amount: 1n, depositor: "d", recipient: "r" },
      fakeFetch({ "/swap/approval": { ...QUOTE, quoteExpiryTimestamp: 1 } }),
    );
    const sender = { sendTransaction: async () => "0x1", waitForTransactionReceipt: async () => ({}) } as unknown as EvmSender;
    await expect(executeEvm(sender, q)).rejects.toThrow(/expired/);
  });

  it("treats a zero expiry (CCTP-backed routes) as no expiry", async () => {
    const q = await quote(
      { env: "testnet", originChainId: 84532, destinationChainId: 133268194659241, inputToken: "a", outputToken: "b", amount: 1n, depositor: "d", recipient: "r" },
      fakeFetch({ "/swap/approval": { ...QUOTE, quoteExpiryTimestamp: 0, approvalTxns: [] } }),
    );
    const sender: EvmSender = { sendTransaction: async () => `0x${"1".padStart(64, "0")}`, waitForTransactionReceipt: async ({ hash }) => ({ status: "success", transactionHash: hash }) };
    await expect(executeEvm(sender, q)).resolves.toMatchObject({ approvals: [] });
  });

  it("tolerates indexer lag, then reports the fill", async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      const body = n < 3 ? { error: "DepositNotFoundException", message: "not found" } : { status: "filled", fillTx: "0xfill", depositId: 42 };
      return { ok: n >= 3, json: async () => body } as Response;
    }) as unknown as typeof fetch;
    expect((await depositStatus("testnet", 84532, "0xdep", fetchImpl)).status).toBe("not_found");
    const s = await waitForFill("testnet", 84532, "0xdep", { fetchImpl, pollMs: 1 });
    expect(s).toMatchObject({ status: "filled", fillTx: "0xfill", depositId: "42" });
  });
});
