import { describe, expect, it } from "vitest";
import { RefKind, customerTag, encodeRef, fromZcashMemo, toZcashMemo, uuidv7 } from "@corridor/core";
import { buildPaymentRequest, formatZec, parsePaymentRequest, parseZec } from "./zip321.ts";

const ref = () =>
  encodeRef({ kind: RefKind.BatchItem, corridor: "NGN-CNY", shielded: true, id: uuidv7(), customerTag: customerTag("acme", "s") });

describe("ZIP-321 payment requests", () => {
  it("formats ZEC amounts exactly", () => {
    expect(formatZec(1n)).toBe("0.00000001");
    expect(formatZec(150_000_000n)).toBe("1.5");
    expect(formatZec(200_000_000n)).toBe("2");
    expect(parseZec("0.00012")).toBe(12_000n);
  });

  it("encodes a batch of shielded payouts, one memo per recipient, in one request", () => {
    const payments = [
      { address: "utest1supplierone", zatoshi: 1_200_000n, memo: toZcashMemo(ref(), "INV-001") },
      { address: "utest1suppliertwo", zatoshi: 800_000n, memo: toZcashMemo(ref(), "INV-002") },
      { address: "utest1contractor", zatoshi: 50_000n },
    ];
    const uri = buildPaymentRequest(payments);
    expect(uri).toMatch(/^zcash:\?address=utest1supplierone&amount=0\.012&memo=/);
    expect(uri).toContain("&address.1=utest1suppliertwo&amount.1=0.008&memo.1=");
    expect(uri).toContain("&address.2=utest1contractor&amount.2=0.0005");
    for (const [, memo] of uri.matchAll(/memo(?:\.\d+)?=([^&]*)/g)) {
      expect(memo).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, unpadded
    }

    const back = parsePaymentRequest(uri);
    expect(back).toHaveLength(3);
    expect(fromZcashMemo(back[1]!.memo!)?.invoiceRef).toBe("INV-002");
    expect(back[2]!.memo).toBeUndefined();
  });

  it("rejects empty or non-positive batches", () => {
    expect(() => buildPaymentRequest([])).toThrow();
    expect(() => buildPaymentRequest([{ address: "utest1x", zatoshi: 0n }])).toThrow(/positive/);
  });
});
