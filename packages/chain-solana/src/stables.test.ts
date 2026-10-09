import { describe, expect, it } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { RefKind, STABLECOINS, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { SOLANA_STABLES, TOKEN_2022_PROGRAM_ADDRESS, buildTransferWithMemo, solanaStable, stableByMint, tokenDeltas } from "./index.ts";

const ME = "GNaeRSd8Q2LRsTVubmdBF3NzHX8KTSeLUV2rMxN2oMHL";
const PARTNER = "9NqowirX9S8pXSPGY4D5K73huhWH4qVRTF97HiH14LD5";
const bal = (accountIndex: number, mint: string, owner: string, amount: bigint) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: amount.toString() } });

describe("Solana stablecoins", () => {
  const usdt = SOLANA_STABLES.mainnet.USDT!.mint;
  const usdc = SOLANA_STABLES.mainnet.USDC!.mint;

  it("registers USDC, USDT, PYUSD and EURC on mainnet, all known to core", () => {
    expect(Object.keys(SOLANA_STABLES.mainnet).sort()).toEqual(["EURC", "PYUSD", "USDC", "USDT"]);
    for (const a of Object.keys(SOLANA_STABLES.mainnet)) expect(STABLECOINS).toContain(a);
    expect(stableByMint("mainnet", usdt)).toBe("USDT");
    expect(solanaStable("mainnet", "PYUSD").tokenProgram).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(() => solanaStable("devnet", "USDT")).toThrow(/not configured/);
  });

  it("reads an inbound USDT payment and its sender from balance changes", () => {
    const meta = {
      preTokenBalances: [bal(1, usdt, PARTNER, 900_000_000n), bal(2, usdt, ME, 0n)],
      postTokenBalances: [bal(1, usdt, PARTNER, 650_000_000n), bal(2, usdt, ME, 250_000_000n)],
    };
    expect(tokenDeltas(meta, ME, "mainnet")).toEqual([{ asset: "USDT", delta: 250_000_000n, counterparty: PARTNER }]);
  });

  it("reports each stablecoin separately and ignores unknown mints", () => {
    const meta = {
      preTokenBalances: [bal(1, usdc, ME, 100n), bal(2, usdt, ME, 0n), bal(3, "So11111111111111111111111111111111111111112", ME, 5n)],
      postTokenBalances: [bal(1, usdc, ME, 40n), bal(2, usdt, ME, 59n), bal(3, "So11111111111111111111111111111111111111112", ME, 0n)],
    };
    expect(tokenDeltas(meta, ME, "mainnet")).toEqual([
      { asset: "USDC", delta: -60n, counterparty: undefined },
      { asset: "USDT", delta: 59n, counterparty: undefined },
    ]);
  });

  it("counts a newly created token account as starting from zero", () => {
    const meta = { preTokenBalances: [bal(1, usdt, PARTNER, 10n)], postTokenBalances: [bal(1, usdt, PARTNER, 0n), bal(4, usdt, ME, 10n)] };
    expect(tokenDeltas(meta, ME, "mainnet")).toEqual([{ asset: "USDT", delta: 10n, counterparty: PARTNER }]);
  });

  it("builds Token-2022 transfers against the mint's own program", async () => {
    const from = await generateKeyPairSigner();
    const pyusd = solanaStable("mainnet", "PYUSD");
    const ix = await buildTransferWithMemo({
      from,
      toOwner: address(PARTNER),
      mint: pyusd.mint,
      amount: 1_000_000n,
      decimals: pyusd.decimals,
      reference: encodeRef({ kind: RefKind.Payout, corridor: "EUR-NGN", shielded: false, id: uuidv7(), customerTag: customerTag("eu-payco", "s") }),
      tokenProgram: pyusd.tokenProgram,
    });
    expect(ix[1]!.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
    expect(ix[0]!.accounts!.some((a) => a.address === TOKEN_2022_PROGRAM_ADDRESS)).toBe(true);
  });
});

import { SOLANA_FEES, nativeMovements } from "./index.ts";

describe("Solana native fee and SOL movements", () => {
  const VAULT = "GNaeRSd8Q2LRsTVubmdBF3NzHX8KTSeLUV2rMxN2oMHL";
  const PAJ = "9NqowirX9S8pXSPGY4D5K73huhWH4qVRTF97HiH14LD5";

  it("separates the fee the vault paid from its other SOL changes", () => {
    // The vault pays a 5,000-lamport fee and 2,039,280 lamports of rent for the partner's token account.
    const tx = {
      message: { accountKeys: [{ pubkey: VAULT }, { pubkey: "AtaNew111" }, { pubkey: PAJ }] },
      meta: { fee: 5_000n, preBalances: [100_000_000n, 0n, 7n], postBalances: [100_000_000n - 5_000n - 2_039_280n, 2_039_280n, 7n] },
    };
    expect(nativeMovements(tx, VAULT)).toEqual({ fee: 5_000n, delta: -2_039_280n, counterparty: "AtaNew111", createdAccount: true });
  });

  it("reports an inbound top-up with its sender and no fee when someone else paid it", () => {
    const tx = {
      message: { accountKeys: ["Funder1111", VAULT] },
      meta: { fee: 5_000, preBalances: [2_000_000_000, 0], postBalances: [2_000_000_000 - 1_000_000_000 - 5_000, 1_000_000_000] },
    };
    expect(nativeMovements(tx, VAULT)).toEqual({ fee: 0n, delta: 1_000_000_000n, counterparty: "Funder1111" });
  });

  it("ignores transactions the address isn't in", () => {
    expect(nativeMovements({ message: { accountKeys: [PAJ] }, meta: { fee: 1n, preBalances: [5n], postBalances: [4n] } }, VAULT)).toEqual({ fee: 0n, delta: 0n });
    expect(SOLANA_FEES).toBe("solana:network-fees");
  });
});
