import { describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { RefKind, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { MEMO_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, USDC_MINT, buildTransferWithMemo, extractReference } from "./index.ts";

const ref = encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id: uuidv7(), customerTag: customerTag("zynta", "s") });

describe("Solana transfer with Corridor memo", () => {
  it("creates the recipient token account if needed, transfers USDC, and attaches the reference", async () => {
    const from = await generateKeyPairSigner();
    const ix = await buildTransferWithMemo({
      from,
      toOwner: address("4KSLE7EU1P7PQ8Rc4hdb2ZKq2JmWHD8UXJp7guEdyT9j"),
      mint: USDC_MINT.mainnet,
      amount: 7_000_000n,
      decimals: 6,
      reference: ref,
    });
    expect(ix.map((i) => i.programAddress)).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // associated token program: create-idempotent
      TOKEN_PROGRAM_ADDRESS,
      MEMO_PROGRAM_ADDRESS,
    ]);
    const memo = new TextDecoder().decode(ix[2]!.data as Uint8Array);
    expect(memo).toBe(`corridor:${ref.slice(2)}`);
  });

  it("recovers the reference from the RPC memo field and ignores other memos", () => {
    expect(extractReference(`[81] corridor:${ref.slice(2)}`)).toBe(ref);
    expect(extractReference("[5] hello")).toBeNull();
    expect(extractReference(`[81] corridor:${"00".repeat(32)}`)).toBeNull();
  });
});
