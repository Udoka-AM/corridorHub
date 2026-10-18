import { useEffect, useRef, useState } from "react";
import { ANY_MOTION, EASE, ScrollTrigger, Words, gsap, prefersReducedMotion, useGSAP } from "../motion";
import { ChainMark } from "./Chains";

/**
 * Three payments on a watched Stellar account. Until the memo is decoded they
 * are 32 opaque bytes; decoded, each one names its corridor and its payout id
 * and matches a record in the company's own books.
 *
 * The first row is the real smoke-test payment of 17 Oct 2026; the others are
 * the shape the same account's stream takes.
 */
const ROWS = [
  { memo: "0x020114290001a1494e…fd6cb505", open: "EUR-KES payout · 01a1494e", state: "matched" },
  { memo: "0x020114290001a14951…8b40c7e2", open: "EUR-KES payout · 01a14951", state: "short · fee" },
  { memo: "0x020129460001a14955…21ce0d14", open: "KES-CNY payout · 01a14955", state: "missing" },
];
const TX = "https://stellar.expert/explorer/testnet/tx/175ad4206f85b279831178a5ad896da123105005f265fb5c798ae3d09254781c";
const SOURCES = ["payout records", "Horizon payments", "anchor status"];
const GLYPHS = "▓▒░█▚▞#%&@$0123456789abcdef";

function noise(len: number) {
  return Array.from({ length: len }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join("");
}

/** A cell that churns until the reference is decoded, then resolves left to right. */
function Cell({ text, open }: { text: string; open: boolean }) {
  const [shown, setShown] = useState(() => noise(text.length));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(open ? text : "•".repeat(text.length));
      return;
    }
    let frame = 0;
    let raf = 0;
    const step = () => {
      frame++;
      if (open) {
        const keep = Math.min(text.length, Math.floor(frame / 1.6));
        setShown(text.slice(0, keep) + noise(text.length - keep));
        if (keep < text.length) raf = requestAnimationFrame(step);
      } else {
        if (frame % 4 === 0) setShown(noise(text.length));
        raf = requestAnimationFrame(step);
      }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [open, text]);
  return <td className={open ? "" : "cipher"}>{shown}</td>;
}

export default function Recon() {
  const root = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [joined, setJoined] = useState<number[]>([]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        // The light section opens out of the dark as a card, then folds back into one as it leaves.
        const el = root.current!;
        const clamp = (n: number) => Math.min(1, Math.max(0, n));
        ScrollTrigger.create({
          trigger: el,
          start: "top bottom",
          end: "bottom top",
          onUpdate: () => {
            const r = el.getBoundingClientRect();
            const vh = window.innerHeight;
            const enter = clamp((vh - r.top) / (vh * 0.8));
            const exit = clamp((vh * 0.75 - r.bottom) / (vh * 0.75));
            const k = Math.max(1 - enter, exit);
            el.style.clipPath = `inset(${7 * (1 - enter)}% ${5 * k}% ${7 * exit}% ${5 * k}% round ${28 * k}px)`;
          },
          onLeave: () => (el.style.clipPath = ""),
          onLeaveBack: () => (el.style.clipPath = ""),
        });
        gsap.from(".recon .reveal .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
        gsap.from(".vault", {
          y: 80,
          rotateX: 14,
          autoAlpha: 0,
          transformPerspective: 1200,
          duration: 1.4,
          ease: EASE,
          scrollTrigger: { trigger: ".vault", start: "top 85%", once: true },
        });
      });
      // The three sources come in one at a time as the panel arrives.
      gsap.timeline({ scrollTrigger: { trigger: ".joins", start: "top 85%", once: true } })
        .call(() => setJoined([0]), [], 0.3)
        .call(() => setJoined([0, 1]), [], 0.8)
        .call(() => setJoined([0, 1, 2]), [], 1.3);
    },
    { scope: root },
  );

  return (
    <section className="recon light" ref={root} id="reconcile" aria-label="Reconciliation">
      <div className="wrap grid">
        <div>
          <Words as="h2" className="h2 reveal" text={"Opaque on the ledger.\nExact in your books."} />
          <p className="lede" style={{ marginTop: 28 }}>
            Every payment carries a 32-byte reference in Stellar&rsquo;s <code>MEMO_HASH</code>. It names no customer on a public ledger, and it is the join key that
            matches a Horizon payment to your own payout record — no indexer in the path.
          </p>
          <div className="joins" aria-label="Three sources joined on one reference">
            {SOURCES.map((s, i) => (
              <div key={s} className={`src${joined.includes(i) ? " on" : ""}`}>
                {s}
              </div>
            ))}
            <span className="eq">{joined.length >= 3 ? "3 sources · 1 exception raised" : "joining…"}</span>
          </div>
        </div>

        <div className="vault">
          <div className="top">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <ChainMark name="Stellar" width={22} height={22} /> Watched account · testnet
            </span>
            <a href={TX} target="_blank" rel="noreferrer" data-hot>
              175ad420 ↗
            </a>
          </div>
          <table>
            <thead>
              <tr>
                <th>Memo on Stellar</th>
                <th>Against your record</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.memo}>
                  <td className={open ? "" : "cipher"}>{open ? r.open : r.memo}</td>
                  <Cell text={r.state} open={open} />
                </tr>
              ))}
            </tbody>
          </table>
          <div className="foot">
            <span className="muted" style={{ fontSize: 12 }}>
              {open ? "Decoded: corridor, payout id, checksum — and what the books say" : "What the ledger shows: 32 bytes"}
            </span>
            <button className="keybtn" aria-pressed={open} onClick={() => setOpen((v) => !v)} data-hot>
              {open ? "Hide" : "Decode the reference"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
