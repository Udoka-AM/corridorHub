# Treasury console

**This is the Tempo prototype's console, kept as a static replay. It has no server in this repository.**

The console that shipped with Corridor's earlier Tempo build read Tempo, Solana and the Zcash lane. Its server was removed when Stellar became the only hub, rather than left reporting a chain this repo no longer settles on. `public/index.html` is the recorded replay as it was published, kept as evidence of the prototype — every figure in it is a Tempo-era run, not a Stellar one.

A Stellar console is not built yet. The read-only reporting it fronted is available from the command line:

```bash
CORRIDOR_WATCH=GABC…,GDEF… pnpm watch:report
```
