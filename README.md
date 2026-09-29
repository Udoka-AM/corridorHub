# Corridor

**Stablecoin settlement and treasury infrastructure for payment companies moving money into emerging markets.**

Corridor lets a licensed payment company collect USD or EUR abroad and pay out NGN or KES without pre-funding foreign bank accounts or waiting days on correspondent banks. It holds working balances in stablecoins, quotes and executes FX, settles on [Tempo](https://tempo.xyz), and routes on/off-ramp liquidity through Solana. On top of that runs a treasury console that shows balances per corridor, forecasts pre-funding needs and reconciles every payment automatically.

> Corridor is infrastructure for licensed players. It is not a money transmitter. Our customers hold the licenses and the end-customer relationships; Corridor moves and reconciles their treasury.

---

## The problem

A remittance operator or payout company serving Europe → Nigeria today:

1. **Locks up capital.** It pre-funds NGN and KES accounts at local banks days ahead of demand, so millions sit idle in nostro accounts.
2. **Waits on correspondent banks.** Top-ups take T+1 to T+3, go through several intermediary banks, and settlement times are hard to predict.
3. **Pays the most expensive rails on earth.** Sending $200 to Sub-Saharan Africa averaged close to **9%** in Q1 2025, against a 6.49% global average and a 3% SDG target (World Bank, Remittance Prices Worldwide).
4. **Reconciles by hand.** Ops teams match bank statements to payout batches in spreadsheets, with no shared reference between the collection leg and the payout leg.

## What Corridor does

| Capability | What it means for the operator |
|---|---|
| **Stablecoin working balances** | USDC and USD-denominated TIP-20 balances replace idle fiat pre-funding in every corridor |
| **FX quote and execute** | Firm quotes (USD/EUR → NGN/KES) with TTL, executed against a pool of liquidity partners |
| **Settlement on Tempo** | Sub-second deterministic finality, gas paid in USD stablecoins, and a 32-byte memo on every transfer that maps it to an invoice or payout batch |
| **Liquidity and routing on Solana** | Access to the deepest stablecoin on/off-ramp liquidity for African corridors, with smart routing across ramp partners |
| **Treasury console** | Balances per corridor, pre-funding forecasts, low-balance alerts and a sweep/rebalance planner |
| **Auto-reconciliation** | A double-entry ledger ties every collection, FX leg, on-chain transfer and fiat payout to one journal entry |
| **Shielded B2B lane** *(optional module)* | Private supplier settlement through Zcash's shielded pool, with viewing keys for auditors. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#9-optional-module-shielded-b2b-settlement-lane) |

## How a payment flows

```
Sender (EUR, SEPA)                                     Recipient (NGN, bank / mobile money)
      │                                                               ▲
      ▼                                                               │
 Customer PSP ──API──▶ Corridor Quote ──▶ Settlement Saga ──────────▶ Off-ramp partner (Solana)
                           │                   │  ▲                           │
                           │                   ▼  │                           │
                           │            Tempo transfer (TIP-20, memo=payout_id)
                           │                   │                              │
                           ▼                   ▼                              ▼
                    Double-entry ledger ◀── Reconciliation engine ◀── Partner webhooks / bank statements
                           │
                           ▼
                    Treasury console (balances · pre-funding · recon status)
```

## Business model

| Stream | Indicative pricing |
|---|---|
| Settlement fee | 10–30 bps on settled volume (tested per corridor) |
| FX spread share | Revenue share with liquidity partners on executed FX |
| Treasury & reconciliation SaaS | Monthly platform fee per customer, tiered by corridors and volume |
| Float yield | Share of yield on idle stablecoin float held in approved yield venues |

## Who it's for

Licensed payment service providers, remittance operators, payout companies and cross-border B2B platforms, in both directions: diaspora and B2B payouts **into** Africa (EU/UK/US → NGN, KES, GHS), and import payments **out of** Africa to suppliers in China, Hong Kong, India, the UAE and the Americas. Tempo is the settlement hub and every region is a spoke (see [ARCHITECTURE §2.1](docs/ARCHITECTURE.md#21-a-global-network-hub-and-spokes)). Nigeria and Kenya come first.

## Tech stack (planned)

- **Core API and saga orchestrator:** TypeScript (Node 22), Fastify, PostgreSQL, a Temporal-style durable workflow engine
- **Ledger:** Postgres double-entry ledger (immutable journal, balance projections)
- **Tempo:** viem + Tempo SDK, TIP-20 transfers with memos, Fee AMM for stablecoin gas
- **Solana:** @solana/kit, SPL Token / Token-2022, ramp-partner APIs
- **Console:** Next.js, Tailwind, server actions
- **Infra:** Docker Compose for local, Fly.io/Render for demo

## Repository layout (target)

```
corridor/
├── apps/
│   ├── api/            # REST API: quotes, payouts, webhooks
│   └── console/        # Treasury dashboard (Next.js)
├── packages/
│   ├── ledger/         # Double-entry ledger + projections
│   ├── saga/           # Settlement saga (durable workflow + compensations)
│   ├── fx/             # Quote engine, liquidity-partner adapters
│   ├── chain-tempo/    # TIP-20 transfers, memo encoding, finality watcher
│   ├── chain-solana/   # Ramp routing, SPL transfers
│   └── recon/          # Matching engine
├── docs/
│   └── ARCHITECTURE.md
└── README.md
```

## Status

🚧 **In active build** for the [Colosseum Crypto World's Fair](https://colosseum.com/worldsfair) (submissions close 12 Oct 2026), in the Tempo, Solana and Zcash tracks. The architecture, decisions and day-by-day build log are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

| Package | What it does |
|---|---|
| `@corridor/core` | Venue/asset model (privacy is the `zcash_ironwood` venue) and the 32-byte Corridor Reference, with Tempo, Solana and Zcash encodings |
| `@corridor/ledger` | Append-only double-entry ledger on Postgres (PGlite locally) |
| `@corridor/routing` | Route graph over (venue, asset); public and shielded payouts use the same planner |
| `@corridor/saga` | Durable settlement saga: retries, reverse-order compensation, idempotent booking, leases |
| `@corridor/chain-tempo` | TIP-20 `transferWithMemo`, pathUSD gas, memo-topic lookups, vault observer |
| `@corridor/legs` | Executable legs (reserve, bridge, partner) |
| `@corridor/recon` | Matches chain observations against the ledger |

## Getting started

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm test               # unit tests (embedded Postgres, no setup)
pnpm tempo:smoke        # live: memo-tagged transfer on Tempo Moderato, booked once
pnpm payout:demo        # live: payout saga + forced failure + compensation + reconciliation
pnpm mainnet:wallets    # create/inspect mainnet demo wallets (keys stay in .env.local / .keys/)
```

Testnet keys are generated into `.env.local` on first run, and the faucet funds them. Nothing secret is committed.

## Compliance posture

- Corridor serves **licensed** PSPs and MTOs, which own KYC/KYB of their end customers.
- Corridor runs KYB on its customers and screens counterparties and wallets (sanctions/Travel Rule data passed through the memo and off-chain payload).
- Fiat touchpoints go through regulated ramp partners in each corridor.

## License

[MIT](LICENSE)
