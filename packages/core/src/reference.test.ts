import { describe, expect, it } from "vitest";
import {
  RefKind,
  customerTag,
  decodeRef,
  encodeRef,
  fromSolanaMemo,
  fromZcashMemo,
  toSolanaMemo,
  toZcashMemo,
  tryDecodeRef,
  uuidv7,
  type CorridorRef,
} from "./reference.ts";
import { formatMoney, parseMoney } from "./model.ts";

const ref = (over: Partial<CorridorRef> = {}): CorridorRef => ({
  kind: RefKind.Payout,
  corridor: "EUR-NGN",
  shielded: false,
  id: uuidv7(),
  customerTag: customerTag("zynta", "test-secret"),
  ...over,
});

describe("Corridor Reference", () => {
  it("round-trips through the 32-byte encoding", () => {
    const r = ref({ kind: RefKind.BatchItem, corridor: "USD-USD", shielded: true });
    const hex = encodeRef(r);
    expect(hex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decodeRef(hex)).toEqual(r);
  });

  it("addresses any currency pair, including import corridors out of Africa", () => {
    for (const corridor of ["NGN-CNY", "KES-USD", "GHS-HKD", "ZAR-BRL", "EUR-NGN"] as const) {
      const r = ref({ corridor, kind: RefKind.Collection });
      expect(decodeRef(encodeRef(r)).corridor).toBe(corridor);
    }
    expect(() => encodeRef(ref({ corridor: "NGN-XYZ" as never }))).toThrow(/invalid corridor/);
  });

  it("rejects a corrupted reference", () => {
    const hex = encodeRef(ref());
    const flipped = hex.slice(0, 10) + (hex[10] === "0" ? "1" : "0") + hex.slice(11);
    expect(() => decodeRef(flipped)).toThrow(/checksum/);
    expect(tryDecodeRef(flipped)).toBeNull();
  });

  it("ignores memos that are not Corridor references", () => {
    expect(tryDecodeRef("0x" + "00".repeat(32))).toBeNull();
    expect(tryDecodeRef("0x1234")).toBeNull();
  });

  it("keys the customer tag so tags differ per secret", () => {
    expect(customerTag("acme", "a")).not.toEqual(customerTag("acme", "b"));
    expect(customerTag("acme", "a")).toEqual(customerTag("acme", "a"));
  });

  it("generates time-ordered UUIDv7 ids", () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(a[14]).toBe("7");
  });

  it("carries the same reference on Solana and Zcash", () => {
    const hex = encodeRef(ref({ shielded: true, corridor: "USD-USD" }));
    expect(fromSolanaMemo(toSolanaMemo(hex))).toBe(hex);

    const memo = toZcashMemo(hex, "INV-2026-0042");
    expect(memo.length).toBe(512);
    expect(memo[0]).toBeLessThanOrEqual(0xf4); // ZIP-302 text memo, readable in the recipient's wallet
    expect(new TextDecoder().decode(memo.subarray(0, memo.indexOf(0)))).toBe(`INV-2026-0042\ncorridor:${hex.slice(2)}`);
    expect(fromZcashMemo(memo)).toEqual({ ref: hex, invoiceRef: "INV-2026-0042" });
  });

  it("ignores Zcash memos that are not Corridor references", () => {
    const text = new Uint8Array(512);
    text.set(new TextEncoder().encode("hello"));
    expect(fromZcashMemo(text)).toBeNull();
    const binary = new Uint8Array(512).fill(0xff);
    expect(fromZcashMemo(binary)).toBeNull();
  });
});

describe("money", () => {
  it("parses and formats minor units exactly", () => {
    const m = parseMoney("pathUSD", "12.5");
    expect(m.amount).toBe(12_500_000n);
    expect(formatMoney(m)).toBe("12.5 pathUSD");
    expect(formatMoney(parseMoney("ZEC", "0.00000001"))).toBe("0.00000001 ZEC");
  });

  it("refuses more precision than the asset has", () => {
    expect(() => parseMoney("NGN", "1.001")).toThrow(/decimals/);
  });
});
