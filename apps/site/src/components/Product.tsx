import { useRef } from "react";
import { ANY_MOTION, DESKTOP_MOTION, EASE, Words, gsap, useGSAP } from "../motion";

export default function Product() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        gsap.from(".product .reveal .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
        // The screen tilts flat and takes on colour as it comes into focus.
        gsap.fromTo(
          ".screen .frame",
          { rotateX: 26, scale: 0.86, y: 60 },
          { rotateX: 0, scale: 1, y: 0, ease: "none", scrollTrigger: { trigger: ".screen", start: "top 95%", end: "top 25%", scrub: 1 } },
        );
        gsap.fromTo(
          ".screen img",
          { filter: "grayscale(1) contrast(1.05) brightness(0.7)" },
          { filter: "grayscale(0.15) contrast(1.02) brightness(1)", ease: "none", scrollTrigger: { trigger: ".screen", start: "top 70%", end: "top 15%", scrub: 1 } },
        );
        gsap.from(".proofcard", { y: 60, autoAlpha: 0, duration: 1.1, ease: EASE, scrollTrigger: { trigger: ".screen", start: "top 40%", once: true } });
      });
      mm.add(DESKTOP_MOTION, () => {
        gsap.fromTo(".screen .float", { y: 160 }, { y: -40, ease: "none", scrollTrigger: { trigger: ".screen", start: "top bottom", end: "bottom top", scrub: 1 } });
      });
    },
    { scope: root },
  );

  return (
    <section className="product" ref={root} id="books" aria-label="Books that match the chain">
      <div className="wrap">
        <div className="head">
          <Words as="h2" className="h2 reveal" text={"Books that close\nthemselves."} />
          <a className="btn" href="https://corridor.udokaam.dev/architecture/ledger" target="_blank" rel="noreferrer" data-hot>
            Read the ledger <span className="arr">↗</span>
          </a>
        </div>
        <div className="screen">
          <div className="frame">
            <img
              src="./media/console-overview.jpg"
              alt="The prototype's treasury console, reading Tempo and Solana: payouts, hub balances, settlement network and reconciliation"
              width={2200}
              height={1161}
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="float" aria-hidden="true">
            <img src="./media/console-timeline.jpg" alt="" width={1600} height={1238} loading="lazy" decoding="async" />
          </div>
          <div className="proofcard">
            <span className="label" style={{ color: "#5d5d5a" }}>Every entry</span>
            <div className="big tnum">7 dp</div>
            <span>Stellar&rsquo;s own precision, so a vault can equal the ledger to the stroop</span>
          </div>
        </div>
        <p className="source">
          Shown: the treasury console from Corridor&rsquo;s earlier <b>Tempo prototype</b>, reading Tempo and Solana. There is no console in the Stellar build — it was removed rather than
          left reporting a chain this repository no longer settles on. Read-only reporting runs from <b>pnpm watch:report</b>, and the ledger, the saga tables and the matcher
          already hold everything a console would show.
        </p>
      </div>
    </section>
  );
}
