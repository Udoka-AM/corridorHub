/**
 * Testnet helper: move Sepolia ETH to Base Sepolia (gas for the Across testnet
 * hop) through Base's canonical L1StandardBridge. Arrives at the same address
 * on Base Sepolia after a few minutes.
 *
 *   pnpm tsx scripts/bridge-sepolia-eth.ts 0.02
 */
import { createPublicClient, createWalletClient, formatEther, http, parseAbi, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia, sepolia } from "viem/chains";
import { testnetKey } from "./env.ts";

const L1_STANDARD_BRIDGE = "0xfd0Bf71F60660E2f608ed56e1659C450eB113120"; // Base Sepolia's bridge on Sepolia
const amount = parseEther(process.argv[2] ?? "0.02");

const account = privateKeyToAccount(testnetKey("BASE_SEPOLIA_RELAY_KEY"));
const l1 = createPublicClient({ chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });
const l2 = createPublicClient({ chain: baseSepolia, transport: http() });
const wallet = createWalletClient({ account, chain: sepolia, transport: http("https://ethereum-sepolia-rpc.publicnode.com") });

console.log(`Sepolia ETH ${formatEther(await l1.getBalance({ address: account.address }))} · Base Sepolia ETH ${formatEther(await l2.getBalance({ address: account.address }))}`);

const hash = await wallet.writeContract({
  address: L1_STANDARD_BRIDGE,
  abi: parseAbi(["function depositETH(uint32 _minGasLimit, bytes _extraData) payable"]),
  functionName: "depositETH",
  args: [200_000, "0x"],
  value: amount,
});
const receipt = await l1.waitForTransactionReceipt({ hash });
console.log(`deposit ${formatEther(amount)} ETH: ${receipt.status} https://sepolia.etherscan.io/tx/${hash}`);

const before = await l2.getBalance({ address: account.address });
for (let i = 0; i < 40; i++) {
  const now = await l2.getBalance({ address: account.address });
  if (now > before) {
    console.log(`arrived on Base Sepolia: ${formatEther(now)} ETH`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15_000));
}
console.log("not arrived yet; L1→L2 deposits usually land within a few minutes");
