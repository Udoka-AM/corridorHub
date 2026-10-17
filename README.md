# Corridor

**Never lose a cross-border payout.**

Corridor is the payment ledger and router that licensed payment companies run in their own environment, on their own keys. It runs stablecoin payouts across the anchors and providers a company already uses, exactly once, and keeps one set of books that matches the chain.

Stellar is the settlement hub.

---

## Where this stands

A payout runs end to end on **Stellar testnet** today: the route planner picks the legs, the saga engine funds the anchor order exactly once, and the double-entry ledger closes with no invariant violations.

```
reference 0x020114290001a1494e71ec7073bfffc84d758d67d2c6cf255f57adc6fd6cb505
sent 0.1 XLM   → stellar.expert/explorer/testnet/tx/175ad420…54781c
read back 0.1 XLM with the same reference, decoded out of MEMO_HASH
ledger 5241532 · 2026-10-17T10:00:47Z
```

Reproduce it with `pnpm stellar:wallets && pnpm stellar:smoke`, then `pnpm stellar:payout` for the full saga. 110 tests cover the venue, the planner, the ledger, the saga and the SEP anchor adapter.

Corridor's earlier prototype settled on Tempo, and paid ₦3,891.48 into a Nigerian bank account 74 seconds after 2.90 USDC.e left a vault on 11 October 2026. That build lives in its own repository; Stellar is Corridor's home from here.

## The problem

A single EUR → KES payout crosses a bank collection, a stablecoin issuer, an anchor, sometimes a second chain, and the beneficiary's bank. Each system has its own identifier, and none of them holds the whole record.

Payment companies that use more than one provider run this today with provider dashboards, in-house scripts and month-end spreadsheets. It breaks in predictable ways:

- A payout is funded but never reaches the anchor, and nobody notices until the customer calls.
- A retry sends the same payout twice.
- Fees, reserves and rounding pile up as differences nobody can explain.
- An auditor asks which on-chain payment a bank credit belongs to, and there is no answer.

## What Corridor does

Corridor doesn't hold money, provide liquidity or carry licences. Anchors and licensed operators do that, and Corridor runs payouts across them.

| Capability | What it gives the operator |
|---|---|
| **Exactly-once payouts** | Each payout is a durable saga across Stellar, the anchor and any cross-chain hop. Every external step is recorded before Corridor waits on it, so a retry never pays twice; failures before money leaves unwind in reverse, failures after it stop for a person. |
| **Books that match the chain** | A double-entry ledger books every movement, fee, reserve and rounding difference from the transaction that caused it, and checks every vault on-chain against the ledger. The ledger keeps Stellar's own 7 decimal places, so a booked balance can equal an on-chain balance exactly. |
| **One reference end to end** | A 32-byte Corridor Reference is exactly the size of Stellar's `MEMO_HASH`, so it travels whole and reconciliation is a join on the watched account's own payment stream — no indexer. |
| **Anchors as spokes** | Every fiat spoke is reached over the same SEPs (10, 12, 31, 38) behind one partner interface. Adding a corridor is a domain and an asset, not an integration: N anchors mean N integrations, not N×N corridors. |
| **Customer-held keys** | Every vault signs through the customer's own signer. Stellar and Solana share Ed25519, so one held key serves both; Turnkey and AWS KMS adapters are built. |
| **Read-only start** | Corridor watches the Stellar accounts a company already runs and matches them against its payout records. Exceptions and CSV export; no keys, nothing moves. |
| **Issuer-neutral stablecoins** | USDC, EURC, PYUSD and MGUSD are all first-class, and the issuer is part of the asset's identity: a look-alike from another issuer is never booked as USDC. |
| **Cross-chain inflows** | USDC arrives from Base and Solana over CCTP and is credited on the hub, so a customer's balance is one balance. |

## How a payout moves

A Stellar anchor settles on the hub itself, so the common path has no bridge in it:

```
Customer balance on Stellar (USDC)
   │  ledger.reserve
   ▼
Stellar treasury ──payment, reference in MEMO_HASH──▶ Anchor (SEP-31) ──▶ Beneficiary's bank
   │                                                   │ order: reference    │ narration: reference
   ▼                                                   ▼                     ▼
Double-entry ledger ◀─────── observers (Horizon payments · anchor status · bank narration) ───────▶ Reconciliation
```

Naira is the exception for now: no licensed naira anchor is live on Stellar, so it goes out over one CCTP hop to a partner that settles on Solana. Moving it back onto the hub is one line in the route graph.

Architecture in depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What is built, what is left and what is being worked on this week: [docs/BUILD-PLAN.md](docs/BUILD-PLAN.md).

## Try it

```bash
pnpm install
pnpm test                 # 110 tests, no network
pnpm stellar:wallets      # creates and funds two testnet vaults
pnpm stellar:smoke        # a real payment, with the reference read back off the network
pnpm stellar:payout       # the whole saga: route, reserve, fund the anchor, book it
```

Read-only mode against accounts you already run:

```bash
CORRIDOR_WATCH=GABC…,GDEF… pnpm watch:report
```

## Layout

| Package | What it is |
|---|---|
| `packages/core` | Domain model, the Corridor Reference and its `MEMO_HASH` encoding |
| `packages/chain-stellar` | The hub: client, asset registry, payments with references, Horizon observer |
| `packages/routing` | Route graph and planner; the hub is enforced here |
| `packages/saga` | Saga engine: exactly-once, reverse-order compensation, manual-review stop |
| `packages/ledger` | Double-entry ledger, account conventions, invariant checks |
| `packages/partners` | The anchor interface, the SEP-10/12/31/38 adapter, and off-Stellar partners |
| `packages/legs` | The leg implementations the saga executes |
| `packages/recon` | Reconciliation, read-only mode and vault checks |
| `packages/signer` | Signer interfaces: local, AWS KMS, Turnkey |
| `packages/chain-solana`, `packages/chain-evm` | The cross-chain spokes |
| `packages/webhooks` | Partner event store and webhook verification |

## Status

Built and tested: the Stellar venue, the reference in `MEMO_HASH`, the planner, the saga engine, the ledger, read-only reconciliation, and the SEP anchor adapter against a stubbed anchor.

Not done yet: no anchor is signed, so no real local currency has moved on Stellar; SEP-6 collections are unimplemented; the `cctp.transfer` and `stellar.pathPayment` legs are declared in the route graph but not built; the MGUSD, PYUSD and USDT issuers are unset until each is verified against its own `stellar.toml`; there is no treasury console.

MIT licensed.
