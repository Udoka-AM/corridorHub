import { useEffect, useRef, useState } from "react";
import { gsap, prefersReducedMotion, useGSAP } from "../motion";

export function Mark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M1.5 6.5 L8.4 10.6 M1.5 17.5 L8.4 13.4 M22.5 6.5 L15.6 10.6 M22.5 17.5 L15.6 13.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Nav() {
  return (
    <nav className="nav" aria-label="Primary">
      <a className="mark" href="#top" aria-label="Corridor home">
        <Mark /> Corridor
      </a>
      <div className="links">
        <a href="#how">How it works</a>
        <a href="#shielded">Shielded</a>
        <a href="#economics">Economics</a>
        <a href="./console/">Console</a>
        <a href="https://corridor.udokaam.dev" target="_blank" rel="noreferrer">Docs</a>
      </div>
      <a className="btn primary sm" href="#access" data-hot>
        Start a pilot
      </a>
    </nav>
  );
}

/** Thin bar that tracks reading position. */
export function Progress() {
  const bar = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    gsap.to(bar.current, { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });
  });
  return <div className="progress" ref={bar} aria-hidden="true" />;
}

/** A ring that trails the pointer and swells over anything clickable. */
export function Cursor() {
  const ring = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (prefersReducedMotion() || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    const el = ring.current!;
    const xTo = gsap.quickTo(el, "x", { duration: 0.45, ease: "power3" });
    const yTo = gsap.quickTo(el, "y", { duration: 0.45, ease: "power3" });
    const move = (e: PointerEvent) => {
      xTo(e.clientX);
      yTo(e.clientY);
      const hot = (e.target as HTMLElement | null)?.closest("a, button, [data-hot]");
      el.classList.toggle("hot", Boolean(hot));
    };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return <div className="cursor" ref={ring} aria-hidden="true" />;
}

/**
 * Opening sequence: a count to 100 while the scene loads, then the screen
 * splits open. Shown once per session; skipped for reduced motion.
 */
export function Intro({ onDone }: { onDone: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [skip] = useState(() => {
    if (prefersReducedMotion()) return true;
    try {
      return sessionStorage.getItem("corridor-intro") === "seen";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (skip) onDone();
  }, [skip, onDone]);

  useGSAP(
    () => {
      if (skip) return;
      const count = { v: 0 };
      const label = root.current!.querySelector(".count")!;
      gsap
        .timeline({
          onComplete: () => {
            try {
              sessionStorage.setItem("corridor-intro", "seen");
            } catch {
              /* storage unavailable: the intro just plays again next time */
            }
          },
        })
        .to(count, { v: 100, duration: 1.2, ease: "power2.inOut", onUpdate: () => (label.textContent = String(Math.round(count.v)).padStart(3, "0")) })
        .to(".intro .bar i", { scaleX: 1, duration: 1.2, ease: "power2.inOut" }, 0)
        .call(onDone, [], 1.15)
        .to(".intro .count, .intro .tag, .intro .bar", { autoAlpha: 0, duration: 0.25 }, 1.25)
        .to(".intro .half.top", { yPercent: -100, duration: 0.9, ease: "expo.inOut" }, 1.3)
        .to(".intro .half.bottom", { yPercent: 100, duration: 0.9, ease: "expo.inOut" }, 1.3)
        .set(root.current, { display: "none" });
    },
    { scope: root },
  );

  if (skip) return null;
  return (
    <div className="intro" ref={root} aria-hidden="true">
      <div className="half top" />
      <div className="half bottom" />
      <span className="count">000</span>
      <span className="tag label">Corridor · payment ledger</span>
      <span className="bar"><i /></span>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="wrap">
        <span>Corridor · software licensed payment companies run with their own keys. Corridor never holds customer funds.</span>
        <a href="./console/">Live console</a>
        <a href="https://corridor.udokaam.dev" target="_blank" rel="noreferrer">Docs</a>
        <a href="https://tempo-solana-swap.pages.dev" target="_blank" rel="noreferrer">Tempo ⇌ Solana swap</a>
        <span className="end">© 2026 Corridor</span>
      </div>
    </footer>
  );
}
