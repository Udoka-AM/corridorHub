import { describe, expect, it } from "vitest";
import { STABLECOINS } from "@corridor/core";
import { BASE_STABLES, Erc20Watcher } from "./index.ts";

const ME = "0x7b54A95E0708b32C6a1299C3930b9aBc06EBe43a" as const;
const OTHER = "0x1111111111111111111111111111111111111111" as const;

describe("Base stablecoin watcher", () => {
  it("only registers stablecoins core knows", () => {
    for (const a of Object.keys(BASE_STABLES.base)) expect(STABLECOINS).toContain(a);
  });

  it("emits inbound and outbound transfers per token, deduplicated, and advances the cursor", async () => {
    const cursor = new Map<string, bigint>();
    const log = (token: string, from: string, to: string, value: bigint, logIndex: number) => ({
      address: token, transactionHash: `0x${String(logIndex).padStart(64, "0")}`, logIndex, blockNumber: 101n, args: { from, to, value },
    });
    const calls: { address: string; args: Record<string, unknown> }[] = [];
    const client = {
      getBlockNumber: async () => 105n,
      getLogs: async (q: { address: string; args: Record<string, unknown> }) => {
        calls.push(q);
        if (q.address === BASE_STABLES.base.USDC && q.args.to) return [log(q.address, OTHER, ME, 5_000_000n, 1)];
        if (q.address === BASE_STABLES.base.EURC && q.args.from) return [log(q.address, ME, OTHER, 2_000_000n, 2)];
        return [];
      },
    };
    const watcher = new Erc20Watcher(client as never, {
      name: "base:treasury", venue: "base", tokens: BASE_STABLES.base, addresses: [ME],
      cursors: { get: async (n) => cursor.get(n), set: async (n, b) => void cursor.set(n, b) }, startBlock: 100n,
    });
    const obs = await watcher.poll();
    expect(obs.map((o) => [o.asset, o.amount, o.from, o.to])).toEqual([
      ["USDC", 5_000_000n, OTHER, ME],
      ["EURC", 2_000_000n, ME, OTHER],
    ]);
    expect(cursor.get("base:treasury")).toBe(105n);
    expect(calls).toHaveLength(4);
    expect(await watcher.poll()).toEqual([]);
  });

  it("shrinks its range when the RPC reports a lower eth_getLogs cap", async () => {
    const ranges: bigint[] = [];
    const client = {
      getBlockNumber: async () => 1_499n,
      getLogs: async (q: { fromBlock: bigint; toBlock: bigint }) => {
        const span = q.toBlock - q.fromBlock + 1n;
        if (span > 200n) throw new Error("RPC Request failed. Details: eth_getLogs is limited to a 200 range");
        ranges.push(span);
        return [];
      },
    };
    const cursor = new Map<string, bigint>();
    await new Erc20Watcher(client as never, {
      name: "b", venue: "base", tokens: { USDC: BASE_STABLES.base.USDC! }, addresses: [ME],
      cursors: { get: async (n) => cursor.get(n), set: async (n, b) => void cursor.set(n, b) }, startBlock: 1_000n,
    }).poll();
    expect(Math.max(...ranges.map(Number))).toBe(200);
    expect(cursor.get("b")).toBe(1_499n);
  });
});
