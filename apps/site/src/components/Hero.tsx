import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { ANY_MOTION, EASE, Words, gsap, useGSAP, useReducedMotion } from "../motion";
import { ChainMark } from "./Chains";

const HubScene = lazy(() => import("./HubScene"));

// Real payouts: the first is the live mainnet payout of 11 Oct 2026; the rest are runs the console recorded.
const FEED = [
  { pair: "EUR → NGN", amt: "₦3,891.48", state: "credited · 74 s" },
  { pair: "NGN → CNY", amt: "₦1,560,000", state: "collected" },
  { pair: "NGN → CNY", amt: "¥7,140", state: "paid out" },
  { pair: "EUR → NGN", amt: "₦10,710", state: "paid out" },
  { pair: "USD → ZEC", amt: "3 suppliers", state: "shielded" },
  { pair: "EUR → NGN", amt: "4 pathUSD", state: "compensated" },
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
          Corridor runs your stablecoin payouts across every provider, exactly once, on your own keys, and keeps books that match the chain.
        </p>
        <div className="ctas">
          <a className="btn primary" href="#access" data-hot>
            Start a read-only pilot <span className="arr">→</span>
          </a>
          <a className="btn" href="./console/" data-hot>
            Open the live console <span className="arr">↗</span>
          </a>
        </div>
        <div className="chains" aria-label="Settles across Tempo, Solana, Base and Zcash">
          {["Tempo", "Solana", "Base", "Zcash"].map((c) => (
            <ChainMark key={c} name={c} />
          ))}
          <span className="label">Tempo · Solana · Base · Zcash</span>
        </div>
      </div>
      <div className="hud" aria-live="off">
        <div className="row">
          <span className="live label"><i /> payout feed</span>
          <span className="label">74 s to a bank account</span>
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
