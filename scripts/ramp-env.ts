import { mkdirSync } from "node:fs";
import type { Asset } from "@corridor/core";
import { fundFromFriendbot, type StellarClient } from "@corridor/chain-stellar";
import { openLocalDb } from "@corridor/ledger";
import { MockPartner, PartnerRegistry, SepAnchor, type RampPartner } from "@corridor/partners";
import { RampService, stellarRampChain } from "@corridor/ramp";
import { NETWORK, vault } from "./runtime.ts";

/**
 * Wiring shared by `ramp:serve` and `ramp:demo`: the sponsor key, the anchor
 * (a real SEP server when CORRIDOR_ANCHOR_BASE_URL is set, otherwise the
 * mock), and the Ramp service on a local database.
 */
export const RAMP_ASSET = (process.env.RAMP_ASSET ?? (NETWORK === "testnet" ? "XLM" : "USDC")) as Asset;

export async function ensureFunded(client: StellarClient, address: string) {
  if (NETWORK !== "testnet") return;
  try {
    await client.server.loadAccount(address);
  } catch {
    await fundFromFriendbot(client, address);
  }
}

export async function openRamp(opts: { publicUrl: string; dataDir?: string; partnerWebhookBase?: string }) {
  const sponsor = await vault("RAMP_SPONSOR");
  await ensureFunded(sponsor, sponsor.address);

  let mock: MockPartner | undefined;
  let anchor: RampPartner;
  const baseUrl = process.env.CORRIDOR_ANCHOR_BASE_URL;
  if (baseUrl) {
    anchor = new SepAnchor({
      domain: new URL(baseUrl).host,
      baseUrl,
      network: NETWORK,
      asset: { code: RAMP_ASSET === "XLM" ? "native" : RAMP_ASSET },
      payoutCurrencies: [(process.env.CORRIDOR_PAYOUT_CURRENCY ?? "KES") as "KES"],
      senderId: process.env.CORRIDOR_SEP12_SENDER_ID,
      receiverId: process.env.CORRIDOR_SEP12_RECEIVER_ID,
      signer: { address: sponsor.address, sign: (hash) => sponsor.signer!.sign(hash) },
    });
  } else {
    const escrow = await vault("ESCROW");
    await ensureFunded(escrow, escrow.address);
    mock = new MockPartner({ webhookSecret: "whsec_dev", chains: ["STELLAR"], stellarAccount: escrow.address });
    anchor = mock;
  }

  if (opts.dataDir) mkdirSync(opts.dataDir, { recursive: true });
  const db = await openLocalDb(opts.dataDir);
  const ramp = await RampService.open({
    db,
    partners: new PartnerRegistry().register(anchor),
    chain: stellarRampChain({ sponsor }),
    asset: RAMP_ASSET,
    publicUrl: opts.publicUrl,
    partnerWebhookUrl: opts.partnerWebhookBase ? (id) => `${opts.partnerWebhookBase}/v1/partners/${id}/webhook` : undefined,
  });
  return { ramp, sponsor, anchor, mock, db };
}
