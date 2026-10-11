# Corridor architecture

This document describes how Corridor is built: the design principles, the network topology, the data model, each component, and how they behave in production and on testnets. The product documentation at [corridor.udokaam.dev](https://corridor.udokaam.dev) covers the same system page by page, with flows, integrations, decision records and evidence.

## 1. Overview

Corridor is the payment ledger and router that licensed payment companies run in their own environment, on their own keys, for cross-border stablecoin payouts. It does not hold funds, provide liquidity or carry licences. Those come from the payment providers a company already uses. Corridor runs payouts across those providers exactly once and keeps one set of books that matches the chain.

A single EUR → NGN payout crosses a bank collection, a stablecoin provider, at least two chains, a bridge, a local payout partner and the beneficiary's bank, each with its own identifiers. Corridor carries one 32-byte reference through every step, books every movement from the transaction that caused it, and checks every vault on-chain against the ledger.

Customers adopt it in two stages:

1. **Read-only.** Corridor watches the wallets the company already runs on Tempo, Solana and Base, matches them against the company's own payout records, and raises an exceptions queue. No keys are shared and nothing moves.
2. **Routing.** Corridor runs payouts over Tempo and out through payout partners on Solana, signing through the company's own KMS or MPC signer.

## 2. Design principles

| Principle | What it means in the code |
|---|---|
| **Customer-held keys** | Every vault signs through `@corridor/signer`. Adapters exist for local keys (development), AWS KMS and Turnkey. Corridor never holds a key or a balance. |
| **Book from the chain** | Every ledger entry for an on-chain movement is keyed by its transaction. Gas, bridge fees, account rent and rounding are booked from receipts and balance changes, not estimated. |
| **One reference end to end** | A 32-byte Corridor Reference rides each chain's native reference field: the Tempo TIP-20 memo, the Solana memo, the Zcash encrypted memo, and the payout partner's description field. |
| **The hub is enforced** | Payouts are funded from a balance on Tempo, and collections land on Tempo. The route planner rejects any other shape, so every flow is settled, held and reconciled in one place. |
| **Exactly once across systems** | Every leg records its external side effect (a deposit, a partner order, a funding transfer) before it waits on it. A retry resumes the recorded work; a gap it cannot resolve stops the payout for a person. |
| **Privacy is a venue** | The shielded lane is a venue (`zcash_ironwood`) in the same route graph, saga engine, ledger and reconciliation, not a separate subsystem. |
| **Issuer-neutral** | USDC, USDT, PYUSD, EURC, USDC.e and pathUSD are each booked in their own asset. |

The privacy principle in detail:

| Concept | Public lane | Shielded lane | Shared |
|---|---|---|---|
| Venue (where value sits) | `tempo`, `base`, `solana`, `partner_fiat` | `zcash_ironwood` | One `Venue` enum |
| Route (how value moves) | Legs through the route graph | Legs through the same graph | One planner |
| Saga | Forward and compensation per leg | Forward and compensation per leg | One engine |
| Ledger | Accounts keyed `(owner, corridor, asset, venue)` | Same, `venue = zcash_ironwood` | One journal |
| Reference | Corridor Reference in the Tempo and Solana memos | Same reference in the Zcash encrypted memo | One codec |
| Reconciliation | Ledger ↔ chain logs ↔ partner webhooks | Ledger ↔ viewing-key scan | One matcher, different observers |
| Disclosure | Public by nature | Viewing key per `(customer, period)` | Built in |

`privacy: "shielded"` is a constraint on the path: the final leg must end in the shielded venue.

## 3. Network topology: hub and spokes

Tempo is the settlement hub and every region is a spoke. Every flow is one of two shapes:

- **Collection:** local currency comes in through a payout partner, is converted to USDC, bridged to Tempo, and credited to the customer's balance on the hub.
- **Payout:** the customer's balance on Tempo goes out to a spoke, either public (a partner pays local currency) or shielded (Ironwood).

A cross-border flow is a collection followed by a payout:

```
          collections                         payouts
 NGN ─┐                                              ┌─▶ NGN / KES / GHS / ZAR …   (payouts into Africa)
 KES ─┤                                              ├─▶ CNY / HKD / INR / AED … (import payments to Asia)
 GHS ─┼─▶ USDC (Solana) ─▶ TEMPO HUB ──────────────▶ ┼─▶ USD / BRL / MXN / COP … (payments to the Americas)
 USD ─┤         customer balances · ledger · recon   ├─▶ EUR / GBP …             (payments to Europe)
 EUR ─┘                                              └─▶ Zcash Ironwood          (shielded supplier batches)
```

Why this shape:

- **N integrations, not N×N corridors.** Adding a region means adding one payout partner, and every existing spoke can reach it.
- **One place to settle and reconcile.** Hub enforcement is tested in `packages/routing/src/routing.test.ts`.
- **Currency pairs in the reference.** The Corridor Reference encodes the funding and beneficiary currencies (§7), so a new corridor such as `GHS-HKD` needs no registry change.
- **Privacy where trade needs it.** Importers don't want competitors reading supplier prices and volumes on a public chain.

Priority flows:

| Flow | Direction | Example | Payout rail |
|---|---|---|---|
| Diaspora and B2B payouts into Africa | Inbound | EUR / GBP / USD → NGN, KES, GHS | Local bank, mobile money |
| Import payments to China and Hong Kong | Outbound | NGN / KES / GHS → CNY, HKD, USD | Supplier's HK or offshore USD/HKD account (most China trade settles in USD, HKD or USDT) |
| Import payments to India, the UAE, Turkey, South-East Asia | Outbound | NGN → INR, AED, TRY, IDR | Local payout partners |
| Payments to the Americas | Outbound | NGN / KES → USD, BRL, MXN | ACH and wire, Pix, SPEI |
| Intra-African trade | Both | NGN ↔ KES, GHS, XOF | Local ramps |

**Payout partners.** Paj (Solana → NGN) is integrated and live on mainnet. Every partner implements the same `RampPartner` interface (§8.6), so regional providers plug in without changes to the legs, the ledger or reconciliation.

**Outbound regulation.** Outbound FX from markets like Nigeria is regulated; import payments, for example, need a Form M and an FX-licensed institution. The licensed customer holds the FX permissions and the KYC. Corridor carries the compliance references (invoice number, Form M number) in the saga data and the off-chain payload, and its reconciliation trail is audit evidence.

## 4. Settlement asset on Tempo

Every stablecoin on Tempo is a TIP-20, including USDC.e (Stargate-bridged USDC, `0x20C0…b9537d11c60E8b50`). Corridor books each in its own asset and settles in two of them:

- **pathUSD** is the hub's unit of account and its gas token. Bridge (a Stripe company) issues it as Tempo's neutral quote token, every USD TIP-20 routes through it on the enshrined stablecoin DEX, and validators accept it as a fee token, so vaults pay gas in an asset they already hold.
- **USDC.e** is a first-class funding asset. Across accepts it on Tempo directly, so a USDC.e balance pays out without a DEX swap.

Payout partners never see the Tempo-side asset. They are paid in USDC on Solana:

```
Funding (pathUSD or USDC.e)      Hub (Tempo)                     Egress
customer deposit ─────────────▶ treasury vault + ledger ──Across──▶ Base USDC ──Across──▶ Solana USDC ──▶ payout partner
```

pathUSD circulating supply is still small. The ledger is multi-asset per venue and the route planner picks the path from the funded asset, so moving a corridor's volume between pathUSD and USDC.e is a configuration choice, not a migration.

## 5. System architecture

```
                 ┌──────────────────────────────────────────────────────────────────┐
Customer ──API──▶│  API (payouts · batches · disclosures · read-only watch)          │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Route planner ── route graph (venues × assets × legs)            │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Settlement saga engine (durable, per-leg compensation, fencing)  │
                 │     │            │              │              │                  │
                 │  ┌──▼───┐   ┌────▼────┐   ┌─────▼─────┐   ┌────▼──────┐           │
                 │  │Tempo │   │ Across  │   │ Solana +  │   │ Zcash     │           │
                 │  │legs  │   │ bridge  │   │ partner   │   │ shielded  │           │
                 │  │memo, │   │ Tempo→  │   │ legs:     │   │ legs:     │           │
                 │  │DEX,  │   │ Base→   │   │ SPL memo, │   │ NEAR swap,│           │
                 │  │FeeAMM│   │ Solana  │   │ payouts   │   │ Ironwood, │           │
                 │  └──┬───┘   └────┬────┘   └─────┬─────┘   │ FROST     │           │
                 │     │            │              │         └────┬──────┘           │
                 │     ▼            ▼              ▼              ▼                  │
                 │  Signer interface (customer KMS · Turnkey · MPC)                  │
                 │     │                                                             │
                 │  Observers (log watchers · webhooks · viewing-key scanner)        │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Double-entry ledger (Postgres) ◀──▶ Reconciliation engine        │
                 └─────┼─────────────────────────────────────────────────────────────┘
                       ▼
                 Treasury console: corridors · venues · forecast · recon · exceptions · disclosures
```

Everything inside the box runs in the customer's environment.

## 6. Core model

```ts
type Venue = "tempo" | "base" | "solana" | "partner_fiat" | "zcash_ironwood";
type Asset = "pathUSD" | "USDC.e" | "USDC" | "USDT" | "PYUSD" | "EURC" | "ETH" | "SOL" | "ZEC" | Fiat;

interface Edge {                    // one executable leg in the route graph
  kind: "ledger.reserve" | "ledger.credit" | "tempo.dexSwap" | "across.bridge" | "bridge.simulated"
      | "partner.collect" | "partner.payout" | "near.swap" | "zcash.shieldedBatch";
  from: { venue: Venue; asset: Asset };
  to:   { venue: Venue; asset: Asset };
  env?: ("testnet" | "mainnet")[];
}

interface PayoutData {
  corridor: `${Fiat}-${Fiat}`;      // e.g. "EUR-NGN"
  asset: "pathUSD" | "USDC.e";      // the hub balance the payout is funded from
  amount: string;                   // integer base units
  reference: Hex;                   // §7
  recipient: BankRecipient | ShieldedRecipient;
}
```

Route examples, as the planner produces them:

- Public EUR → NGN, mainnet: `ledger.reserve → across.bridge (Tempo → Base) → across.bridge (Base → Solana) → partner.payout`
- Public EUR → NGN, testnet: `ledger.reserve → bridge.simulated (Tempo → Solana) → partner.payout`
- Shielded supplier batch, mainnet: `ledger.reserve → across.bridge (Tempo → Base) → near.swap (Base USDC → ZEC) → zcash.shieldedBatch`

## 7. Corridor Reference

One 32-byte reference, carried in each chain's native reference field:

```
byte 0      version (0x02)
byte 1      kind   (payout · batch · batch item · sweep · deposit · collection)
byte 2      funding currency (Corridor currency index: 32 currencies across 4 regions, room for 255)
byte 3      beneficiary currency
byte 4      flags  (bit 0: shielded)
bytes 5–20  payout or batch id (UUIDv7)
bytes 21–27 customer tag (7-byte keyed hash, so a public memo never identifies the customer)
bytes 28–31 checksum (first 4 bytes of sha256 over bytes 0–27)
```

| Venue | Where it lives | Why it fits |
|---|---|---|
| Tempo | TIP-20 `transferWithMemo(to, amount, bytes32 memo)`; `memo` is an indexed topic of `TransferWithMemo` | Reconciliation filters logs by reference directly, with no indexer |
| Solana | SPL Memo instruction in the same transaction | The native pattern payout partners already read |
| Zcash | Encrypted memo on each Ironwood output (reference and invoice) | Only the recipient and viewing-key holders can read it |
| Payout partner | Order description, echoed on webhooks and into the bank narration | A bank statement line traces back to the payout that caused it |

## 8. Components

### 8.1 Ledger (`packages/ledger`)

- Accounts keyed `(owner_type, owner_id, corridor, asset, venue, type)`. Types: asset, liability, revenue, expense, clearing, equity.
- Immutable journal. Every entry balances per asset; conversions between assets go through `clearing` accounts (the USD peg, USD → ZEC).
- Invariants enforced at write time and tested: entries balance, no-overdraft accounts never go negative, and each external movement is booked exactly once (unique `(venue, external_ref)`).
- Runs on Postgres; PGlite locally, so development needs no database.

### 8.2 Saga engine (`packages/saga`)

- Postgres-backed sagas, steps and events. Every leg implements `forward()` and optionally `compensate()`.
- Idempotency key per `(saga, step)`. Retries with backoff per leg kind.
- Failure before money leaves: completed steps compensate in reverse order. Failure after money leaves (a funded partner order, a bridged deposit): the saga stops at `manual_review` until a person confirms the refund.
- Leases with fencing tokens: every commit checks the token, so a worker whose lease lapsed mid-leg can never book or mark a step done.

### 8.3 Signers (`packages/signer`)

- One interface for secp256k1 (Tempo, Base) and Ed25519 (Solana) signing.
- Adapters: local keys (development), AWS KMS (DER parsing, low-s normalisation, recovery id), Turnkey (raw-payload signing with API-key stamps, policy approvals respected).
- Selected at runtime with `CORRIDOR_SIGNER=aws-kms|turnkey`; the same flows run unchanged.

### 8.4 Tempo (`packages/chain-tempo`)

- viem with the built-in `viem/tempo` chains and actions. Mainnet is chain 4217; the Moderato testnet is 42431.
- `transferWithMemo` for every movement; vaults pay gas in pathUSD through the Fee AMM.
- `TempoObserver` watches vault addresses for memo transfers, plain deposits and fee transfers to the fee manager, resuming from a stored block cursor and backing off on RPC rate limits.

### 8.5 Across bridge (`packages/bridge-across`, `packages/legs`)

- Swap API `GET /swap/approval` returns a firm quote with the approval and deposit transactions; the deposit-status API tracks the relayer's fill.
- Across has no direct Tempo ↔ Solana route, so a payout to a Solana partner takes two hops through Base.
- The `across.bridge` leg takes pathUSD or USDC.e on Tempo and records each deposit before waiting on its fill, so a retry never resends; a crash between signing and recording stops the saga for a person. It books the amount that actually arrived (read from the destination chain), the fee as `expense:bridge-fee`, and origin gas from the receipts (pathUSD on Tempo, ETH including Base's L1 data fee).
- Measured on mainnet, 11 Oct 2026: Tempo → Base filled in about 1 s for a 0.0035 USDC fee; Base → Solana filled in seconds for 0.0001 USDC.
- Across has no Tempo testnet, so testnet routes use `bridge.simulated`: the Tempo side is real (value moves to an escrow with the reference as memo) and the far side is simulated, with the same bookings.

### 8.6 Solana, payout partners and webhooks (`packages/chain-solana`, `packages/partners`, `packages/webhooks`)

- **Solana leg:** one `@solana/kit` transaction creates the recipient's token account if missing, sends `TransferChecked`, and adds an SPL memo `corridor:<ref>`. The watcher reads token deltas, native SOL fees and account rent per transaction.
- **Partner interface (`RampPartner`):** `rates`, `openPayout`, `openCollection`, `getOrder`, `verifyWebhook`, `parseWebhook`. Every provider is normalised to `open → processing → completed | failed`, and a `PartnerRegistry` picks the partner per currency, direction and chain.
- **Paj:** built against Paj's business API v2. Payout orders return a one-off funding address on Solana; collection orders return a one-off virtual bank account. The Corridor Reference rides in the order description and comes back on webhooks and in the bank narration. Paj settles on Solana for Corridor, so the adapter refuses Base orders.
- **Payout leg:** pays out what actually reached the egress vault, funds exactly what the partner's order asks for (Paj rounds to cents), and books the payout so both sides of the USD peg close: bridge fees are recovered from the customer, and rounding dust is held for them. Funding is exactly once across retries (`partner_order_links`), and a partner failure after funding stops at `manual_review`.
- **Webhooks:** `POST /webhooks/:partner`, verified with HMAC-SHA256 over `{timestamp}.{raw body}` (5-minute window, constant-time compare). Each order status is stored once; redeliveries are acknowledged and forgeries rejected. A completed order becomes a reconciliation observation.
- **Collections:** `partner.collect` (virtual account → USDC delivered to the ingress vault) → bridge into the hub → `ledger.credit`.

### 8.7 Shielded lane (`packages/chain-zcash`, `services/zcash-frost`)

- **Wallet tooling:** [`zcash-devtool`](https://github.com/zcash/zcash-devtool) (librustzcash, Ironwood-aware). New notes land in the Ironwood pool.
- **Vaults:** each `(customer, period)` gets its own shielded vault. Its viewing key discloses that customer's period and nothing else.
- **Batch payout:** a ZIP-321 payment request becomes one shielded transaction with N outputs, each with an encrypted memo (`INV-… / corridor:<ref>`) readable in the recipient's wallet.
- **Threshold control (FROST 2-of-3):** the vault's spend-authorizing key `ak` is a FROST group key (RedPallas). No one holds the whole spending key; any 2 of {customer approver, customer finance, Corridor} can authorize.
  1. `corridor-frost keygen` produces three shares and derives the full viewing key, unified viewing key and vault address.
  2. `zcash-devtool` imports the viewing key (view-only) and builds the batch as an unsigned PCZT, then proves it.
  3. `corridor-frost sign` checks `rk == ak + [alpha]G` for each action, runs both FROST rounds rerandomized by `alpha`, verifies the aggregate signature against `rk`, and applies it. A signer set below the threshold is refused.
  4. `zcash-devtool` combines proofs and signatures and broadcasts.
- **Funding:** `near.swap` prices with a live NEAR Intents 1Click quote (USDC → ZEC, delivered to the vault's unified address). On mainnet it swaps from Base USDC, since NEAR Intents has no Tempo market.
- **Approval:** `zcash.shieldedBatch` opens an approval request and waits until the vault's threshold of signers approve, then co-signs with exactly those signers and books one entry per recipient plus the network fee.
- **Production hardening:** distributed key generation in place of the trusted dealer, and each signer on its own device relaying through `frostd`. The PCZT interface and the cryptography are unchanged.

### 8.8 Reconciliation and read-only mode (`packages/recon`)

- Observers emit `Observation { venue, externalRef, reference, amount, asset, at }`. The matcher joins them with ledger entries on the reference and reports `matched`, `amount_mismatch`, `unbooked` or `unreferenced`, the same way for every venue.
- Vault accounting books gas, account rent and owner top-ups from the chain, then compares each vault's on-chain balance with the ledger.
- Read-only mode runs the same observers on wallets the customer already operates (Tempo, Solana, Base) and matches them against the customer's own payout records: `matched`, `short`, `over`, `pending`, `missing`, `unexpected`, with an exceptions queue and a CSV export.

### 8.9 Treasury console (`apps/console`)

Hub balances, payouts in flight, saga timelines with explorer links per step, the corridor board, a seven-day pre-funding forecast, venue balances with clearing accounts, cross-chain reconciliation and vault checks, the read-only exceptions queue, the shielded lane with FROST approvals, auditor disclosure exports, and live mainnet payouts. A public replay of recorded runs is published at [corridorapp.udokaam.dev/console](https://corridorapp.udokaam.dev/console/).

## 9. Environments

| Component | Mainnet | Testnet |
|---|---|---|
| Tempo | Live: payouts funded from pathUSD or USDC.e | Moderato (42431), faucet-funded |
| Across | Live: Tempo → Base → Solana | No Tempo deployment; `bridge.simulated` with the same interface |
| Solana | Live: egress vault funds payout partners | Devnet |
| Payout partner | Paj, live (NGN) | Paj-shaped mock with the same lifecycle and signed webhooks |
| Zcash | Ironwood (planned for production batches) | Testnet, Ironwood pool |
| NEAR Intents | Live quotes | Live mainnet quotes; delivery is testnet ZEC |

The first live payout, on 11 Oct 2026, moved 2.90 USDC.e from Tempo through Base and Solana to a Nigerian bank account in 74 seconds, with the Corridor Reference returned in the bank narration. `pnpm mainnet:saga` runs mainnet payouts through the saga engine on a dedicated ledger whose opening float is read from the chain, and checks every vault on-chain against the ledger after each run.

## 10. Security and compliance

- Corridor serves licensed payment companies, which own the KYC and KYB of their end customers and hold the licences for each corridor.
- Corridor runs in the customer's environment and signs only through the customer's signer. It is software, not a custodian or a money transmitter.
- Fiat touchpoints go through regulated payout partners in each corridor.
- Secrets live outside the repository; the public console replay refuses to publish if any value from the local secret stores appears in its data.
- Before any hosted deployment, the console's action and disclosure endpoints sit behind authentication.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Two-hop bridge latency or failure | Each hop is a saga leg that records its deposit before waiting; funds always sit in a customer-controlled address between hops, and post-deposit failures stop for a person |
| Partner rounding and fees | The payout leg funds exactly the partner's order and books fees and dust, so vaults still balance to the unit |
| pathUSD depth | Payouts fund from pathUSD or USDC.e; the planner routes from whichever the customer holds |
| ZEC price exposure on the shielded lane | Swap and send in one saga window, with a slippage guard and small batches |
| Tempo adoption | The hub is one edge in the route planner; the ledger, saga engine and reconciliation are chain-agnostic |
| Ironwood tooling maturity | FROST signing runs against public librustzcash APIs; production moves to DKG and per-device signers |

## 12. Further reading

- [Decision records](https://corridor.udokaam.dev/decisions): why pathUSD, why the hub is enforced by the planner, why references live in native memos, why sagas over two-phase commit, why customer-held keys, why read-only first.
- [Evidence](https://corridor.udokaam.dev/status/evidence): every transaction behind these claims, linked to its block explorer.
- [Roadmap](https://corridor.udokaam.dev/status/roadmap).
