import { useRef, useState } from "react";
import { DESKTOP_MOTION, EASE, Words, gsap, useGSAP } from "../motion";
import { ChainMark } from "./Chains";

/**
 * The signature: the real 32-byte Corridor Reference from the testnet payout
 * that paid Shenzhen Brightline ¥7,140, read off its Tempo memo. As the
 * payment travels, the reference decodes one field at a time.
 */
const FIELDS = [
  { hex: "02", label: "version 2" },
  { hex: "01", label: "kind · payout" },
  { hex: "28", label: "from · NGN" },
  { hex: "46", label: "to · CNY" },
  { hex: "00", label: "flags · public lane" },
  { hex: "01a0eb3fe7e57ca994eb596e7f87c87f", label: "payment id · UUIDv7" },
  { hex: "33d74bd58688d8", label: "customer tag · keyed hash, no PII on-chain" },
  { hex: "53957c1f", label: "checksum · verified" },
];
const REF = FIELDS.map((f) => f.hex).join("");

const STAGES: { step: string; fields: number[]; caption: string }[] = [
  { step: "Collect", fields: [0, 1, 2, 3, 4], caption: "Corridor and lane, encoded in the first five bytes" },
  { step: "Settle", fields: [5], caption: "One id from quote to closed books" },
  { step: "Route", fields: [6], caption: "Which customer, without naming them on a public chain" },
  { step: "Pay out", fields: [7], caption: "Chain, partner and ledger matched three ways" },
];

const SCRAMBLE = "0123456789abcdef";

function MemoRain() {
  const text = useRef(Array.from({ length: 18 }, () => REF).join(" "));
  return <div className="memo" aria-hidden="true">{text.current}</div>;
}

export default function Journey() {
  const root = useRef<HTMLElement>(null);
  const [stage, setStage] = useState(0);
  const stageRef = useRef(0);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      // Scramble the reference into place once.
      mm.add("(prefers-reduced-motion: no-preference)", () => {
        const spans = gsap.utils.toArray<HTMLElement>(".ref .f[data-hex]");
        spans.forEach((el) => {
          const final = el.dataset.hex!;
          const state = { p: 0 };
          gsap.to(state, {
            p: 1,
            duration: 1.4,
            ease: "power2.out",
            scrollTrigger: { trigger: ".ref", start: "top 85%", once: true },
            onUpdate: () => {
              const keep = Math.floor(final.length * state.p);
              el.textContent = final.slice(0, keep) + Array.from({ length: final.length - keep }, () => SCRAMBLE[(Math.random() * 16) | 0]).join("");
            },
          });
        });
        gsap.from(".journey .head .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 75%", once: true } });
      });
      // Desktop: pin and travel sideways; the active stage follows progress.
      mm.add(DESKTOP_MOTION, () => {
        const track = root.current!.querySelector<HTMLElement>(".track")!;
        const distance = () => track.scrollWidth - window.innerWidth;
        const pan = gsap.to(track, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: {
            trigger: root.current,
            start: "top top",
            end: () => `+=${distance()}`,
            pin: true,
            scrub: 1,
            invalidateOnRefresh: true,
            onUpdate: (st) => {
              const next = Math.min(STAGES.length - 1, Math.floor(st.progress * STAGES.length * 0.999));
              if (next !== stageRef.current) {
                stageRef.current = next;
                setStage(next);
              }
            },
          },
        });
        gsap.utils.toArray<HTMLElement>(".panel .figure").forEach((el) => {
          gsap.from(el, { yPercent: 40, autoAlpha: 0, ease: "none", scrollTrigger: { trigger: el, containerAnimation: pan, start: "left 90%", end: "left 50%", scrub: true } });
        });
      });
      // Phone or reduced motion: panels stack; each lights as it enters.
      mm.add("(max-width: 900px), (prefers-reduced-motion: reduce)", () => {
        gsap.utils.toArray<HTMLElement>(".panel").forEach((panel, i) => {
          gsap.timeline({ scrollTrigger: { trigger: panel, start: "top 60%", onEnter: () => setStage(i), onEnterBack: () => setStage(i) } });
        });
      });
    },
    { scope: root },
  );

  const active = new Set(STAGES[stage]!.fields);
  return (
    <section className="journey" ref={root} id="how" aria-label="How a payment moves">
      <div className="viewport">
        <div className="wrap">
          <div className="head">
            <Words as="h2" className="h2 reveal" text={"One reference\nfollows the money."} />
          </div>
          <div className="ref tnum" aria-label={`Corridor Reference 0x${REF}`}>
            <span className="f">0x</span>
            {FIELDS.map((f, i) => (
              <span key={i} className={`f${active.has(i) ? " on" : ""}`} data-hex={f.hex} aria-hidden="true">
                {f.hex}
              </span>
            ))}
          </div>
          <p className="refcap" aria-live="polite">
            <b>{STAGES[stage]!.fields.map((i) => FIELDS[i]!.label).join(" · ")}</b>: {STAGES[stage]!.caption}
          </p>
        </div>

        <div className="track">
          <article className={`panel${stage >= 0 ? " lit" : ""}`}>
            <div>
              <span className="step">01 · {STAGES[0]!.step}</span>
              <div className="figure tnum">₦1,560,000</div>
              <p className="cap">Naira from an importer in Lagos, collected through a licensed ramp.</p>
            </div>
            <div className="visual">
              <svg className="mark" viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity=".25" />
                <circle cx="100" cy="100" r="64" fill="none" stroke="currentColor" strokeDasharray="4 6" />
                <text x="100" y="128" textAnchor="middle" fontSize="84" fontWeight="700" fill="currentColor" fontFamily="Space Mono">₦</text>
              </svg>
            </div>
          </article>
          <article className={`panel${stage >= 1 ? " lit" : ""}`}>
            <div>
              <span className="step">02 · {STAGES[1]!.step}</span>
              <div className="figure tnum">0.6 s</div>
              <p className="cap">1,000 pathUSD settles on Tempo, the reference in its memo.</p>
            </div>
            <div className="visual">
              <MemoRain />
              <ChainMark name="Tempo" className="mark" />
            </div>
          </article>
          <article className={`panel${stage >= 2 ? " lit" : ""}`}>
            <div>
              <span className="step">03 · {STAGES[2]!.step}</span>
              <div className="figure">Hub → spoke</div>
              <p className="cap">Bridged to the chain where the local partner settles.</p>
            </div>
            <div className="visual">
              <div className="routeviz" aria-hidden="true">
                <ChainMark name="Tempo" className="chain" />
                <span className="wire" />
                <ChainMark name="Base" className="chain" />
                <span className="wire" />
                <ChainMark name="Solana" className="chain" />
              </div>
            </div>
          </article>
          <article className={`panel${stage >= 3 ? " lit" : ""}`}>
            <div>
              <span className="step">04 · {STAGES[3]!.step}</span>
              <div className="figure tnum">¥7,140</div>
              <p className="cap">Paid to a supplier in Shenzhen. Books closed by reference.</p>
            </div>
            <div className="visual">
              <svg className="mark check" viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity=".25" />
                <path d="M58 104 l28 28 l56 -64" fill="none" stroke="currentColor" strokeWidth="10" strokeLinecap="square" />
              </svg>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}
