import { NetworkBase, NetworkSolana, NetworkTempo, TokenNEAR, TokenUSDC, TokenZEC } from "@web3icons/react";
import type { ComponentType, SVGProps } from "react";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { variant?: "mono" | "branded" | "background"; size?: number | string }>;

/** The chains Corridor settles across, as their real marks, drawn in the page's single ink. */
export const CHAINS: { name: string; role: string; Icon: Icon }[] = [
  { name: "Tempo", role: "settlement hub", Icon: NetworkTempo as Icon },
  { name: "Solana", role: "ramp liquidity", Icon: NetworkSolana as Icon },
  { name: "Base", role: "partner payouts", Icon: NetworkBase as Icon },
  { name: "USDC", role: "settlement asset", Icon: TokenUSDC as Icon },
  { name: "Zcash", role: "shielded lane", Icon: TokenZEC as Icon },
  { name: "NEAR Intents", role: "USD → ZEC", Icon: TokenNEAR as Icon },
];

export function ChainMark({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  const c = CHAINS.find((x) => x.name === name);
  if (!c) return null;
  return <c.Icon variant="mono" aria-hidden="true" {...rest} />;
}
