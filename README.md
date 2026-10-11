# Corridor

**Never lose a cross-border payout.**

Corridor is the payment ledger and router that licensed payment companies run in their own environment, on their own keys. It runs stablecoin payouts across the providers a company already uses, exactly once, and keeps one set of books that matches the chain.

[Documentation](https://corridor.udokaam.dev) · [Live console](https://corridorapp.udokaam.dev/console/) · [Evidence](https://corridor.udokaam.dev/status/evidence) · [Website](https://corridorapp.udokaam.dev)

---

## Live on mainnet

On 11 October 2026, Corridor paid **₦3,891.48 into a Nigerian bank account 74 seconds after 2.90 USDC.e left a Tempo vault**. The payout went Tempo → Base → Solana through Across, then out through Paj, Corridor's naira payout partner. The Corridor Reference rode the Solana memo and came back in the bank narration, so the bank credit traces to the payment that caused it. Every leg is linked on the [evidence page](https://corridor.udokaam.dev/status/evidence#live-on-mainnet).

## The problem

A single EUR → NGN payout crosses a bank collection, a stablecoin provider, at least two chains, a bridge, a local payout partner and the beneficiary's bank. Each system has its own identifier, and none of them holds the whole record.

Payment companies that use more than one provider run this today with provider dashboards, in-house scripts and month-end spreadsheets. It breaks in predictable ways:

- A payout bridges but never reaches the partner, and nobody notices until the customer calls.
- A retry sends the same payout twice.
- Gas, bridge fees and rounding pile up as differences nobody can explain.
- An auditor asks which on-chain payment a bank credit belongs to, and there is no answer.

## What Corridor does

Corridor doesn't hold money, provide liquidity or carry licences. Payment providers such as Paj, Yellow Card and Bridge do that, and Corridor runs payouts across them.

| Capability | What it gives the operator |
|---|---|
| **Exactly-once payouts** | Each payout is a durable saga across Tempo, Across, Solana and the payout partner. Every external step is recorded before Corridor waits on it, so a retry never pays twice; failures before money leaves unwind in reverse, failures after it stop for a person. |
| **Books that match the chain** | A double-entry ledger books every movement, gas cost, bridge fee, account rent and rounding difference from the transaction that caused it, and checks every vault on-chain against the ledger. |
| **One reference end to end** | A 32-byte Corridor Reference rides the Tempo memo, the Solana memo, the payout partner's order and the bank narration. |
| **Customer-held keys** | Every vault signs through the customer's own signer. AWS KMS and Turnkey adapters are built. |
| **Read-only start** | Corridor watches the wallets a company already runs on Tempo, Solana and Base and matches them against its payout records. Exceptions queue and CSV export; no keys, nothing moves. |
| **Issuer-neutral stablecoins** | Payouts fund from pathUSD or USDC.e on Tempo. USDC, USDT, PYUSD and EURC are watched and reconciled on Solana and Base, each booked in its own asset. |
| **Global hub and spokes** | Tempo is the settlement hub; every region is a spoke. One partner integration opens a region to every other spoke: 32 currencies across Africa, Asia, the Americas and Europe. |
| **Private supplier payments** | An optional shielded lane on Zcash: one Ironwood transaction pays a batch of suppliers, approved by FROST 2-of-3, disclosed to auditors through a scoped viewing key. |

## How a payout moves

```
Customer balance on Tempo (pathUSD or USDC.e)
   │  ledger.reserve
   ▼
Tempo treasury ──Across──▶ Base relay ──Across──▶ Solana egress ──▶ Payout partner ──▶ Beneficiary's bank
   │ memo: reference                               │ memo: reference      │ order: reference      │ narration: reference
   ▼                                               ▼                      ▼                       ▼
Double-entry ledger ◀──────────── observers (chain logs · partner webhooks · bank narration) ────────────▶ Reconciliation
   │
   ▼
Treasury console: balances · payouts in flight · exceptions · vault checks · disclosures
```

Architecture in depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and the [documentation site](https://corridor.udokaam.dev).

## Try it

**In the browser (five minutes).** Open the [console replay](https://corridorapp.udokaam.dev/console/). The Live on mainnet panel is at the top, and every ↗ link opens the real transaction on the Tempo explorer, Basescan, Solscan or the Zcash explorer.

**Locally (ten minutes).** Requires Node 22+ and pnpm 9. No keys or accounts needed: test keys are generated on first run and funded from the Tempo testnet faucet.

```bash
pnpm install
pnpm typecheck && pnpm test   # 107 tests, embedded Postgres, no setup
pnpm console                  # treasury console at http://localhost:4400
```

In the console, **Payout €→₦** runs a payout saga on Tempo testnet, **Payout with partner failure** shows compensation with a real on-chain refund, and **Importer pays a supplier in China** runs a collection followed by a payout. The reconciliation panel shows every movement matched and every vault balanced.

**Read-only mode on real wallets.**

```bash
pnpm watch:report examples/watch/eu-payco-demo.json
```

Scans the sample customer's wallets on Tempo, Solana and Base and matches them against its payout records. Point it at any wallet set by writing a config in the same shape.

## Commands

| Command | What it does |
|---|---|
| `pnpm test` / `pnpm typecheck` | Test suite and type checks |
| `pnpm console` | Treasury console (owns the local ledger, so stop other flows first) |
| `pnpm tempo:smoke` | Memo transfer on Tempo testnet, observed and booked exactly once |
| `pnpm payout:demo` | EUR → NGN payout saga, including a forced partner failure that compensates on-chain |
| `pnpm importer:demo` | Naira collected into the hub, then a supplier paid in CNY, reconciled both ways |
| `pnpm watch:report <config>` | Read-only reconciliation of existing wallets against payout records |
| `pnpm zcash:batch` | Shielded batch on Zcash testnet with encrypted invoice memos and an auditor view |
| `pnpm zcash:frost` | The same batch from a FROST 2-of-3 vault: one signer refused, two co-sign |
| `pnpm mainnet:wallets` | Create or inspect the mainnet vaults and their balances |
| `pnpm mainnet:saga` | Mainnet payouts through the saga engine, with an on-chain vs ledger check of every vault |
| `pnpm console:snapshot` | Record the running console as the static replay published with the website |

The shielded lane needs [`zcash-devtool`](https://github.com/zcash/zcash-devtool) built locally (`ZCASH_DEVTOOL` points at the binary) and the Rust FROST signer in `services/zcash-frost`.

## Repository

```
corridor/
├── apps/
│   ├── console/         Treasury console and its API
│   ├── docs/            Documentation site (Mintlify)
│   └── site/            Website (Vite, React)
├── packages/
│   ├── core/            Venue and asset model, the Corridor Reference codec
│   ├── ledger/          Double-entry ledger on Postgres (PGlite locally)
│   ├── routing/         Route planner over (venue, asset); hub enforcement
│   ├── saga/            Durable settlement sagas: retries, compensation, fencing
│   ├── legs/            Executable legs: reserve, Across bridge, partner payout and collection, shielded batch
│   ├── signer/          Signer interface; local, AWS KMS and Turnkey adapters
│   ├── chain-tempo/     TIP-20 memo transfers, vault observer
│   ├── chain-solana/    Stablecoin registry, memo transfers, watcher
│   ├── chain-evm/       Base stablecoins and watcher
│   ├── chain-zcash/     Ironwood batches (ZIP-321), viewing-key observer
│   ├── bridge-across/   Across Swap API: quotes, deposits, fill tracking
│   ├── partners/        Payout partner interface, Paj adapter, registry
│   ├── webhooks/        Verified partner webhooks into reconciliation
│   ├── recon/           Matching, vault accounting, read-only reconciliation
│   └── swap-near/       NEAR Intents quotes for the shielded lane
├── services/
│   └── zcash-frost/     FROST 2-of-3 signer for Ironwood vaults (Rust)
├── scripts/             Flows, mainnet runners and tooling
├── examples/            Read-only configs and the public mainnet payout record
└── docs/
    └── ARCHITECTURE.md
```

## Security and compliance

- Corridor serves licensed payment companies, which own the KYC and KYB of their end customers and the licences for each corridor.
- Corridor runs in the customer's environment and signs only through the customer's signer. It is software, not a custodian or a money transmitter.
- Fiat touchpoints go through regulated payout partners in each corridor.
- Secrets stay in `.env.local` and `.keys/`, both gitignored. The console replay refuses to publish if any secret value appears in its data.

## License

[MIT](LICENSE)
