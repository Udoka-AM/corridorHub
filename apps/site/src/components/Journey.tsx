import { useRef, useState } from "react";
import { DESKTOP_MOTION, EASE, Words, gsap, useGSAP } from "../motion";
import { ChainMark } from "./Chains";

/**
 * The signature: the real 32-byte Corridor Reference from the Stellar testnet
 * run of 17 Oct 2026, read back out of the transaction's MEMO_HASH. As the
 * payout moves, the reference decodes one field at a time.
 */
const FIELDS = [
  { hex: "02", label: "version 2" },
  { hex: "01", label: "kind · payout" },
  { hex: "14", label: "from · EUR" },
  { hex: "29", label: "to · KES" },
  { hex: "00", label: "flags · public lane" },
  { hex: "01a1494e71ec7073bfffc84d758d67d2", label: "payout id · UUIDv7" },
  { hex: "c6cf255f57adc6", label: "customer tag · keyed hash, no PII on the ledger" },
  { hex: "fd6cb505", label: "checksum · verified" },
];
const REF = FIELDS.map((f) => f.hex).join("");

const STAGES: { step: string; fields: number[]; caption: string }[] = [
  { step: "Reserve", fields: [0, 1, 2, 3, 4], caption: "Corridor and lane, encoded in the first five bytes" },
  { step: "Settle", fields: [5], caption: "One id from the firm quote to closed books" },
  { step: "Pay out", fields: [6], caption: "Which customer, without naming them on a public ledger" },
  { step: "Reconcile", fields: [7], caption: "Horizon, the anchor and the ledger matched three ways" },
];

const SCRAMBLE = "0123456789abcdef";

/** Lucide "plug" and "landmark", drawn in the page's single ink. */
function AnchorMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M12 22v-5M9 8V2M15 8V2M18 8v4a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
    </svg>
  );
}

function BankMark(props: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M3 22h18M6 18v-7M10 18v-7M14 18v-7M18 18v-7M12 2l9 5H3l9-5Z" />
    </svg>
  );
}

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
              <div className="figure tnum">7 USDC</div>
              <p className="cap">Held out of the customer&rsquo;s own balance on the Stellar hub, so it cannot be spent twice.</p>
            </div>
            <div className="visual">
              <svg className="mark" viewBox="0 0 200 200" aria-hidden="true">
                <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity=".25" />
                <circle cx="100" cy="100" r="64" fill="none" stroke="currentColor" strokeDasharray="4 6" />
                <text x="100" y="128" textAnchor="middle" fontSize="84" fontWeight="700" fill="currentColor" fontFamily="Space Mono">€</text>
              </svg>
            </div>
          </article>
          <article className={`panel${stage >= 1 ? " lit" : ""}`}>
            <div>
              <span className="step">02 · {STAGES[1]!.step}</span>
              <div className="figure">MEMO_HASH</div>
              <p className="cap">One payment to the anchor. The reference is 32 bytes and so is the memo, so it travels whole.</p>
            </div>
            <div className="visual">
              <MemoRain />
              <ChainMark name="Stellar" className="mark" />
            </div>
          </article>
          <article className={`panel${stage >= 2 ? " lit" : ""}`}>
            <div>
              <span className="step">03 · {STAGES[2]!.step}</span>
              <div className="figure">SEP-31</div>
              <p className="cap">The anchor settles on the hub itself, so nothing stands between the balance and the beneficiary.</p>
            </div>
            <div className="visual">
              <div className="routeviz" aria-hidden="true">
                <ChainMark name="Stellar" className="chain" />
                <span className="wire" />
                <AnchorMark className="chain" />
                <span className="wire" />
                <BankMark className="chain" />
              </div>
            </div>
          </article>
          <article className={`panel${stage >= 3 ? " lit" : ""}`}>
            <div>
              <span className="step">04 · {STAGES[3]!.step}</span>
              <div className="figure">no indexer</div>
              <p className="cap">Read back off the account&rsquo;s own payment stream and booked. A join, not an index.</p>
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
