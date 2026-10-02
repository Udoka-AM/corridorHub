import { useRef } from "react";
import { ANY_MOTION, EASE, Words, gsap, useGSAP } from "../motion";

// Six regions; a hub needs one link per region, a bilateral mesh needs one per pair.
const R = 6;
const nodes = Array.from({ length: R }, (_, i) => {
  const a = (i / R) * Math.PI * 2 - Math.PI / 2;
  return { x: 160 + Math.cos(a) * 120, y: 115 + Math.sin(a) * 95 };
});

export default function Market() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        gsap.from(".market .reveal .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
        gsap.from(".cell", { autoAlpha: 0, y: 50, duration: 1.1, ease: EASE, stagger: 0.08, scrollTrigger: { trigger: ".bento", start: "top 80%", once: true } });
        gsap.to(".bars .bar i", { scaleX: (_i: number, el: HTMLElement) => Number(el.dataset.v), duration: 1.6, ease: "expo.out", stagger: 0.15, scrollTrigger: { trigger: ".bars", start: "top 85%", once: true } });
        // Correspondent settlement crawls; Tempo arrives before you look.
        const race = gsap.timeline({ repeat: -1, repeatDelay: 0.8, scrollTrigger: { trigger: ".race", start: "top 90%", toggleActions: "play pause resume pause" } });
        race
          .fromTo(".race .slow i", { left: "0%" }, { left: "calc(100% - 10px)", duration: 6, ease: "none" }, 0)
          .fromTo(".race .fast i", { left: "0%" }, { left: "calc(100% - 10px)", duration: 0.6, ease: "power2.out" }, 0);
        // Mesh links fade as the hub replaces them.
        gsap.timeline({ scrollTrigger: { trigger: ".mesh", start: "top 80%", end: "bottom 30%", scrub: 1 } })
          .to(".mesh .pair", { strokeOpacity: 0.04, duration: 1 })
          .fromTo(".mesh .spoke", { strokeOpacity: 0 }, { strokeOpacity: 0.9, duration: 1 }, 0.3)
          .fromTo(".mesh .hub", { scale: 0, transformOrigin: "50% 50%" }, { scale: 1, duration: 0.6 }, 0.4);
      });
      mm.add("(prefers-reduced-motion: reduce)", () => {
        gsap.set(".bars .bar i", { scaleX: (_i: number, el: HTMLElement) => Number(el.dataset.v) });
      });
    },
    { scope: root },
  );

  const pairs: [number, number][] = [];
  for (let i = 0; i < R; i++) for (let j = i + 1; j < R; j++) pairs.push([i, j]);

  return (
    <section className="market" ref={root} id="economics" aria-label="Market and economics">
      <div className="wrap">
        <Words as="h2" className="h2 reveal" text={"Both directions.\nOne hub."} />
        <div className="bento">
          <div className="cell c-a">
            <div>
              <div className="figure tnum">$179B</div>
              <p>Chinese exports to Africa in 2024. Every one is a payment an African business has to get abroad.</p>
            </div>
            <div className="bars" aria-label="Cost of sending $200: Sub-Saharan Africa about 9%, global average 6.49%">
              <div className="bar">
                <span>Sub-Saharan Africa</span>
                <i data-v="1" />
                <span className="tnum">~9%</span>
              </div>
              <div className="bar dim">
                <span>Global average</span>
                <i data-v="0.72" />
                <span className="tnum">6.49%</span>
              </div>
              <p className="source">World Bank RPW, Q1 2025 · China GAC, 2024</p>
            </div>
          </div>
          <div className="cell c-b">
            <div className="race" aria-label="Correspondent banking settles in one to three days; Tempo in 0.6 seconds">
              <div className="lane slow">
                <span className="muted">Correspondent</span>
                <span className="rail"><i /></span>
              </div>
              <div className="lane fast">
                <span>Tempo</span>
                <span className="rail"><i /></span>
              </div>
            </div>
            <div>
              <div className="figure tnum">T+2 → 0.6 s</div>
              <p>Capital stops waiting in foreign accounts.</p>
            </div>
          </div>
          <div className="cell c-c">
            <svg className="mesh" viewBox="0 0 320 230" aria-label="Six regions: fifteen bilateral links collapse into six links through one hub">
              {pairs.map(([a, b], k) => (
                <line key={k} className="pair" x1={nodes[a]!.x} y1={nodes[a]!.y} x2={nodes[b]!.x} y2={nodes[b]!.y} />
              ))}
              {nodes.map((n, k) => (
                <line key={`s${k}`} className="spoke" x1={160} y1={115} x2={n.x} y2={n.y} style={{ strokeOpacity: 0 }} />
              ))}
              {nodes.map((n, k) => (
                <circle key={`n${k}`} cx={n.x} cy={n.y} r={6} />
              ))}
              <circle className="hub" cx={160} cy={115} r={16} />
            </svg>
            <div>
              <div className="figure tnum">N, not N²</div>
              <p>Each new partner reaches every other region on day one.</p>
            </div>
          </div>
          <div className="cell c-d">
            <div className="figure tnum">~30 bps</div>
            <p>All-in take: settlement, FX share and float, plus treasury software.</p>
          </div>
          <div className="cell c-e">
            <div className="figure tnum">$200K / yr</div>
            <p>From one mid-size payout company settling $5M a month through Corridor.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
