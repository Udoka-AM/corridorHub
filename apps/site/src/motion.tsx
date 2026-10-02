import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Fragment, useEffect, useState } from "react";

gsap.registerPlugin(ScrollTrigger, useGSAP);
export { gsap, ScrollTrigger, useGSAP };

export const EASE = "expo.out";
export const DESKTOP_MOTION = "(min-width: 901px) and (prefers-reduced-motion: no-preference)";
export const ANY_MOTION = "(prefers-reduced-motion: no-preference)";

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * Headline split into words that each clip their own overflow, so they can
 * rise into place. Screen readers get the sentence once, via aria-label.
 */
export function Words({ text, as: Tag = "span", className }: { text: string; as?: "h1" | "h2" | "span" | "p"; className?: string }) {
  const lines = text.split("\n");
  return (
    <Tag className={className} aria-label={text.replace(/\n/g, " ")}>
      {lines.map((line, li) => (
        <span key={li} aria-hidden="true" style={{ display: "block" }}>
          {line.split(" ").map((word, wi, all) => (
            <Fragment key={wi}>
              <span className="w">
                <span className="wi">{word}</span>
              </span>
              {wi < all.length - 1 ? " " : null}
            </Fragment>
          ))}
        </span>
      ))}
    </Tag>
  );
}

/** Rise every `.wi` inside `scope` when it scrolls into view. */
export function revealWords(scope: Element | null, selector = ".reveal .wi") {
  if (!scope || prefersReducedMotion()) return;
  scope.querySelectorAll<HTMLElement>(selector.split(" ")[0]).forEach((block) => {
    gsap.from(block.querySelectorAll(".wi"), {
      yPercent: 110,
      duration: 1.1,
      ease: EASE,
      stagger: 0.05,
      scrollTrigger: { trigger: block, start: "top 85%", once: true },
    });
  });
}

// Dev-only handle for inspecting triggers from the browser console.
if (import.meta.env.DEV) (window as unknown as { ST: typeof ScrollTrigger }).ST = ScrollTrigger;
