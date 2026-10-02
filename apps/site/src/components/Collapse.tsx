import { useRef } from "react";
import { DESKTOP_MOTION, EASE, Words, gsap, useGSAP } from "../motion";

// A pre-funded account in every country a payment company serves.
const NOSTROS = [
  "NGN", "KES", "GHS", "ZAR", "EGP", "UGX", "TZS", "RWF", "XOF", "XAF", "MAD",
  "CNY", "HKD", "INR", "AED", "SGD", "TRY", "USD", "CAD", "MXN", "BRL", "COP", "EUR", "GBP",
];

// Deterministic scatter so the field looks the same on every load.
function place(i: number) {
  const cols = 6;
  const col = i % cols;
  const row = Math.floor(i / cols);
  const jx = ((i * 53) % 17) - 8;
  const jy = ((i * 29) % 13) - 6;
  return { left: `${4 + col * 15.5 + jx * 0.4}%`, top: `${4 + row * 23 + jy * 0.6}%` };
}

export default function Collapse() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(DESKTOP_MOTION, () => {
        const field = root.current!.querySelector<HTMLElement>(".field")!;
        const box = field.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const tiles = gsap.utils.toArray<HTMLElement>(".tile");
        const tl = gsap.timeline({
          defaults: { ease: "power2.inOut" },
          scrollTrigger: { trigger: root.current, start: "top top", end: "+=170%", pin: ".pin", scrub: 1, invalidateOnRefresh: true },
        });
        tl.to(tiles, {
          x: (i: number) => {
            const r = tiles[i]!.getBoundingClientRect();
            return cx - (r.left + r.width / 2);
          },
          y: (i: number) => {
            const r = tiles[i]!.getBoundingClientRect();
            return cy - (r.top + r.height / 2);
          },
          scale: 0.15,
          rotate: (i: number) => ((i * 47) % 50) - 25,
          autoAlpha: 0,
          stagger: { each: 0.02, from: "random" },
          duration: 1,
        })
          .to(".phase.a", { autoAlpha: 0, y: -40, duration: 0.3 }, 0.38)
          .fromTo(".hubdot", { scale: 0 }, { scale: 1, duration: 0.6, ease: "expo.out" }, 0.62)
          .fromTo(".phase.b", { autoAlpha: 0, y: 40 }, { autoAlpha: 1, y: 0, duration: 0.4 }, 0.66);
        // Idle balances flicker while they wait.
        gsap.to(".tile b", { opacity: 0.35, duration: 0.6, repeat: -1, yoyo: true, ease: "steps(2)", stagger: { each: 0.15, from: "random", repeat: -1 } });
      });
      mm.add("(max-width: 900px), (prefers-reduced-motion: reduce)", () => {
        gsap.set(".hubdot", { scale: 1 });
        gsap.set(".phase.b", { autoAlpha: 1 });
      });
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        gsap.from(".collapse .phase.a .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
      });
    },
    { scope: root },
  );

  return (
    <section className="collapse" ref={root} aria-label="The problem and the fix">
      <div className="wrap pin">
        <div className="say">
          <div className="phase a">
            <span className="big tnum">~9%</span>
            <Words as="h2" className="h2" text={"Cash trapped in a bank\nin every country."} />
            <p className="lede">The cost of sending $200 into Sub-Saharan Africa, the most expensive region in the world. Settlement still takes T+1 to T+3.</p>
          </div>
          <div className="phase b">
            <span className="big">1</span>
            <h2 className="h2">Balance on Tempo. Zero nostros.</h2>
            <p className="lede">One stablecoin balance funds every corridor. Topped up when a 7-day forecast says so.</p>
          </div>
        </div>
        <div className="field" aria-hidden="true">
          {NOSTROS.map((ccy, i) => (
            <div className="tile" key={ccy} style={place(i)}>
              <span>nostro</span>
              <b>{ccy}</b>
              <span>idle · T+2</span>
            </div>
          ))}
          <div className="hubdot">
            <div>
              <b>pathUSD</b>
              <span>one balance</span>
            </div>
          </div>
        </div>
      </div>
      <p className="wrap source">Source: World Bank Remittance Prices Worldwide, Q1 2025.</p>
    </section>
  );
}
