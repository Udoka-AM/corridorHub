import { useRef } from "react";
import { ANY_MOTION, EASE, gsap, useGSAP } from "../motion";

const PILOT = "https://corridor.udokaam.dev/flows/read-only-pilot";

export default function Closing() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        // The line slides against the scroll, one row each way.
        gsap.fromTo(".giant.l", { xPercent: 4 }, { xPercent: -28, ease: "none", scrollTrigger: { trigger: root.current, start: "top bottom", end: "bottom top", scrub: 1 } });
        gsap.fromTo(".giant.r", { xPercent: -30 }, { xPercent: 2, ease: "none", scrollTrigger: { trigger: root.current, start: "top bottom", end: "bottom top", scrub: 1 } });
        gsap.from(".closing .path", { y: 60, autoAlpha: 0, duration: 1.1, ease: EASE, stagger: 0.1, scrollTrigger: { trigger: ".closing .paths", start: "top 85%", once: true } });
      });
    },
    { scope: root },
  );

  return (
    <section className="closing" ref={root} id="access" aria-labelledby="closing-title">
      <h2 id="closing-title" className="sr-only">Settle the corridor</h2>
      <div className="giant l" aria-hidden="true">
        Settle the <span className="o">corridor</span>
      </div>
      <div className="giant r" aria-hidden="true">
        <span className="o">Become</span> a spoke
      </div>
      <div className="wrap">
        <div className="paths">
          <div className="path">
            <h3 className="h3">Start read-only. Move money when ready.</h3>
            <p className="lede">A 60-day pilot on the Stellar accounts you already run: matched payouts and an exceptions list, no keys shared. Taking design partners now, starting with Europe → East Africa.</p>
            <div>
              <a className="btn primary" href={PILOT} target="_blank" rel="noreferrer" data-hot>
                Start a pilot <span className="arr">→</span>
              </a>
            </div>
          </div>
          <div className="path">
            <h3 className="h3">Publish a stellar.toml. Reach every region.</h3>
            <p className="lede">Anchors speak SEP-1, 10, 12, 38 and 31, so becoming a spoke is a home domain and an asset rather than an integration. No anchor is signed yet — the first one opens the first corridor.</p>
            <div>
              <a className="btn" href="https://corridor.udokaam.dev/integrations/sep-anchors" target="_blank" rel="noreferrer" data-hot>
                Read the anchor interface <span className="arr">↗</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
