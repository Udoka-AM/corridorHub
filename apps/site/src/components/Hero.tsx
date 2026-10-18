import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ANY_MOTION, EASE, Words, gsap, useGSAP, useReducedMotion } from "../motion";
import { ChainMark } from "./Chains";

const HubScene = lazy(() => import("./HubScene"));

// What has actually run, on Stellar testnet on 17 Oct 2026, plus the prototype's
// one mainnet payout, labelled as the prototype's.
const FEED = [
  { pair: "EUR → KES", amt: "0x020114 29…", state: "reference read back" },
  { pair: "EUR → KES", amt: "7 USDC", state: "reserved · hold" },
  { pair: "EUR → KES", amt: "ledger 5241532", state: "funded exactly once" },
  { pair: "EUR → KES", amt: "Δ 0", state: "invariants clean" },
  { pair: "EUR → NGN", amt: "₦3,891.48", state: "prototype · 74 s" },
];

export default function Hero({ ready }: { ready: boolean }) {
  const root = useRef<HTMLElement>(null);
  const reduced = useReducedMotion();
  const [inView, setInView] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(Boolean(e?.isIntersecting)), { threshold: 0 });
    if (root.current) io.observe(root.current);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setTick((t) => (t + 1) % FEED.length), 2400);
    return () => clearInterval(id);
  }, [reduced]);

  useGSAP(
    () => {
      if (!ready) return;
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        gsap
          .timeline({ defaults: { ease: EASE } })
          .from(".hero .display .wi", { yPercent: 115, duration: 1.3, stagger: 0.08 })
          .from(".hero .lede, .hero .ctas, .hero .chains", { y: 24, autoAlpha: 0, duration: 1, stagger: 0.1 }, "-=0.9")
          .from(".hud", { y: 20, autoAlpha: 0, duration: 0.9 }, "-=0.8")
          .from(".hero .stage-in", { scale: 1.25, autoAlpha: 0, duration: 2.2, ease: "power3.out" }, 0);
        // The scene sinks back as the page takes over.
        gsap.to(".hero .stage", {
          scale: 1.18,
          autoAlpha: 0.25,
          ease: "none",
          scrollTrigger: { trigger: root.current, start: "top top", end: "bottom top", scrub: 1 },
        });
        gsap.to(".hero .copy", {
          yPercent: -18,
          autoAlpha: 0,
          ease: "none",
          scrollTrigger: { trigger: root.current, start: "20% top", end: "80% top", scrub: 1 },
        });
      });
    },
    { scope: root, dependencies: [ready] },
  );

  const now = FEED[tick]!;
  return (
    <header className="hero" ref={root} id="top">
      <div className="stage">
        <div className="stage-in">
          <Suspense fallback={null}>
            <HubScene active={inView} reduced={reduced} />
          </Suspense>
        </div>
      </div>
      <div className="shade" />
      <div className="wrap copy">
        <Words as="h1" className="display" text={"Never lose a\ncross-border payout."} />
        <p className="lede">
          Corridor settles your cross-border payouts on Stellar, exactly once, on your own keys, and keeps books that match the chain to the stroop.
        </p>
        <div className="ctas">
          <a className="btn primary" href="#access" data-hot>
            Start a read-only pilot <span className="arr">→</span>
          </a>
          <a className="btn" href="https://corridor.udokaam.dev/start/ten-minute-review" target="_blank" rel="noreferrer" data-hot>
            Review it in ten minutes <span className="arr">↗</span>
          </a>
        </div>
        <div className="chains" aria-label="Settles on Stellar; reaches Solana and Base for inflows and the one corridor off the hub">
          {["Stellar", "Solana", "Base"].map((c) => (
            <ChainMark key={c} name={c} />
          ))}
          <span className="label">Stellar hub · Solana · Base</span>
        </div>
      </div>
      <div className="hud" aria-live="off">
        <div className="row">
          <span className="live label"><i /> payout feed</span>
          <span className="label">Stellar testnet · 17 Oct 2026</span>
        </div>
        <div className="row tnum" key={tick}>
          <span>{now.pair}</span>
          <span>{now.amt}</span>
          <span className="muted">{now.state}</span>
        </div>
      </div>
    </header>
  );
}
