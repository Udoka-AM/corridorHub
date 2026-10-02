import { useEffect, useRef, useState } from "react";
import { ANY_MOTION, EASE, Words, gsap, prefersReducedMotion, useGSAP } from "../motion";
import { ChainMark } from "./Chains";

// FROST batch ba4e845b on Zcash testnet: $15 paid to three suppliers in one Ironwood transaction.
const ROWS = [
  { to: "Supplier 1", amount: "$5.00", memo: "INV-2026-09-S01" },
  { to: "Supplier 2", amount: "$5.00", memo: "INV-2026-09-S02" },
  { to: "Supplier 3", amount: "$5.00", memo: "INV-2026-09-S03" },
];
const BATCH = "https://testnet.zcashexplorer.app/transactions/ba4e845b81b7d6faf350fd01cf967d9d35d717d5bc3eb455eb48ee945b3c38c7";
const GLYPHS = "▓▒░█▚▞#%&@$0123456789abcdef";

function noise(len: number) {
  return Array.from({ length: len }, () => GLYPHS[(Math.random() * GLYPHS.length) | 0]).join("");
}

/** A cell that shows ciphertext until the viewing key is applied, then decodes left to right. */
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

export default function Shielded() {
  const root = useRef<HTMLElement>(null);
  const [open, setOpen] = useState(false);
  const [signed, setSigned] = useState<number[]>([]);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        gsap.from(".shielded .reveal .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
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
      // Two of the three signers approve as the vault comes into view: signer 1, then signer 3.
      gsap.timeline({ scrollTrigger: { trigger: ".frost", start: "top 85%", once: true } })
        .call(() => setSigned([1]), [], 0.4)
        .call(() => setSigned([1, 3]), [], 1.1);
    },
    { scope: root },
  );

  return (
    <section className="shielded light" ref={root} id="shielded" aria-label="Shielded supplier payments">
      <div className="wrap grid">
        <div>
          <Words as="h2" className="h2 reveal" text={"Private from the public.\nOpen to the auditor."} />
          <p className="lede" style={{ marginTop: 28 }}>
            Importers pay suppliers through Zcash, so competitors never read their prices. Auditors get a key to one customer and one period.
          </p>
          <div className="frost" aria-label="Signers 1 and 3 of 3 approved the batch">
            {[1, 2, 3].map((n) => (
              <div key={n} className={`shard${signed.includes(n) ? " on" : ""}`}>
                key {n}
              </div>
            ))}
            <span className="eq">{signed.length >= 2 ? "2 of 3 signed · batch sent" : "awaiting 2 of 3"}</span>
          </div>
        </div>

        <div className="vault">
          <div className="top">
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              <ChainMark name="Zcash" width={22} height={22} /> Ironwood batch · 3 suppliers
            </span>
            <a href={BATCH} target="_blank" rel="noreferrer" data-hot>
              ba4e845b ↗
            </a>
          </div>
          <table>
            <thead>
              <tr>
                <th>Recipient</th>
                <th>Amount</th>
                <th>Invoice memo</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.memo}>
                  <Cell text={r.to} open={open} />
                  <Cell text={r.amount} open={open} />
                  <Cell text={r.memo} open={open} />
                </tr>
              ))}
            </tbody>
          </table>
          <div className="foot">
            <span className="muted" style={{ fontSize: 12 }}>
              {open ? "Auditor view: one vault, one period, read-only" : "What the public chain shows"}
            </span>
            <button className="keybtn" aria-pressed={open} onClick={() => setOpen((v) => !v)} data-hot>
              {open ? "Hide" : "Apply viewing key"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
