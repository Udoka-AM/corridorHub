import { NetworkBase, NetworkSolana, NetworkStellar, TokenEURC, TokenPYUSD, TokenUSDC, TokenUSDT, TokenXLM } from "@web3icons/react";
import type { ComponentType, SVGProps } from "react";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { variant?: "mono" | "branded" | "background"; size?: number | string }>;

/** Where Corridor settles, and the two chains it reaches off the hub, as their real marks in the page's single ink. */
export const CHAINS: { name: string; role: string; Icon: Icon }[] = [
  { name: "Stellar", role: "settlement hub", Icon: NetworkStellar as Icon },
  { name: "Solana", role: "the one spoke off the hub", Icon: NetworkSolana as Icon },
  { name: "Base", role: "USDC inflows", Icon: NetworkBase as Icon },
];

/** Stablecoins Corridor books and reconciles, each with the company that issues it. */
export const STABLES: { name: string; issuer: string; Icon: Icon }[] = [
  { name: "USDC", issuer: "Circle", Icon: TokenUSDC as Icon },
  { name: "EURC", issuer: "Circle", Icon: TokenEURC as Icon },
  { name: "USDT", issuer: "Tether", Icon: TokenUSDT as Icon },
  { name: "PYUSD", issuer: "Paxos", Icon: TokenPYUSD as Icon },
];

/** XLM is held only as fee float, and booked to expense:gas from the transaction that paid it. */
export const FEE_ASSET: { name: string; issuer: string; Icon: Icon } = { name: "XLM", issuer: "fee float", Icon: TokenXLM as Icon };

export function ChainMark({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  const c = CHAINS.find((x) => x.name === name);
  if (!c) return null;
  return <c.Icon variant="mono" aria-hidden="true" {...rest} />;
}
