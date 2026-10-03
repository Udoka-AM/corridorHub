import { NetworkBase, NetworkSolana, NetworkTempo, TokenEURC, TokenNEAR, TokenPYUSD, TokenUSDC, TokenUSDT, TokenZEC } from "@web3icons/react";
import type { ComponentType, SVGProps } from "react";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { variant?: "mono" | "branded" | "background"; size?: number | string }>;

/** The chains Corridor settles across, as their real marks, drawn in the page's single ink. */
export const CHAINS: { name: string; role: string; Icon: Icon }[] = [
  { name: "Tempo", role: "settlement hub", Icon: NetworkTempo as Icon },
  { name: "Solana", role: "ramp liquidity", Icon: NetworkSolana as Icon },
  { name: "Base", role: "partner payouts", Icon: NetworkBase as Icon },
  { name: "Zcash", role: "shielded lane", Icon: TokenZEC as Icon },
  { name: "NEAR Intents", role: "USD → ZEC", Icon: TokenNEAR as Icon },
];

/** Stablecoins Corridor moves and reconciles, each with the company that issues it. */
export const STABLES: { name: string; issuer: string; Icon: Icon }[] = [
  { name: "USDC", issuer: "Circle", Icon: TokenUSDC as Icon },
  { name: "USDT", issuer: "Tether", Icon: TokenUSDT as Icon },
  { name: "EURC", issuer: "Circle", Icon: TokenEURC as Icon },
  { name: "PYUSD", issuer: "Paxos", Icon: TokenPYUSD as Icon },
];

// Tempo's incubators. Marks drawn monochrome: Stripe from Simple Icons, Paradigm from paradigm.xyz.
type MarkProps = SVGProps<SVGSVGElement> & { variant?: string };

function StripeMark({ variant, ...props }: MarkProps) {
  void variant;
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z" />
    </svg>
  );
}
function ParadigmMark({ variant, ...props }: MarkProps) {
  void variant;
  return (
    <svg viewBox="7 6 18 21" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M14.3194 25.4786L13.2572 24.8368V23.1992L11.8187 24.018L10.7565 23.3983V21.7607L9.36229 22.5574L8.30005 21.9156V10.408L9.2959 9.85477L10.7565 10.6957V9.01383L11.7966 8.43845L13.2572 9.27939V7.59751L14.3194 7L24.3 12.7317V13.9488L22.8616 14.7898L24.3 15.6086V16.8479L22.8837 17.6667L24.3 18.4855V19.7248L14.3194 25.4786ZM14.2752 24.2614L23.2821 19.1272L21.7994 18.2863L14.2752 22.6017V24.2614ZM11.8187 22.8008L13.2572 21.982V20.3223L11.8187 21.1411V22.8008ZM9.34016 21.3624L10.7565 20.5436V11.9129L9.34016 11.0941V21.3624ZM11.8187 19.9461L13.2572 19.1051V13.3513L11.8187 12.5325V19.9461ZM11.8187 11.3154L13.2572 12.1342V10.4744L11.8187 9.6556V11.3154ZM14.2752 21.3845L20.7592 17.6667L19.2987 16.8257L14.2752 19.7248V21.3845ZM14.2752 18.5297L18.2586 16.2282L14.2752 13.9267V18.5297ZM14.2752 12.7095L19.3208 15.6307L20.7814 14.7898L14.2752 11.0719V12.7095ZM14.2752 9.85477L21.8215 14.1923L23.2821 13.3513L14.2752 8.19502V9.85477ZM20.3609 16.2282L21.8215 17.0692L23.2821 16.2282L21.7994 15.3873L20.3609 16.2282Z" />
    </svg>
  );
}

export const BACKERS: { name: string; role: string; Icon: Icon }[] = [
  { name: "Stripe", role: "incubated Tempo", Icon: StripeMark as Icon },
  { name: "Paradigm", role: "incubated Tempo", Icon: ParadigmMark as Icon },
];

export function ChainMark({ name, ...rest }: { name: string } & SVGProps<SVGSVGElement>) {
  const c = CHAINS.find((x) => x.name === name);
  if (!c) return null;
  return <c.Icon variant="mono" aria-hidden="true" {...rest} />;
}
