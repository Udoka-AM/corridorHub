import { useRef } from "react";
import { ANY_MOTION, EASE, gsap, useGSAP } from "../motion";

const REPO = "https://github.com/Udoka-AM/corridor";

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
            <p className="lede">A 60-day pilot on the wallets you already run: matched payouts and an exceptions list, no keys shared. Taking design partners now, starting with Europe → Africa and Africa → Asia.</p>
            <div>
              <a className="btn primary" href={REPO} target="_blank" rel="noreferrer" data-hot>
                Start a pilot <span className="arr">→</span>
              </a>
            </div>
          </div>
          <div className="path">
            <h3 className="h3">One integration reaches every region.</h3>
            <p className="lede">Payout partners, ramps and liquidity providers on any continent, in USDC, USDT, PYUSD or EURC.</p>
            <div>
              <a className="btn" href="https://corridorapp.mintlify.app/integrations/partner-interface" target="_blank" rel="noreferrer" data-hot>
                Read the partner interface <span className="arr">↗</span>
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
