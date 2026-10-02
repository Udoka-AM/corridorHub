import { useRef } from "react";
import { ANY_MOTION, gsap, useGSAP } from "../motion";
import { BACKERS, CHAINS } from "./Chains";

/** A figure whose digits roll into place like an odometer. */
function Roll({ value }: { value: string }) {
  return (
    <span aria-label={value} style={{ display: "inline-flex" }}>
      {[...value].map((ch, i) =>
        /\d/.test(ch) ? (
          <span className="roll" key={i} aria-hidden="true" data-digit={ch}>
            <span>
              {Array.from({ length: 10 }, (_, d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={i} aria-hidden="true">{ch}</span>
        ),
      )}
    </span>
  );
}

const STATS = [
  { value: "0.6", unit: "s", note: "Settlement finality on Tempo" },
  { value: "45/45", unit: "", note: "Testnet movements reconciled across three chains" },
  { value: "32", unit: "", note: "Currencies reachable through one hub" },
  { value: "2/3", unit: "", note: "Signers to move a shielded vault. One alone is refused." },
];

export default function Proof() {
  const root = useRef<HTMLElement>(null);

  useGSAP(
    () => {
      const columns = gsap.utils.toArray<HTMLElement>(".roll > span");
      const settle = () => columns.forEach((col) => gsap.set(col, { yPercent: -10 * Number(col.parentElement!.dataset.digit) }));
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        columns.forEach((col, i) => {
          const digit = Number(col.parentElement!.dataset.digit);
          gsap.fromTo(
            col,
            { yPercent: 0 },
            {
              yPercent: -10 * digit,
              duration: 1.6 + (i % 4) * 0.15,
              ease: "expo.out",
              scrollTrigger: { trigger: ".stats", start: "top 85%", once: true },
            },
          );
        });
        gsap.from(".stat", { y: 40, autoAlpha: 0, duration: 1, ease: "expo.out", stagger: 0.08, scrollTrigger: { trigger: ".stats", start: "top 85%", once: true } });
      });
      mm.add("(prefers-reduced-motion: reduce)", settle);
    },
    { scope: root },
  );

  const strip = [...CHAINS.slice(0, 1), ...BACKERS, ...CHAINS.slice(1)];
  const loop = [...strip, ...strip];
  return (
    <section className="band" ref={root} aria-label="Proof">
      <div className="marquee" aria-label="Built on Tempo, incubated by Stripe and Paradigm; settles across Solana, Base, USDC, Zcash and NEAR Intents">
        <div className="track" aria-hidden="true">
          {loop.map(({ name, Icon }, i) => (
            <span className="item" key={i}>
              <Icon variant="mono" />
              {name}
            </span>
          ))}
        </div>
      </div>
      <div className="wrap">
        <div className="stats">
          {STATS.map((s) => (
            <div className="stat" key={s.value}>
              <div className="num tnum">
                <Roll value={s.value} />
                {s.unit && <span className="unit">{s.unit}</span>}
              </div>
              <p>{s.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
