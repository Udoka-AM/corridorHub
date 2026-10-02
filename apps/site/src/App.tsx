import { useCallback, useEffect, useState } from "react";
import { ScrollTrigger } from "./motion";
import { Cursor, Footer, Intro, Nav, Progress } from "./components/Chrome";
import Hero from "./components/Hero";
import Proof from "./components/Proof";
import Collapse from "./components/Collapse";
import Journey from "./components/Journey";
import Shielded from "./components/Shielded";
import Product from "./components/Product";
import Market from "./components/Market";
import Closing from "./components/Closing";

export default function App() {
  const [ready, setReady] = useState(false);
  const done = useCallback(() => setReady(true), []);

  // Pins measure layout: re-measure once fonts and images have settled.
  useEffect(() => {
    const refresh = () => ScrollTrigger.refresh();
    document.fonts?.ready.then(refresh);
    window.addEventListener("load", refresh);
    return () => window.removeEventListener("load", refresh);
  }, []);

  return (
    <>
      <Intro onDone={done} />
      <Progress />
      <Cursor />
      <div className="grain" aria-hidden="true" />
      <Nav />
      <main>
        <Hero ready={ready} />
        <Proof />
        <Collapse />
        <Journey />
        <Shielded />
        <Product />
        <Market />
        <Closing />
      </main>
      <Footer />
    </>
  );
}
