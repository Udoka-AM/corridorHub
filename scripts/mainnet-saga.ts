/**
 * A mainnet payout through the saga engine and the ledger: the same planner,
 * engine and legs as the testnet console, wired to real chains and Paj.
 *
 *   ledger.reserve → across.bridge (Tempo → Base) → across.bridge (Base → Solana) → partner.payout (Paj, NGN)
 *
 * Its own ledger (.data/ledger-mainnet). On first run it books each vault's
 * on-chain balance as the owner's opening float; pathUSD that arrives at the
 * Tempo treasury after that is booked as the customer's deposit. After the
 * saga, every vault is checked on-chain against the ledger.
 *
 *   pnpm mainnet:saga                 # book opening float and deposits, show balances and the plan
 *   pnpm mainnet:saga --go [amount]   # run a payout (default: the customer's whole available balance)
 *   pnpm mainnet:saga --resume <id>   # resume a saga after a crash
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, decodeEventLog, http, parseAbi, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { TOKENS } from "@corridor/bridge-across";
import { FEE_MANAGER, balanceOf, tempoClient } from "@corridor/chain-tempo";
import { SolanaVault } from "@corridor/chain-solana";
import { RefKind, customerTag, encodeRef, formatMoney, money, uuidv7, type Asset, type Venue } from "@corridor/core";
import { Accounts, Ledger, openLocalDb } from "@corridor/ledger";
import { ArtifactStore, acrossBridgeLeg, partnerPayoutLeg, type GasCost } from "@corridor/legs";
import { PajPartner, PartnerRegistry } from "@corridor/partners";
import { planRoute } from "@corridor/routing";
import { SagaEngine, ledgerReserveLeg, type PayoutData } from "@corridor/saga";
import { PartnerEventStore } from "@corridor/webhooks";
import { testnetKey } from "./env.ts";
import { evmAccountFor, solanaSignerForKeypair, tempoAccountFor } from "./signers.ts";

const CUSTOMER = "founder-pilot";
const CORRIDOR = "EUR-NGN" as const;
const SOLANA_RPC = process.env.SOLANA_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const RECORD_FILE = "examples/mainnet/payouts.json";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}

// ---- chains and signers ----
const tempo = tempoClient({ network: "mainnet", account: await tempoAccountFor("TEMPO_MAINNET_VAULT_KEY") });
const treasury = tempo.account.address;
const relayAccount = await evmAccountFor("BASE_MAINNET_RELAY_KEY");
const relay = relayAccount.address;
const baseRead = createPublicClient({ chain: base, transport: http(undefined, { retryCount: 5 }) });
const baseWallet = createWalletClient({ account: relayAccount, chain: base, transport: http() });
const solana = new SolanaVault(await solanaSignerForKeypair(need("SOLANA_MAINNET_VAULT_KEYPAIR")), "mainnet");

const erc20 = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);

async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(SOLANA_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    if (res.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 1_000 * attempt));
      continue;
    }
    const body = (await res.json()) as { result: T; error?: { message: string } };
    if (body.error) throw new Error(`solana ${method}: ${body.error.message}`);
    if (body.result === null && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2_000)); // not yet visible at this commitment
      continue;
    }
    return body.result;
  }
}

type ParsedTx = {
  meta: {
    fee: number;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances: { owner: string; mint: string; uiTokenAmount: { amount: string } }[];
  };
  transaction: { message: { accountKeys: { pubkey: string }[] } };
};
const solanaTx = (sig: string) => solanaRpc<ParsedTx>("getTransaction", [sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
const tokenOf = (rows: ParsedTx["meta"]["postTokenBalances"], owner: string) =>
  rows.filter((b) => b.owner === owner && b.mint === TOKENS.solanaUSDC).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);

/** What the chains say each vault holds. */
async function onChain() {
  const sol = await solanaRpc<{ value: number }>("getBalance", [solana.address]);
  return {
    "treasury pathUSD (Tempo)": await balanceOf(tempo, "pathUSD", treasury),
    "base-relay USDC (Base)": await baseRead.readContract({ address: TOKENS.baseUSDC, abi: erc20, functionName: "balanceOf", args: [relay] }),
    "base-relay ETH (Base)": await baseRead.getBalance({ address: relay }),
    "solana-egress USDC (Solana)": await solana.tokenBalance(),
    "solana-egress SOL (Solana)": BigInt(sol.value),
  };
}
const VAULTS: Record<string, [string, Asset, Venue]> = {
  "treasury pathUSD (Tempo)": ["treasury", "pathUSD", "tempo"],
  "base-relay USDC (Base)": ["base-relay", "USDC", "base"],
  "base-relay ETH (Base)": ["base-relay", "ETH", "base"],
  "solana-egress USDC (Solana)": ["solana-egress", "USDC", "solana"],
  "solana-egress SOL (Solana)": ["solana-egress", "SOL", "solana"],
};

// ---- ledger and engine ----
const db = await openLocalDb(".data/ledger-mainnet");
const ledger = await Ledger.open(db);
const accounts = new Accounts(ledger);
const artifacts = await ArtifactStore.open(db);
const events = await PartnerEventStore.open(db);
const registry = new PartnerRegistry().register(new PajPartner({ apiKey: need("PAJ_API_KEY") }));
const log = (m: string) => console.log(`  ${m}`);

// Opening float: whatever the vaults hold the first time this ledger sees them.
let opening = await artifacts.get<{ tempoBlock: string }>("mainnet:opening");
if (!opening) {
  const tempoBlock = await tempo.getBlockNumber();
  const balances = await onChain();
  balances["treasury pathUSD (Tempo)"] = (await tempo.readContract({
    address: TOKENS.tempoPathUSD as Address,
    abi: erc20,
    functionName: "balanceOf",
    args: [treasury],
    blockNumber: tempoBlock,
  })) as bigint;
  for (const [label, amount] of Object.entries(balances)) {
    if (amount === 0n) continue;
    const [name, asset, venue] = VAULTS[label]!;
    await ledger.post({
      kind: "opening.float",
      external: { venue, ref: `opening:${name}:${asset}` },
      lines: [
        { account: await accounts.vault(name, asset, venue), direction: "D", money: money(asset, amount) },
        { account: await accounts.equity("owner-float", asset, venue), direction: "C", money: money(asset, amount) },
      ],
    });
  }
  await artifacts.merge("mainnet:opening", { tempoBlock: tempoBlock.toString() });
  opening = { tempoBlock: tempoBlock.toString() };
  console.log(`opening float booked at Tempo block ${tempoBlock}`);
}

// Customer deposits: pathUSD into the treasury after the opening block (fee-manager refunds excluded).
{
  const scanned = BigInt((await artifacts.get<{ block: string }>("mainnet:deposits"))?.block ?? opening.tempoBlock);
  const head = await tempo.getBlockNumber();
  for (let from = scanned + 1n; from <= head; from += 5_000n) {
    const to = from + 4_999n > head ? head : from + 4_999n;
    const logs = await tempo.getLogs({ address: TOKENS.tempoPathUSD as Address, event: erc20[0], args: { to: treasury }, fromBlock: from, toBlock: to });
    for (const l of logs) {
      if (l.args.from!.toLowerCase() === FEE_MANAGER.toLowerCase()) continue;
      const r = await ledger.post({
        kind: "tempo.deposit",
        external: { venue: "tempo", ref: `${l.transactionHash}:${l.logIndex}` },
        metadata: { from: l.args.from },
        lines: [
          { account: await accounts.vault("treasury", "pathUSD", "tempo"), direction: "D", money: money("pathUSD", l.args.amount!) },
          { account: await accounts.customer(CUSTOMER, CORRIDOR, "pathUSD", "tempo"), direction: "C", money: money("pathUSD", l.args.amount!) },
        ],
      });
      if (!r.duplicate) console.log(`deposit ${formatMoney(money("pathUSD", l.args.amount!))} from ${l.args.from} (${l.transactionHash})`);
    }
    await artifacts.merge("mainnet:deposits", { block: to.toString() });
  }
}

const across = acrossBridgeLeg({
  env: "mainnet",
  artifacts,
  log,
  sender: (hop) =>
    hop === "tempo-base"
      ? (tempo as never)
      : {
          sendTransaction: (tx) => baseWallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }),
          waitForTransactionReceipt: (args) => baseRead.waitForTransactionReceipt(args),
        },
  depositor: (hop) => (hop === "tempo-base" ? treasury : relay),
  recipient: (hop) => (hop === "tempo-base" ? relay : solana.address),
  async received(hop, fillTx) {
    if (hop === "tempo-base") {
      const r = await baseRead.waitForTransactionReceipt({ hash: fillTx as Hex });
      return r.logs
        .filter((l) => l.address.toLowerCase() === TOKENS.baseUSDC.toLowerCase())
        .map((l) => decodeEventLog({ abi: erc20, data: l.data, topics: l.topics }))
        .filter((e) => e.eventName === "Transfer" && e.args.to.toLowerCase() === relay.toLowerCase())
        .reduce((s, e) => s + (e.args as { amount: bigint }).amount, 0n);
    }
    const tx = await solanaTx(fillTx);
    return tokenOf(tx.meta.postTokenBalances, solana.address) - tokenOf(tx.meta.preTokenBalances, solana.address);
  },
  async gas(hop, txs): Promise<GasCost[]> {
    if (hop === "base-solana") return txs.map((t) => ({ txHash: t.txHash, asset: "ETH", venue: "base", vault: "base-relay", amount: t.wei }));
    // Tempo charges gas in pathUSD through the fee manager: read the actual transfers in each receipt.
    return Promise.all(
      txs.map(async (t) => {
        const r = await tempo.getTransactionReceipt({ hash: t.txHash as Hex });
        let paid = 0n;
        for (const l of r.logs) {
          if (l.address.toLowerCase() !== TOKENS.tempoPathUSD.toLowerCase()) continue;
          const e = decodeEventLog({ abi: erc20, data: l.data, topics: l.topics, strict: false });
          if (e.eventName !== "Transfer") continue;
          const { from, to, amount } = e.args as { from: string; to: string; amount: bigint };
          if (from.toLowerCase() === treasury.toLowerCase() && to.toLowerCase() === FEE_MANAGER.toLowerCase()) paid += amount;
          if (from.toLowerCase() === FEE_MANAGER.toLowerCase() && to.toLowerCase() === treasury.toLowerCase()) paid -= amount;
        }
        return { txHash: t.txHash, asset: "pathUSD" as const, venue: "tempo" as const, vault: "treasury", amount: paid };
      }),
    );
  },
});

const payoutLeg = partnerPayoutLeg({
  partners: registry,
  events,
  pollMs: 10_000,
  timeoutMs: 30 * 60_000,
  async fund({ to, usdcAmount, reference }) {
    const sig = await solana.transferWithReference({ toOwner: to, amount: usdcAmount, reference });
    log(`funded Paj order on Solana: https://solscan.io/tx/${sig}`);
    // The vault pays the network fee and the rent for the order's token account: booked from the transaction.
    const tx = await solanaTx(sig);
    const i = tx.transaction.message.accountKeys.findIndex((k) => k.pubkey === solana.address);
    const spent = BigInt(tx.meta.preBalances[i]! - tx.meta.postBalances[i]!);
    const fee = BigInt(tx.meta.fee);
    const sol = await accounts.vault("solana-egress", "SOL", "solana");
    await ledger.post({
      kind: "gas",
      reference,
      external: { venue: "solana", ref: `${sig}:gas` },
      lines: [
        { account: await accounts.expense("gas", "SOL", "solana"), direction: "D", money: money("SOL", fee) },
        ...(spent > fee ? [{ account: await accounts.expense("account-rent", "SOL", "solana"), direction: "D" as const, money: money("SOL", spent - fee) }] : []),
        { account: sol, direction: "C", money: money("SOL", spent) },
      ],
    });
    return sig;
  },
});

const engine = await SagaEngine.open(db, ledger, accounts, [ledgerReserveLeg, across, payoutLeg], { leaseMs: 60 * 60_000 });

// ---- report ----
const fmt = (asset: Asset, amount: bigint) => formatMoney(money(asset, amount));
async function vaultCheck() {
  const chain = await onChain();
  const rows = [];
  for (const [label, [name, asset, venue]] of Object.entries(VAULTS)) {
    const ledgerBal = (await ledger.balance(await accounts.vault(name, asset, venue))).amount;
    rows.push({ vault: label, onchain: fmt(asset, chain[label as keyof typeof chain]), ledger: fmt(asset, ledgerBal), balanced: chain[label as keyof typeof chain] === ledgerBal });
  }
  return rows;
}
const available = (await ledger.balance(await accounts.customer(CUSTOMER, CORRIDOR, "pathUSD", "tempo"))).amount;
console.log(`customer ${CUSTOMER} available: ${fmt("pathUSD", available)}`);

const plan = planRoute({ corridor: CORRIDOR, privacy: "public", source: { venue: "tempo", asset: "pathUSD" }, destination: { venue: "partner_fiat", asset: "NGN" }, env: "mainnet" });
console.log(`plan: ${plan.steps.map((s) => `${s.kind} ${s.from.venue}→${s.to.venue}`).join(" · ")}`);

let sagaId: string | undefined;
const resumeIdx = process.argv.indexOf("--resume");
if (resumeIdx > -1) sagaId = process.argv[resumeIdx + 1];
const goIdx = process.argv.indexOf("--go");
if (goIdx > -1 && !sagaId) {
  const arg = process.argv[goIdx + 1];
  const amount = arg && !arg.startsWith("--") ? money("pathUSD", BigInt(Math.round(Number(arg) * 1e6))).amount : available;
  if (amount <= 0n || amount > available) throw new Error(`payout of ${fmt("pathUSD", amount)} exceeds the customer's ${fmt("pathUSD", available)}`);
  const payoutId = uuidv7();
  const data: PayoutData = {
    payoutId,
    customerId: CUSTOMER,
    corridor: CORRIDOR,
    asset: "pathUSD",
    venue: "tempo",
    amount: amount.toString(),
    reference: encodeRef({ kind: RefKind.Payout, corridor: CORRIDOR, shielded: false, id: payoutId, customerTag: customerTag(CUSTOMER, testnetKey("CORRIDOR_REF_SECRET")) }),
    recipient: { kind: "bank", bankCode: need("PAJ_PAYOUT_BANK_CODE"), accountNumber: need("PAJ_PAYOUT_ACCOUNT_NUMBER") },
    tempoStartBlock: (await tempo.getBlockNumber()).toString(),
  };
  sagaId = await engine.start({ kind: "payout", reference: data.reference, plan, data });
  console.log(`saga ${sagaId} · payout ${fmt("pathUSD", amount)} · reference ${data.reference}`);
}

if (sagaId) {
  const startedAt = new Date().toISOString();
  const status = await engine.run(sagaId);
  const view = await engine.get(sagaId);
  for (const s of view.steps) console.log(`  ${s.idx} ${s.kind.padEnd(15)} ${s.status.padEnd(10)} ${s.error ?? JSON.stringify(s.output)}`);
  const checks = await vaultCheck();
  console.table(checks);
  const invariants = await ledger.checkInvariants();
  console.log(`saga ${status} · ledger invariants ${invariants.length ? invariants.join("; ") : "hold"} · vaults ${checks.every((c) => c.balanced) ? "all balanced" : "DRIFT"}`);

  if (status === "completed") {
    const out = view.steps.map((s) => s.output as Record<string, any>);
    const pay = out[3]!;
    const { rows } = await db.query<{ input: { data: PayoutData } }>(`select input from sagas where id = $1`, [sagaId]);
    const input = rows[0]!.input;
    const records = existsSync(RECORD_FILE) ? JSON.parse(readFileSync(RECORD_FILE, "utf8")) : [];
    if (!records.some((r: { reference: string }) => r.reference === view.reference)) {
      records.push({
        engine: "saga",
        sagaId,
        reference: view.reference,
        corridor: CORRIDOR,
        startedAt,
        completedAt: new Date().toISOString(),
        input: { chain: "tempo", asset: "pathUSD", amount: (Number(input.data.amount) / 1e6).toFixed(6) },
        tempoDeposit: out[1]!.depositTx,
        tempoFill: out[1]!.fillTx,
        baseDeposit: out[2]!.depositTx,
        baseFill: out[2]!.fillTx,
        solanaTransfer: pay.fundingRef,
        pajStatus: "COMPLETED",
        payout: { partner: pay.partner, currency: pay.currency, id: pay.orderId, usdcAmount: pay.usdcPaid, fiatAmount: pay.fiatAmount, rate: pay.rate },
        bridgeFees: [out[1]!.fee, out[2]!.fee],
        gas: [...out[1]!.gas, ...out[2]!.gas].map((g: { txHash: string; asset: string; amount: string }) => ({
          chain: g.asset === "ETH" ? "base" : "tempo",
          txHash: g.txHash,
          amount: g.amount,
          unit: g.asset === "ETH" ? "wei" : "pathUSD, 6 dp",
        })),
        vaultCheck: checks,
        ledgerInvariants: invariants.length === 0 ? "hold" : invariants,
      });
      writeFileSync(RECORD_FILE, JSON.stringify(records, null, 2) + "\n");
      console.log(`recorded in ${RECORD_FILE}`);
    }
  }
} else {
  console.table(await vaultCheck());
  console.log("Dry run. Pass --go [amount] to run a payout.");
}
await db.close();
