import { useEffect, useRef, useState } from "react";
import { ANY_MOTION, EASE, Words, gsap, prefersReducedMotion, useGSAP } from "../motion";

/**
 * On-chain value received in Sub-Saharan Africa, Chainalysis Geography of
 * Crypto reports (July to June years, labelled by the year they end).
 */
const FLOWS = [
  { y: "2021", v: 105.6 },
  { y: "2022", v: 100.6 },
  { y: "2023", v: 117.1 },
  { y: "2024", v: 125 },
  { y: "2025", v: 205 },
];
const FIVE_YEARS = FLOWS.reduce((s, f) => s + f.v, 0); // ≈ $653B
const STABLE_SHARE = 0.43; // stablecoins' share of the region's volume, 2024–2025
const STABLE_NOW = 205 * STABLE_SHARE; // ≈ $88B
const GROWTH = 0.4; // projection: 40% a year, below the last year's 52%
const TAKE = 0.003; // 0.30% all-in take on settled volume

const W = 640;
const H = 280;
const PAD = { l: 8, r: 8, t: 28, b: 34 };
const MAX = 220;
const px = (i: number) => PAD.l + (i / (FLOWS.length - 1)) * (W - PAD.l - PAD.r);
const py = (v: number) => H - PAD.b - (v / MAX) * (H - PAD.t - PAD.b);
const LINE = FLOWS.map((f, i) => `${i ? "L" : "M"}${px(i).toFixed(1)},${py(f.v).toFixed(1)}`).join(" ");
const AREA = `${LINE} L${px(FLOWS.length - 1)},${H - PAD.b} L${px(0)},${H - PAD.b} Z`;

const money = (bn: number) => (bn >= 1 ? `$${bn.toFixed(bn >= 100 ? 0 : 1)}B` : `$${Math.round(bn * 1000)}M`);
const millions = (m: number) => `$${m.toFixed(m >= 100 ? 0 : 1)}M`;

/** A number that counts to its new value instead of jumping. */
function Count({ value, format }: { value: number; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef(value);
  useEffect(() => {
    const el = ref.current!;
    if (prefersReducedMotion()) {
      el.textContent = format(value);
      last.current = value;
      return;
    }
    const state = { n: last.current };
    const tween = gsap.to(state, { n: value, duration: 0.6, ease: "power3.out", onUpdate: () => (el.textContent = format(state.n)) });
    last.current = value;
    return () => {
      tween.kill();
    };
  }, [value, format]);
  return <span ref={ref}>{format(value)}</span>;
}

export default function Market() {
  const root = useRef<HTMLElement>(null);
  const [share, setShare] = useState(5);
  const [future, setFuture] = useState(true);

  const flow = future ? STABLE_NOW * Math.pow(1 + GROWTH, 3) : STABLE_NOW; // $B a year
  const volume = (flow * share) / 100; // $B settled through Corridor
  const revenue = volume * 1000 * TAKE; // $M a year

  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      mm.add(ANY_MOTION, () => {
        gsap.from(".market .reveal .wi", { yPercent: 110, duration: 1.1, ease: EASE, stagger: 0.05, scrollTrigger: { trigger: root.current, start: "top 70%", once: true } });
        gsap.from(".cell", { autoAlpha: 0, y: 50, duration: 1.1, ease: EASE, stagger: 0.08, scrollTrigger: { trigger: ".bento", start: "top 80%", once: true } });
        const chart = gsap.timeline({ scrollTrigger: { trigger: ".flowchart", start: "top 80%", once: true } });
        chart
          .fromTo(".flowchart .line", { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 1.8, ease: "power2.inOut" })
          .from(".flowchart .area", { opacity: 0, duration: 1.2 }, 0.5)
          .from(".flowchart .pt", { scale: 0, transformOrigin: "50% 50%", duration: 0.5, stagger: 0.18, ease: "back.out(2)" }, 0.2)
          .from(".flowchart .val", { opacity: 0, y: 8, duration: 0.5, stagger: 0.18 }, 0.3)
          .from(".flowchart .jump", { opacity: 0, x: -12, duration: 0.6 }, 1.6);
      });
    },
    { scope: root },
  );

  return (
    <section className="market" ref={root} id="economics" aria-label="Market and economics">
      <div className="wrap">
        <Words as="h2" className="h2 reveal" text={"A $205B rail.\nGrowing 52% a year."} />
        <div className="bento">
          <div className="cell c-chart">
            <div className="chart-head">
              <div>
                <div className="figure tnum">${Math.round(FIVE_YEARS)}B</div>
                <p>Moved on-chain in Sub-Saharan Africa in five years. The rails exist. The ledger licensed companies need to run on them doesn't.</p>
              </div>
            </div>
            <svg className="flowchart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`On-chain value received in Sub-Saharan Africa: ${FLOWS.map((f) => `${f.y} $${f.v}B`).join(", ")}`}>
              {[50, 100, 150, 200].map((g) => (
                <line key={g} className="grid" x1={PAD.l} x2={W - PAD.r} y1={py(g)} y2={py(g)} />
              ))}
              <path className="area" d={AREA} />
              <path className="line" d={LINE} pathLength={1} />
              {FLOWS.map((f, i) => (
                <g key={f.y}>
                  <circle className="pt" cx={px(i)} cy={py(f.v)} r={i === FLOWS.length - 1 ? 7 : 4.5} />
                  <text className="val tnum" x={px(i)} y={py(f.v) - 14} textAnchor={i === 0 ? "start" : i === FLOWS.length - 1 ? "end" : "middle"}>
                    ${f.v}B
                  </text>
                  <text className="yr" x={px(i)} y={H - 10} textAnchor={i === 0 ? "start" : i === FLOWS.length - 1 ? "end" : "middle"}>
                    {f.y}
                  </text>
                </g>
              ))}
              <text className="jump" x={px(FLOWS.length - 1) - 16} y={py(205) + 30} textAnchor="end">
                +52% in a year
              </text>
            </svg>
          </div>

          <div className="cell c-trade">
            <div className="figure tnum">$1.5T</div>
            <p>Africa's trade with the world in 2024. Every import is a payment out. Every export, a payment in.</p>
          </div>

          <div className="cell c-stable">
            <div className="figure tnum">${Math.round(STABLE_NOW)}B</div>
            <p>Of it moved in stablecoins last year: 43% of all on-chain volume, already the settlement asset of choice.</p>
          </div>

          <div className="cell c-sim">
            <div className="sim-head">
              <span className="h3">What Corridor earns</span>
              <div className="seg" role="group" aria-label="Flow year">
                <button aria-pressed={!future} onClick={() => setFuture(false)} data-hot>
                  Today
                </button>
                <button aria-pressed={future} onClick={() => setFuture(true)} data-hot>
                  2028
                </button>
              </div>
            </div>
            <label className="share">
              <span>
                Share of the region's stablecoin flow: <b className="tnum">{share}%</b>
              </span>
              <input
                type="range"
                min={1}
                max={15}
                step={1}
                value={share}
                onChange={(e) => setShare(Number(e.target.value))}
                style={{ ["--p" as string]: `${((share - 1) / 14) * 100}%` }}
              />
            </label>
            <div className="sim-out" aria-live="polite">
              <div>
                <span className="muted">Settled a year</span>
                <div className="figure tnum">
                  <Count value={volume} format={money} />
                </div>
              </div>
              <div>
                <span className="muted">Revenue a year</span>
                <div className="figure tnum hot">
                  <Count value={revenue} format={millions} />
                </div>
              </div>
            </div>
            <p className="note">
              Routed volume at a 0.30% take; ledger subscriptions come on top. A scenario, not a forecast. {future ? "2028 assumes stablecoin flows grow 40% a year, below the last year's 52%." : "Today's flow: $88B a year."}
            </p>
          </div>

          <div className="cell c-take">
            <div className="figure tnum">0.30%</div>
            <p>On volume Corridor routes, all in. Before that, a monthly ledger subscription from the first read-only pilot.</p>
          </div>
        </div>
        <p className="source">Chainalysis Geography of Crypto 2021–2025 (Sub-Saharan Africa, July–June years) · Afreximbank African Trade Report 2025 · shares are scenarios, not forecasts.</p>
      </div>
    </section>
  );
}
