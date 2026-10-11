/**
 * Mainnet vaults for live payouts. Creates keys on first run
 * (never overwrites) and prints addresses and balances. Private keys stay in
 * .env.local and .keys/, both gitignored and chmod 600.
 *
 *   pnpm mainnet:wallets
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { createPublicClient, formatEther, formatUnits, http, parseAbi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Actions, createClient } from "viem/tempo";
import { TEMPO_TOKENS } from "@corridor/chain-tempo";

const ENV_FILE = ".env.local";
const SOLANA_KEYPAIR = ".keys/solana-mainnet-vault.json";
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

function evmKey(name: string): Hex {
  if (!process.env[name]) {
    const k = generatePrivateKey();
    appendFileSync(ENV_FILE, `${name}=${k}\n`);
    process.env[name] = k;
    console.log(`created ${name}`);
  }
  chmodSync(ENV_FILE, 0o600);
  return process.env[name] as Hex;
}

function solanaAddress(): string {
  if (!existsSync(SOLANA_KEYPAIR)) {
    mkdirSync(".keys", { recursive: true, mode: 0o700 });
    execFileSync("solana-keygen", ["new", "--no-bip39-passphrase", "--silent", "-o", SOLANA_KEYPAIR]);
    console.log(`created ${SOLANA_KEYPAIR}`);
  }
  chmodSync(SOLANA_KEYPAIR, 0o600);
  if (!process.env.SOLANA_MAINNET_VAULT_KEYPAIR) {
    appendFileSync(ENV_FILE, `SOLANA_MAINNET_VAULT_KEYPAIR=${SOLANA_KEYPAIR}\n`);
  }
  return execFileSync("solana-keygen", ["pubkey", SOLANA_KEYPAIR]).toString().trim();
}

const tempoVault = privateKeyToAccount(evmKey("TEMPO_MAINNET_VAULT_KEY")).address;
const baseRelay = privateKeyToAccount(evmKey("BASE_MAINNET_RELAY_KEY")).address;
const solanaVault = solanaAddress();

// ---- balances ----
const tempo = createClient({ transport: http() });
const tempoBal = async (asset: "pathUSD" | "USDC.e") =>
  (await Actions.token.getBalance(tempo, { token: TEMPO_TOKENS[asset]!, account: tempoVault })).formatted;

const baseClient = createPublicClient({ chain: base, transport: http() });
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const baseUsdc = await baseClient.readContract({
  address: BASE_USDC,
  abi: parseAbi(["function balanceOf(address) view returns (uint256)"]),
  functionName: "balanceOf",
  args: [baseRelay],
});

const SOLANA_RPC = process.env.SOLANA_MAINNET_RPC ?? "https://api.mainnet-beta.solana.com";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
async function solanaRpc<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(SOLANA_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result: T };
  return body.result;
}
const sol = await solanaRpc<{ value: number }>("getBalance", [solanaVault]);
const solUsdc = await solanaRpc<{ value: { account: { data: { parsed: { info: { tokenAmount: { uiAmountString: string } } } } } }[] }>(
  "getTokenAccountsByOwner",
  [solanaVault, { mint: SOLANA_USDC }, { encoding: "jsonParsed" }],
);

console.log(`
Tempo mainnet vault  ${tempoVault}
  pathUSD ${await tempoBal("pathUSD")} · USDC.e ${await tempoBal("USDC.e")}
  fund with: $30–50 of USDC.e or pathUSD (gas is paid in the same stablecoin)

Base relay           ${baseRelay}
  ETH ${formatEther(await baseClient.getBalance({ address: baseRelay }))} · USDC ${formatUnits(baseUsdc, 6)}
  fund with: ~0.001 ETH for gas on the Base → Solana hop

Solana vault         ${solanaVault}
  SOL ${sol.value / 1e9} · USDC ${solUsdc.value[0]?.account.data.parsed.info.tokenAmount.uiAmountString ?? "0 (no token account yet)"}
  fund with: ~0.02 SOL for fees and the USDC token account
`);
