import { describe, expect, it } from "vitest";
import {
  RefKind,
  customerTag,
  decodeRef,
  encodeRef,
  fromSolanaMemo,
  fromStellarMemo,
  toSolanaMemo,
  toStellarMemo,
  tryDecodeRef,
  uuidv7,
  type CorridorRef,
} from "./reference.ts";
import { formatMoney, parseMoney, rescale } from "./model.ts";

const ref = (over: Partial<CorridorRef> = {}): CorridorRef => ({
  kind: RefKind.Payout,
  corridor: "EUR-NGN",
  shielded: false,
  id: uuidv7(),
  customerTag: customerTag("eu-payco", "test-secret"),
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

  it("carries the same reference on Stellar and Solana", () => {
    const hex = encodeRef(ref({ corridor: "USD-USD" }));
    expect(fromSolanaMemo(toSolanaMemo(hex))).toBe(hex);

    const memo = toStellarMemo(hex);
    expect(memo.length).toBe(32); // MEMO_HASH is exactly a Corridor Reference
    expect(fromStellarMemo(Buffer.from(memo).toString("base64"))).toBe(hex);
  });

  it("ignores Stellar memos that are not Corridor references", () => {
    expect(fromStellarMemo(Buffer.alloc(32).toString("base64"))).toBeNull(); // 32 bytes, bad version
    expect(fromStellarMemo(Buffer.from("INV-2026-0042").toString("base64"))).toBeNull(); // wrong length
    const hex = encodeRef(ref());
    expect(fromStellarMemo(Buffer.from(toStellarMemo(hex)).toString("base64"), "text")).toBeNull();
  });
});

describe("money", () => {
  it("parses and formats minor units exactly", () => {
    const m = parseMoney("USDC", "12.5");
    expect(m.amount).toBe(125_000_000n); // 7 dp, the hub's own precision
    expect(formatMoney(m)).toBe("12.5 USDC");
    expect(formatMoney(parseMoney("XLM", "0.0000001"))).toBe("0.0000001 XLM");
  });

  it("refuses more precision than the asset has", () => {
    expect(() => parseMoney("NGN", "1.001")).toThrow(/decimals/);
  });
});

describe("rescale", () => {
  it("scales a 6 dp spoke amount into the hub's 7 dp exactly", () => {
    expect(rescale(2_900_000n, 6, 7)).toBe(29_000_000n);
    expect(rescale(29_000_000n, 7, 6)).toBe(2_900_000n);
  });

  it("refuses to drop a stroop on the way out to a 6 dp spoke", () => {
    expect(() => rescale(29_000_001n, 7, 6)).toThrow(/without losing value/);
  });
});
