# Corridor

**The payment ledger and router licensed payment companies run themselves, with their own keys, for cross-border stablecoin payouts. Starting with Africa's trade corridors.**

A single EUR → NGN payout crosses a bank collection, stablecoin providers, several chains, a bridge, a local payout partner and the beneficiary's bank, each with its own ids. Corridor follows every payout through all of it and matches it from funding to bank credit. When it moves the money, it settles on [Tempo](https://tempo.xyz) with a 32-byte reference in every memo and pays out through partners on Solana (Paj today), signing with the customer's own KMS or MPC keys. Customers start **read-only**: Corridor watches the wallets they already run and matches their own payout records, with no keys and nothing moving. USDC, USDT, PYUSD and EURC are all first-class.

**Documentation:** [corridorapp.mintlify.app](https://corridorapp.mintlify.app) (source in [`apps/docs`](apps/docs), Mintlify): architecture, every chain and partner integration, end-to-end flows with testnet evidence, and decision records.

**Live demo:** [corridorapp.udokaam.dev/console](https://corridorapp.udokaam.dev/console/): a replay of the treasury console recorded from live runs on Tempo Moderato, Solana devnet and Zcash testnet. Every ↗ link opens the real transaction.

> Corridor is software for licensed players, not a custodian or a money transmitter. It runs in the customer's environment and signs with the customer's keys. Customers keep their licences, their funds and their end-customer relationships.

**Try the read-only pilot:** `pnpm watch:report examples/watch/eu-payco-demo.json` watches the demo's real testnet wallets on Tempo, Solana and Base and matches them against sample payout records.

---

## The problem

A remittance operator or payout company serving Europe → Nigeria today:

1. **Locks up capital.** It pre-funds NGN and KES accounts at local banks days ahead of demand, so millions sit idle in nostro accounts.
2. **Waits on correspondent banks.** Top-ups take T+1 to T+3, go through several intermediary banks, and settlement times are hard to predict.
3. **Pays some of the most expensive rails in the world** for sending money into Sub-Saharan Africa.
4. **Reconciles by hand, across providers.** A payout crosses several providers and chains with no shared reference; ops teams match them in spreadsheets, and a stuck or short-paid payout is usually found when the customer complains.

## What Corridor does

| Capability | What it means for the operator |
|---|---|
| **Read-only reconciliation** | Watch existing wallets on Tempo, Solana and Base; match the company's own payout records; exceptions queue and CSV. No keys needed |
| **Customer-held keys** | One signer interface for Tempo, Base and Solana; AWS KMS adapter built. Corridor never holds funds or keys |
| **Issuer-neutral stablecoins** | USDC, USDT, PYUSD (Token-2022) and EURC alongside pathUSD, each booked in its own asset |
| **Stablecoin working balances** | One balance in the customer's own Tempo vault replaces idle fiat pre-funding in every corridor |
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
| Ledger and reconciliation subscription | Monthly per customer, from the read-only pilot onwards |
| Routing fee | 0.10–0.30% on volume Corridor moves on the customer's signer |
| FX spread share | Revenue share with liquidity partners on executed FX |

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
| `@corridor/chain-zcash` | Ironwood shielded batches (ZIP-321, one tx / N recipients), ZIP-32 period accounts, viewing-key observer |
| `services/zcash-frost` | Rust `corridor-frost`: FROST 2-of-3 (RedPallas, rerandomized) keygen and PCZT signing for Ironwood vaults |
| `apps/console` | Treasury console: network map, live flows, settlement timeline, forecast, venue balances, cross-chain reconciliation, shielded lane, auditor disclosure |
| `@corridor/bridge-across` | Across Swap API: quotes, approvals + deposit, fill tracking (testnet and mainnet) |
| `@corridor/legs` | Executable legs: reserve, bridge (both directions), partner payout (exactly-once funding), partner collection, ledger credit |
| `@corridor/partners` | Ramp partner interface, Paj adapter (OpenAPI v2), Paj-shaped mock, partner registry, webhook signatures |
| `@corridor/webhooks` | `POST /webhooks/:partner`: verified, stored once, turned into reconciliation observations |
| `@corridor/chain-solana` | USDC transfers with the Corridor Reference as SPL memo; memo observer |
| `@corridor/recon` | Matches chain observations against the ledger |

## Getting started

Requires Node 22+ and pnpm 9.

```bash
pnpm install
pnpm test               # unit tests (embedded Postgres, no setup)
pnpm tempo:smoke        # live: memo-tagged transfer on Tempo Moderato, booked once
pnpm payout:demo        # live: EUR→NGN payout (partner order, signed webhooks) + forced failure + compensation + recon
pnpm importer:demo      # live: importer pays ₦ → hub balance credited → supplier paid in CNY, reconciled both ways
pnpm mainnet:wallets    # create/inspect mainnet demo wallets (keys stay in .env.local / .keys/)
pnpm across:testnet     # live Across testnet hop: Base Sepolia USDC → Solana devnet USDC
pnpm zcash:spike        # shielded lane: one Ironwood tx pays a batch; auditor reconciles via viewing key
pnpm zcash:frost        # same batch from a FROST 2-of-3 vault: one signer refused, two co-sign
pnpm console            # treasury console at http://localhost:4400 (owns the local ledger; stop CLI demos first)
pnpm console:snapshot   # record the running console as the static replay in apps/site/public/console/
pnpm --filter @corridor/site dev   # landing page (Vite + React, three.js hub scene, GSAP)
```

The shielded lane uses [`zcash-devtool`](https://github.com/zcash/zcash-devtool) (librustzcash, Ironwood-aware). Build it with `cargo build --release` and point `ZCASH_DEVTOOL` at the binary.

Testnet keys are generated into `.env.local` on first run, and the faucet funds them. Nothing secret is committed.

## Compliance posture

- Corridor serves **licensed** PSPs and MTOs, which own KYC/KYB of their end customers.
- Corridor runs KYB on its customers and screens counterparties and wallets (sanctions/Travel Rule data passed through the memo and off-chain payload).
- Fiat touchpoints go through regulated ramp partners in each corridor.

## License

[MIT](LICENSE)
