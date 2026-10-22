import { describe, expect, it } from "vitest";
import { decimal, divRate, mulRate, parseMoney, ratio } from "./model.ts";

describe("decimal rates", () => {
  it("normalizes strings and accepts a vendor JSON number once", () => {
    expect(decimal("001530.2500")).toBe("1530.25");
    expect(decimal(128.9)).toBe("128.9");
    expect(decimal("0")).toBe("0");
  });

  it("refuses exponents, negatives and junk", () => {
    expect(() => decimal(1e-7)).toThrow();
    expect(() => decimal("-1")).toThrow();
    expect(() => decimal(Number.NaN)).toThrow();
    expect(() => decimal("1,530")).toThrow();
  });

  it("converts minor units with integer maths, rounding down", () => {
    expect(mulRate(70_000_000n, "USDC", "1530", "NGN")).toBe(1_071_000n);
    expect(mulRate(1n, "USDC", "0.1", "KES")).toBe(0n);
    // 0.1 + 0.2 style drift cannot occur: 3 × 0.1 KES per USDC is exact.
    expect(mulRate(30_000_000n, "USDC", "0.1", "KES")).toBe(30n);
    expect(divRate(1_560_000n, "NGN", "1560", "USDC")).toBe(100_000_000n);
    expect(() => divRate(1n, "NGN", "0", "USDC")).toThrow();
  });

  it("divides decimals without floats", () => {
    expect(ratio("905.5", "7")).toBe("129.3571428");
    expect(ratio("1", "0")).toBe("0");
  });

  it("truncates over-precise partner amounts only when asked", () => {
    expect(() => parseMoney("KES", "905.509")).toThrow();
    expect(parseMoney("KES", "905.509", { truncate: true }).amount).toBe(90_550n);
  });
});
