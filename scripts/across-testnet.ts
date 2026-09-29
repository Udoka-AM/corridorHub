/**
 * Option A: the Base → Solana hop of the live route, for real, on Across's
 * testnet (Base Sepolia USDC → Solana devnet USDC). The Tempo → Base hop stays
 * simulated because Across has no Tempo testnet deployment.
 *
 *   pnpm across:testnet            # show wallets, balances and what to fund
 *   pnpm across:testnet --send 2   # bridge 2 USDC and wait for the fill
 *
 * Keys are generated on first run into .env.local / .keys/ (gitignored).
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, formatUnits, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { CHAINS, TOKENS, executeEvm, quote, waitForFill } from "@corridor/bridge-across";
import { testnetKey } from "./env.ts";

const SOLANA_DEVNET_KEYPAIR = ".keys/solana-devnet-vault.json";
const DEVNET = "https://api.devnet.solana.com";

const account = privateKeyToAccount(testnetKey("BASE_SEPOLIA_RELAY_KEY"));
const base = createPublicClient({ chain: baseSepolia, transport: http() });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http() });

if (!existsSync(SOLANA_DEVNET_KEYPAIR)) {
  mkdirSync(".keys", { recursive: true, mode: 0o700 });
  execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", SOLANA_DEVNET_KEYPAIR]);
  chmodSync(SOLANA_DEVNET_KEYPAIR, 0o600);
}
const solanaVault = execFileSync("solana-keygen", ["pubkey", SOLANA_DEVNET_KEYPAIR]).toString().trim();
const sol = (args: string[]) => execFileSync("solana", [...args, "--url", DEVNET], { encoding: "utf8" }).trim();
const splToken = (args: string[]) => execFileSync("spl-token", [...args, "--url", DEVNET], { encoding: "utf8" }).trim();

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const usdcBalance = () => base.readContract({ address: TOKENS.baseSepoliaUSDC, abi: erc20, functionName: "balanceOf", args: [account.address] });

const solBalance = Number(sol(["balance", solanaVault]).split(" ")[0]);
let hasUsdcAccount = true;
let solanaUsdc = "0";
try {
  solanaUsdc = splToken(["balance", TOKENS.solanaDevnetUSDC, "--owner", solanaVault]);
} catch {
  hasUsdcAccount = false;
}

console.log(`
Base Sepolia relay   ${account.address}
  ETH ${formatEther(await base.getBalance({ address: account.address }))} · USDC ${formatUnits(await usdcBalance(), 6)}
Solana devnet vault  ${solanaVault}
  SOL ${solBalance} · USDC ${hasUsdcAccount ? solanaUsdc : "(no token account yet)"}
`);

// Across (via CCTP) requires the recipient's USDC account to exist before it can fill.
if (!hasUsdcAccount) {
  if (solBalance < 0.01) {
    console.log("requesting devnet SOL from the public faucet…");
    try {
      sol(["airdrop", "1", solanaVault]);
    } catch (e) {
      console.log(`  airdrop refused (rate limited?): fund ${solanaVault} with devnet SOL, e.g. faucet.solana.com`);
    }
  }
  if (Number(sol(["balance", solanaVault]).split(" ")[0]) >= 0.01) {
    console.log("creating the vault's devnet USDC token account…");
    splToken(["create-account", TOKENS.solanaDevnetUSDC, "--owner", solanaVault, "--fee-payer", SOLANA_DEVNET_KEYPAIR]);
    hasUsdcAccount = true;
  }
}

const sendIdx = process.argv.indexOf("--send");
if (sendIdx === -1) {
  console.log("To run the bridge: fund the Base Sepolia address with test ETH and Circle test USDC, then `pnpm across:testnet --send 2`.");
  process.exit(0);
}
const amount = BigInt(Math.round(Number(process.argv[sendIdx + 1] ?? "2") * 1e6));
if (!hasUsdcAccount) throw new Error("Solana devnet USDC account missing; see above");
if ((await usdcBalance()) < amount) throw new Error("not enough Base Sepolia USDC");

const q = await quote({
  env: "testnet",
  originChainId: CHAINS.baseSepolia,
  destinationChainId: CHAINS.solanaDevnet,
  inputToken: TOKENS.baseSepoliaUSDC,
  outputToken: TOKENS.solanaDevnetUSDC,
  amount,
  depositor: account.address,
  recipient: solanaVault,
});
console.log(`quote ${q.id}: ${formatUnits(q.inputAmount, 6)} → ${formatUnits(q.expectedOutputAmount, 6)} USDC, ~${q.expectedFillTime}s`);

const { depositTxHash } = await executeEvm(
  {
    sendTransaction: (tx) => wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value }),
    waitForTransactionReceipt: (args) => base.waitForTransactionReceipt(args),
  },
  q,
);
console.log(`deposit https://sepolia.basescan.org/tx/${depositTxHash}`);

const fill = await waitForFill("testnet", CHAINS.baseSepolia, depositTxHash as Hex, {
  timeoutMs: 15 * 60_000,
  onPoll: (s) => console.log(`  status: ${s.status}`),
});
console.log(`fill: ${JSON.stringify(fill)}`);
console.log(`Solana devnet USDC now ${splToken(["balance", TOKENS.solanaDevnetUSDC, "--owner", solanaVault])}`);
