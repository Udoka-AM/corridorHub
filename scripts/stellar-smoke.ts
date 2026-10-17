/**
 * End-to-end proof that the Corridor Reference survives a real Stellar
 * transaction: pay the escrow vault, then read the payment back off the
 * network and decode the reference out of its MEMO_HASH.
 *
 * It moves XLM so it needs nothing but a funded account; the USDC path is the
 * same call with a different asset once a trustline is funded.
 *
 *   pnpm stellar:smoke
 */
import { RefKind, customerTag, decodeRef, encodeRef, formatMoney, uuidv7 } from "@corridor/core";
import { explorerTx, findTransfersByReference, transferWithReference } from "@corridor/chain-stellar";
import { NETWORK, report, vault } from "./runtime.ts";

const treasury = await vault("TREASURY");
const escrow = await vault("ESCROW");
const asset = "XLM";
const amount = 1_000_000n; // 0.1 XLM

const reference = encodeRef({
  kind: RefKind.Payout,
  corridor: "EUR-KES",
  shielded: false,
  id: uuidv7(),
  customerTag: customerTag("smoke-test", process.env.CORRIDOR_TAG_SECRET ?? "dev"),
});
console.log(`reference ${reference}`);
console.log(`           ${JSON.stringify(decodeRef(reference))}\n`);

await report(treasury, "treasury", treasury.address, [asset]);
await report(escrow, "escrow", escrow.address, [asset]);

const sent = await transferWithReference(treasury, { asset, to: escrow.address, amount, reference });
console.log(`\nsent ${formatMoney({ asset, amount })} -> ${explorerTx(NETWORK, sent.txHash)}`);

// The join: ask the network for this account's movements and find ours by memo.
const found = await findTransfersByReference(treasury, { account: treasury.address, reference });
const match = found.find((o) => o.externalRef.startsWith(sent.txHash));
if (!match) throw new Error("the payment is on the network but its reference did not come back");
console.log(`read back ${formatMoney({ asset: match.asset, amount: match.amount })} with reference ${match.reference}`);
console.log(`decoded   ${JSON.stringify(decodeRef(match.reference!))}`);
console.log(`\nledger ${match.blockNumber} · ${match.observedAt.toISOString()}`);
