/**
 * Reusable flows on top of the runtime: pre-fund a customer on the Tempo hub,
 * run a payout to any spoke, and run an importer collection. Used by the
 * treasury console's actions.
 */
import { RefKind, customerTag, encodeRef, money, parseMoney, uuidv7, type CorridorCode, type Fiat } from "@corridor/core";
import { transferWithReference, type TempoClient } from "@corridor/chain-tempo";
import type { Accounts, Ledger } from "@corridor/ledger";
import type { CollectionData, ShieldedItem } from "@corridor/legs";
import { planRoute } from "@corridor/routing";
import type { PayoutData, SagaEngine, SagaStatus } from "@corridor/saga";
import { testnetKey } from "./env.ts";
/** The parts of the demo runtime these flows use. */
interface Runtime {
  customer: TempoClient;
  treasury: TempoClient;
  ledger: Ledger;
  accounts: Accounts;
  engine: SagaEngine;
  startBlock: bigint;
}

const tag = (customerId: string) => customerTag(customerId, testnetKey("CORRIDOR_REF_SECRET"));

/** The PSP tops up its hub balance: a real memo-tagged pathUSD transfer on Tempo, booked from the chain. */
export async function prefund(rt: Runtime, customerId: string, corridor: CorridorCode, amount: string) {
  const reference = encodeRef({ kind: RefKind.Deposit, corridor, shielded: false, id: uuidv7(), customerTag: tag(customerId) });
  const obs = await transferWithReference(rt.customer, {
    asset: "pathUSD",
    to: rt.treasury.account.address,
    amount: parseMoney("pathUSD", amount).amount,
    reference,
  });
  await rt.ledger.post({
    kind: "tempo.deposit",
    reference,
    external: { venue: "tempo", ref: obs.externalRef },
    metadata: { customerId },
    lines: [
      { account: await rt.accounts.vault("treasury", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", obs.amount) },
      { account: await rt.accounts.customer(customerId, corridor, "pathUSD", "tempo"), direction: "C", money: money("pathUSD", obs.amount) },
    ],
  });
  return { txHash: obs.txHash, reference };
}

export interface PayoutInput {
  customerId: string;
  corridor: CorridorCode;
  currency: Fiat;
  amount: string;
  recipient: { bankCode: string; accountNumber: string; name: string };
  failAtPartner?: boolean;
}

export async function payout(rt: Runtime, input: PayoutInput): Promise<{ sagaId: string; status: SagaStatus }> {
  const plan = planRoute({
    corridor: input.corridor,
    privacy: "public",
    source: { venue: "tempo", asset: "pathUSD" },
    destination: { venue: "partner_fiat", asset: input.currency },
    env: "testnet",
  });
  const payoutId = uuidv7();
  const data: PayoutData = {
    payoutId,
    customerId: input.customerId,
    corridor: input.corridor,
    asset: "pathUSD",
    venue: "tempo",
    amount: parseMoney("pathUSD", input.amount).amount.toString(),
    reference: encodeRef({ kind: RefKind.Payout, corridor: input.corridor, shielded: false, id: payoutId, customerTag: tag(input.customerId) }),
    recipient: { kind: "bank", ...input.recipient },
    tempoStartBlock: rt.startBlock.toString(),
  };
  const sagaId = await rt.engine.start({
    kind: "payout",
    reference: data.reference,
    plan,
    data,
    faults: input.failAtPartner ? { failAt: "partner.payout" } : undefined,
  });
  return { sagaId, status: await rt.engine.run(sagaId) };
}

export async function collect(
  rt: Runtime,
  input: { customerId: string; corridor: CorridorCode; currency: Fiat; fiatAmount: string },
): Promise<{ sagaId: string; status: SagaStatus }> {
  const plan = planRoute({
    corridor: input.corridor,
    purpose: "collection",
    privacy: "public",
    source: { venue: "partner_fiat", asset: input.currency },
    destination: { venue: "tempo", asset: "pathUSD" },
    env: "testnet",
  });
  const data: CollectionData = {
    collectionId: uuidv7(),
    customerId: input.customerId,
    corridor: input.corridor,
    currency: input.currency,
    fiatAmount: parseMoney(input.currency, input.fiatAmount).amount.toString(),
    reference: encodeRef({ kind: RefKind.Collection, corridor: input.corridor, shielded: false, id: uuidv7(), customerTag: tag(input.customerId) }),
    tempoStartBlock: rt.startBlock.toString(),
  };
  const sagaId = await rt.engine.start({ kind: "collection", reference: data.reference, plan, data });
  return { sagaId, status: await rt.engine.run(sagaId) };
}

/**
 * A private supplier batch through the shielded lane: reserve on the hub →
 * near.swap into the customer's FROST vault → one Ironwood transaction paying
 * every supplier, signed only once `threshold` vault signers approve.
 */
export async function shieldedBatch(
  rt: Runtime,
  input: { customerId: string; corridor: CorridorCode; items: { name: string; address: string; usd: string; invoiceRef: string }[] },
): Promise<{ sagaId: string; status: SagaStatus; batchReference: string }> {
  const plan = planRoute({
    corridor: input.corridor,
    privacy: "shielded",
    source: { venue: "tempo", asset: "pathUSD" },
    destination: { venue: "zcash_ironwood", asset: "ZEC" },
    env: "testnet",
  });
  const batchId = uuidv7();
  const t = tag(input.customerId);
  const batchReference = encodeRef({ kind: RefKind.Batch, corridor: input.corridor, shielded: true, id: batchId, customerTag: t });
  const items: ShieldedItem[] = input.items.map((it) => {
    const itemId = uuidv7();
    return { ...it, itemId, reference: encodeRef({ kind: RefKind.BatchItem, corridor: input.corridor, shielded: true, id: itemId, customerTag: t }) };
  });
  const totalUsd = input.items.reduce((s, it) => s + Number(it.usd), 0);
  const data: PayoutData = {
    payoutId: batchId,
    customerId: input.customerId,
    corridor: input.corridor,
    asset: "pathUSD",
    venue: "tempo",
    amount: parseMoney("pathUSD", totalUsd.toFixed(2)).amount.toString(),
    reference: batchReference,
    batchReference,
    recipient: { kind: "shielded", items },
    tempoStartBlock: rt.startBlock.toString(),
  };
  const sagaId = await rt.engine.start({ kind: "shielded-batch", reference: batchReference, plan, data });
  return { sagaId, status: await rt.engine.run(sagaId), batchReference };
}
