# Treasury console

Six read-only panels over the Stellar ledger and the saga tables.

```bash
pnpm console:serve                 # http://127.0.0.1:8788
pnpm console:demo                  # invented figures in .data/console-demo
RAMP_DATA_DIR=.data/console-demo pnpm console:serve
```

| Panel | What it reads |
|---|---|
| Corridor board | Customer and customer-hold balances, per corridor and asset |
| Pre-funding forecast | Postings out of each customer's balance over 7 days, against what is left |
| Venue balances | Vault balances per venue, and the clearing pairs with their net |
| Settlement timeline | The 25 most recently touched sagas, with each step's transaction |
| Exceptions queue | Failed compensations first, then `manual_review` stops |
| Booked fees | The revenue accounts |

It reads and nothing else: no keys are opened, nothing is posted, and anything other than `GET` is refused. It binds to localhost because it is Corridor's own operations view and has no authentication in front of it.

**Chain-side reconciliation is not here.** Matching Horizon against the books means polling as an observer, and an observer advances its cursors — a write, and one that would consume movements the reconciler has not seen yet. Run that separately:

```bash
CORRIDOR_WATCH=GABC…,GDEF… pnpm watch:report
```

`public/prototype.html` is the earlier Tempo console, kept as a static replay of the prototype. Every figure in it is a Tempo-era run from 11 October 2026, not a Stellar one.
