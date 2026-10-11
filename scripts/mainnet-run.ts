/**
 * The live route on mainnet, end to end: Tempo USDC.e → Base USDC (Across),
 * Base USDC → Solana USDC (Across), Solana USDC → NGN in a bank account (Paj).
 *
 * Each step is checkpointed to .data/mainnet-run.json before and after it
 * moves money, so a crash or a rerun resumes where it stopped and never sends
 * twice. A finished run is appended to examples/mainnet/payouts.json (public:
 * hashes, amounts and the reference, no bank details) and the next --go starts
 * a new payout. Payout details come from .env.local (PAJ_PAYOUT_BANK_CODE,
 * PAJ_PAYOUT_ACCOUNT_NUMBER); account numbers are masked in output.
 *
 *   pnpm mainnet:run            # show the plan and balances
 *   pnpm mainnet:run --go       # run (or resume) the route
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Hex } from "viem";
import { base } from "viem/chains";
import { CHAINS, TOKENS, executeEvm, quote, waitForFill, type AcrossQuote } from "@corridor/bridge-across";
import { balanceOf, tempoClient } from "@corridor/chain-tempo";
import { RefKind, customerTag, encodeRef, uuidv7 } from "@corridor/core";
import { PajPartner } from "@corridor/partners";
import { testnetKey } from "./env.ts";
import { evmAccountFor, tempoAccountFor } from "./signers.ts";

const STATE_FILE = ".data/mainnet-run.json";
const RECORD_FILE = "examples/mainnet/payouts.json";
const SOLANA_KEYPAIR = process.env.SOLANA_MAINNET_VAULT_KEYPAIR ?? ".keys/solana-mainnet-vault.json";
const SOLANA_RPC = process.env.SOLANA_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";

interface State {
  reference: Hex;
  tempoDeposit?: Hex;
  tempoFill?: string;
  baseDeposit?: Hex;
  baseFill?: string;
  pajOrder?: { id: string; fundingAddress: string; usdcAmount: string; fiatAmount: string; rate: number };
  solanaTransfer?: string;
  pajStatus?: string;
  gas: { chain: string; txHash: string; amount: string }[];
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}
const mask = (s: string) => `******${s.slice(-4)}`;
const load = (): State | undefined => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : undefined);
const save = (s: State) => writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), { mode: 0o600 });

// ---- clients ----
const tempo = tempoClient({ network: "mainnet", account: await tempoAccountFor("TEMPO_MAINNET_VAULT_KEY") });
const relay = await evmAccountFor("BASE_MAINNET_RELAY_KEY");
const baseRead = createPublicClient({ chain: base, transport: http() });
const baseWallet = createWalletClient({ account: relay, chain: base, transport: http() });
const solanaVault = execFileSync("solana-keygen", ["pubkey", SOLANA_KEYPAIR]).toString().trim();
const paj = new PajPartner({ apiKey: need("PAJ_API_KEY") });
const bankCode = need("PAJ_PAYOUT_BANK_CODE");
const accountNumber = need("PAJ_PAYOUT_ACCOUNT_NUMBER");

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const baseUsdc = () => baseRead.readContract({ address: TOKENS.baseUSDC, abi: erc20, functionName: "balanceOf", args: [relay.address] });
const tempoUsdc = () => balanceOf(tempo, "USDC.e", tempo.account.address);
async function solanaUsdc(): Promise<bigint> {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTokenAccountsByOwner",
      params: [solanaVault, { mint: TOKENS.solanaUSDC }, { encoding: "jsonParsed" }],
    }),
  });
  const body = (await res.json()) as { result: { value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] } };
  return body.result.value.reduce((s, a) => s + BigInt(a.account.data.parsed.info.tokenAmount.amount), 0n);
}
const usdc = (n: bigint) => formatUnits(n, 6);

const rate = await paj.rates("NGN");
console.log(`
Tempo vault   ${tempo.account.address}  USDC.e ${usdc(await tempoUsdc())}
Base relay    ${relay.address}  USDC ${usdc(await baseUsdc())}
Solana vault  ${solanaVault}  USDC ${usdc(await solanaUsdc())}
Payout        NGN to bank ${bankCode}, account ${mask(accountNumber)} · Paj off-ramp ${rate.offRamp} NGN/USD
`);

if (!process.argv.includes("--go")) {
  console.log("Dry run. Pass --go to move the funds.");
  process.exit(0);
}

const state: State = load() ?? {
  reference: encodeRef({
    kind: RefKind.Payout,
    corridor: "EUR-NGN",
    shielded: false,
    id: uuidv7(),
    customerTag: customerTag("corridor-mainnet-demo", testnetKey("CORRIDOR_REF_SECRET")),
  }),
  gas: [],
};
save(state);
console.log(`reference ${state.reference}`);

const show = (label: string, q: AcrossQuote) =>
  console.log(`${label}: ${usdc(q.inputAmount)} → ${usdc(q.expectedOutputAmount)} USDC (fee ${usdc(q.feeTotal)}), ~${q.expectedFillTime}s`);

// ---- 1. Tempo USDC.e → Base USDC ----
if (!state.tempoDeposit) {
  const amount = await tempoUsdc();
  if (amount === 0n) throw new Error("Tempo vault has no USDC.e");
  const q = await quote({
    env: "mainnet",
    originChainId: CHAINS.tempo,
    destinationChainId: CHAINS.base,
    inputToken: TOKENS.tempoUSDCe,
    outputToken: TOKENS.baseUSDC,
    amount,
    depositor: tempo.account.address,
    recipient: relay.address,
  });
  show("tempo → base", q);
  const r = await executeEvm(tempo as never, q);
  state.tempoDeposit = r.depositTxHash;
  // Tempo gas is paid in pathUSD through the fee AMM; the receipt reports it with 18 decimals, like wei.
  for (const g of r.gas) state.gas.push({ chain: "tempo", txHash: g.txHash, amount: g.wei.toString() });
  save(state);
  console.log(`  deposit https://explore.tempo.xyz/tx/${r.depositTxHash}`);
}
if (!state.tempoFill) {
  const fill = await waitForFill("mainnet", CHAINS.tempo, state.tempoDeposit, { onPoll: (s) => console.log(`  status ${s.status}`) });
  if (fill.status !== "filled") throw new Error(`tempo → base not filled: ${fill.status}; rerun to keep waiting`);
  state.tempoFill = fill.fillTx;
  save(state);
  console.log(`  filled https://basescan.org/tx/${fill.fillTx}`);
}

// ---- 2. Base USDC → Solana USDC ----
if (!state.baseDeposit) {
  const amount = await baseUsdc();
  if (amount === 0n) throw new Error("Base relay has no USDC yet; rerun once the fill lands");
  const q = await quote({
    env: "mainnet",
    originChainId: CHAINS.base,
    destinationChainId: CHAINS.solana,
    inputToken: TOKENS.baseUSDC,
    outputToken: TOKENS.solanaUSDC,
    amount,
    depositor: relay.address,
    recipient: solanaVault,
  });
  show("base → solana", q);
  const r = await executeEvm(
    {
      sendTransaction: (tx) => baseWallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }),
      waitForTransactionReceipt: (args) => baseRead.waitForTransactionReceipt(args),
    },
    q,
  );
  state.baseDeposit = r.depositTxHash;
  for (const g of r.gas) state.gas.push({ chain: "base", txHash: g.txHash, amount: g.wei.toString() });
  save(state);
  console.log(`  deposit https://basescan.org/tx/${r.depositTxHash}`);
}
if (!state.baseFill) {
  const fill = await waitForFill("mainnet", CHAINS.base, state.baseDeposit, { onPoll: (s) => console.log(`  status ${s.status}`) });
  if (fill.status !== "filled") throw new Error(`base → solana not filled: ${fill.status}; rerun to keep waiting`);
  state.baseFill = fill.fillTx;
  save(state);
  console.log(`  filled https://solscan.io/tx/${fill.fillTx}`);
}

// ---- 3. Paj offramp order ----
if (!state.pajOrder) {
  const amount = await solanaUsdc();
  if (amount === 0n) throw new Error("Solana vault has no USDC yet; rerun once the fill lands");
  const order = await paj.openPayout({
    currency: "NGN",
    chain: "SOLANA",
    usdcAmount: amount,
    beneficiary: { bankCode, accountNumber },
    reference: state.reference,
  });
  if (!order.fundingAddress) throw new Error(`Paj order ${order.id} came back without a funding address`);
  state.pajOrder = {
    id: order.id,
    fundingAddress: order.fundingAddress,
    usdcAmount: order.usdcAmount.toString(),
    fiatAmount: order.fiatAmount.toString(),
    rate: order.rate,
  };
  save(state);
  console.log(`paj order ${order.id}: ${usdc(order.usdcAmount)} USDC → ₦${(Number(order.fiatAmount) / 100).toFixed(2)} at ${order.rate}`);
}

// ---- 4. Fund the order from the Solana vault, memo-tagged with the reference ----
if (!state.solanaTransfer) {
  const out = execFileSync(
    "spl-token",
    [
      "transfer", TOKENS.solanaUSDC, usdc(BigInt(state.pajOrder.usdcAmount)), state.pajOrder.fundingAddress,
      "--owner", SOLANA_KEYPAIR, "--fee-payer", SOLANA_KEYPAIR,
      "--fund-recipient", "--allow-unfunded-recipient",
      "--with-memo", state.reference,
      "--url", SOLANA_RPC,
    ],
    { encoding: "utf8" },
  );
  const sig = out.match(/Signature:\s*(\S+)/)?.[1];
  if (!sig) throw new Error(`could not read the transfer signature:\n${out}`);
  state.solanaTransfer = sig;
  save(state);
  console.log(`  funded https://solscan.io/tx/${sig}`);
}

// ---- 5. Wait for Paj to pay the bank account ----
const deadline = Date.now() + 20 * 60_000;
while (true) {
  const o = await paj.getOrder(state.pajOrder.id);
  if (o.partnerStatus !== state.pajStatus) {
    state.pajStatus = o.partnerStatus;
    save(state);
    console.log(`  paj ${o.partnerStatus}`);
  }
  if (o.status === "completed" || o.status === "failed") break;
  if (Date.now() > deadline) {
    console.log("still processing after 20 minutes; rerun with --go to keep watching");
    break;
  }
  await new Promise((r) => setTimeout(r, 10_000));
}
console.log(`\n${JSON.stringify(state, null, 2)}`);

if (state.pajStatus === "COMPLETED") {
  const records = existsSync(RECORD_FILE) ? (JSON.parse(readFileSync(RECORD_FILE, "utf8")) as { reference: string }[]) : [];
  if (!records.some((r) => r.reference === state.reference)) {
    const { pajOrder, ...rest } = state;
    records.push({ ...rest, completedAt: new Date().toISOString(), corridor: "EUR-NGN", payout: { partner: "paj", currency: "NGN", ...pajOrder, fundingAddress: undefined } } as never);
    writeFileSync(RECORD_FILE, JSON.stringify(records, null, 2) + "\n");
    console.log(`recorded in ${RECORD_FILE}`);
  }
  renameSync(STATE_FILE, STATE_FILE.replace(".json", `-${state.reference.slice(2, 14)}.json`));
}
