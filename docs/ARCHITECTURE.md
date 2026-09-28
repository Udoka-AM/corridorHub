# Corridor: architecture, build strategy and integrations

| | |
|---|---|
| **Status** | Draft v0.1, for review before build starts |
| **Target** | Colosseum Crypto World's Fair, submissions close **12 Oct 2026** |
| **Tracks** | Tempo (primary) · Solana · Zcash (via optional shielded lane) · general pool |
| **Owner** | Udoka |

---

## 1. Product scope

### 1.1 In scope for the hackathon (MVP)

1. **One corridor end-to-end:** EUR → NGN. USD → KES is shown in the console with simulated data.
2. **Quote API:** firm FX quote with a TTL and a fee breakdown.
3. **Payout API:** create a payout against a quote, idempotent by `client_reference`.
4. **Settlement saga:** a durable workflow that moves value from the customer's stablecoin balance through a Tempo transfer (memo = payout ID) to a Solana-side off-ramp partner, then to a fiat payout, with a compensation for every step.
5. **Double-entry ledger:** every movement is a balanced journal entry, and balances are projections.
6. **Reconciliation engine:** matches on-chain events (Tempo memo), partner webhooks and simulated bank statements to ledger entries.
7. **Treasury console:** balances per corridor, pre-funding forecast, recon status and exceptions queue.

### 1.2 Out of scope (post-hackathon)

- Live fiat collection (SEPA/ACH). For the demo, collections are a signed webhook from a sandbox PSP.
- More than two corridors.
- Production custody (MPC/HSM). The demo uses a dev key in a KMS-style wrapper.
- Yield on float. It is modelled in the console and not executed.

### 1.3 What we are not

Corridor never faces the end sender or recipient and never takes custody of consumer funds on its own license. Customers are licensed PSPs and MTOs. This keeps licensing with them and keeps our regulatory surface at KYB, sanctions screening and ramp-partner diligence.

---

## 2. System architecture

```
                         ┌──────────────────────────────────────────────┐
                         │                Corridor Core                  │
  Customer PSP ──REST──▶ │  API gateway (auth, idempotency, rate limits) │
  (Zynta-type)  ◀─webhook│         │                                     │
                         │         ▼                                     │
                         │  ┌───────────┐   ┌──────────────┐             │
                         │  │ FX / Quote│──▶│ Settlement   │──┐          │
                         │  │ engine    │   │ saga (durable│  │          │
                         │  └─────┬─────┘   │ workflows)   │  │          │
                         │        │         └──────┬───────┘  │          │
                         │        ▼                ▼          ▼          │
                         │  ┌──────────────────────────────────────┐     │
                         │  │ Double-entry ledger (Postgres)       │     │
                         │  │ journal · accounts · projections     │     │
                         │  └──────────────────────────────────────┘     │
                         │        ▲                ▲                     │
                         │  ┌─────┴──────┐   ┌─────┴───────┐             │
                         │  │ Recon      │◀──│ Event ingest│◀── chain    │
                         │  │ engine     │   │ (indexers,  │    watchers │
                         │  └────────────┘   │ webhooks)   │             │
                         │                   └─────────────┘             │
                         └───────┬──────────────────┬───────────────────┘
                                 │                  │
               ┌─────────────────▼───┐        ┌─────▼─────────────────────┐
               │ Tempo                │        │ Solana                     │
               │ TIP-20 USD balances  │ bridge │ USDC liquidity, ramp       │
               │ memo = payout_id     │◀──────▶│ partner wallets, routing   │
               │ gas in stablecoins   │        │                            │
               └──────────────────────┘        └─────────────┬──────────────┘
                                                             │
                                                   ┌─────────▼─────────┐
                                                   │ Off-ramp partners │
                                                   │ NGN / KES payout  │
                                                   └───────────────────┘

        Treasury console (Next.js) ── reads projections, recon state, forecasts
```

### 2.1 Why each chain does what it does

| Chain | Role | Why |
|---|---|---|
| **Tempo** | System of record for settlement between Corridor accounts, customers and partners | Payments-first L1 from Stripe and Paradigm (mainnet 18 Mar 2026). About 0.6 s deterministic finality, gas paid in USD stablecoins through the Fee AMM, dedicated payment lanes, and TIP-20 transfers that carry a 32-byte memo, which is how we tie a payment to an invoice or payout ID. |
| **Solana** | Liquidity and routing for on/off-ramps | Most African stablecoin ramp liquidity (USDC/USDT) and partner integrations sit on Solana. It is cheap and fast enough to route between several ramp partners. |
| **Zcash** *(optional lane)* | Private B2B supplier settlement | Shielded amounts and counterparties, with viewing keys for selective disclosure to auditors. See §9. |

---

## 3. Core components

### 3.1 Double-entry ledger (`packages/ledger`)

This carries over directly from the Arc ledger.

- **Accounts** are typed: `asset`, `liability`, `revenue`, `expense`. Each is keyed by `(owner, corridor, currency, venue)`. Examples: `customer:zynta:USD:tempo`, `partner:yellowcard:NGN:fiat`, `corridor:fees:USD`.
- **Journal entries** are immutable, and debits equal credits per currency. FX legs are two linked entries joined through an `fx_clearing` account per currency pair.
- **Projections:** materialized balances per account, rebuilt from the journal in O(entries) for audits.
- **Invariants,** checked in tests and at runtime: sum of balances per currency = 0; no negative balance on `asset` accounts marked `no_overdraft`; every on-chain transfer has exactly one journal entry.

```sql
journal_entries(id, created_at, saga_id, kind, memo_hex, metadata jsonb)
postings(id, entry_id, account_id, currency, amount_minor bigint, direction) -- D/C
accounts(id, owner_type, owner_id, corridor, currency, venue, type, flags)
balances(account_id, currency, available, pending, updated_at)            -- projection
```

### 3.2 Settlement saga (`packages/saga`)

This carries over the Arc settlement saga. Every payout is a durable workflow, and each step has a forward action and a compensation.

| # | Step | Forward | Compensation |
|---|---|---|---|
| 1 | `LOCK_QUOTE` | Validate TTL and lock the rate | Release the lock |
| 2 | `RESERVE_FUNDS` | Move customer `available → pending` in the ledger | Release the reservation |
| 3 | `SETTLE_TEMPO` | TIP-20 transfer from customer vault to the routing vault, `memo = H(payout_id)` | Reverse transfer |
| 4 | `BRIDGE_TO_SOLANA` | Move USDC to the partner's Solana wallet (skipped if the partner accepts Tempo directly) | Return from partner |
| 5 | `PARTNER_PAYOUT` | Call the ramp partner's payout API (NGN bank/mobile money) | Partner refund flow |
| 6 | `CONFIRM` | Wait for partner webhook plus finality on both chains | None (terminal) |
| 7 | `BOOK` | Final journal entry: fees, FX clearing, revenue | None |

- Exactly-once semantics come from idempotency keys per step, stored in `saga_steps`.
- Each step has a timeout and retry policy. A step that exhausts retries goes to `manual_review` and appears in the console's exceptions queue.
- Hackathon engine: a lightweight Postgres-backed workflow runner (outbox + step table). Temporal/Restate is an option after the hackathon.

### 3.3 FX and quote engine (`packages/fx`)

- `POST /v1/quotes {source_ccy, target_ccy, source_amount | target_amount}` returns `{rate, fee_bps, spread_bps, ttl, quote_id}`.
- It aggregates indicative rates from liquidity-partner adapters, applies a configurable spread per corridor, and returns a firm quote backed by partner inventory.
- The margin decomposition is stored on the quote, which is how the FX-share revenue gets calculated.

### 3.4 Chain adapters

**`chain-tempo`**
- TIP-20 `transferWithMemo`. The memo is 32 bytes: `version(1) | corridor_id(1) | payout_id(16, UUIDv7) | checksum(4) | reserved(10)`.
- Gas: pay fees in USDC-equivalent TIP-20 through the Fee AMM, so there is no native gas token to manage.
- Finality watcher: subscribes to transfer logs, decodes memos and emits `chain.transfer.finalized` events.

**`chain-solana`**
- SPL / Token-2022 transfers to ramp-partner wallets.
- Router: chooses a partner by quoted rate, available liquidity, SLA and success rate.
- Watcher: Helius (or equivalent) webhooks, plus confirmation polling.

### 3.5 Reconciliation engine (`packages/recon`)

Three-way match per payout:

1. **Ledger** (expected)
2. **Chain** (Tempo memo → payout_id; Solana signature → saga step)
3. **Partner / bank** (webhook payload or statement line → payout_id or partner reference)

It produces a `matched`, `partial`, `unmatched` or `mismatch_amount` status. Exceptions go to a queue with a suggested action. Target for the demo: 100% auto-match on the happy path, with seeded exceptions shown being resolved.

### 3.6 Treasury console (`apps/console`)

- **Corridor board:** available, pending and in-flight per corridor and venue (Tempo, Solana, partner fiat).
- **Pre-funding forecast:** a rolling 7-day payout forecast (moving average plus day-of-week seasonality) against current partner balances. Output: "Top up NGN partner by X by Thursday."
- **Recon view:** match rate, exceptions queue, drill-down from payout to journal entry to on-chain transaction.
- **Float view:** idle stablecoin float and projected yield (modelled only in the MVP).

---

## 4. Public API (v1, draft)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/quotes` | Create a firm FX quote |
| `POST` | `/v1/payouts` | Create a payout against a quote (idempotent) |
| `GET` | `/v1/payouts/:id` | Payout status and saga timeline |
| `GET` | `/v1/balances` | Balances per corridor and venue |
| `POST` | `/v1/deposits/notify` | Collection notification (PSP → Corridor) |
| `GET` | `/v1/recon/exceptions` | Open reconciliation exceptions |
| — | Webhooks | `payout.settled`, `payout.failed`, `balance.low`, `recon.exception` |

Auth uses API key + HMAC-signed requests. Webhooks are signed the same way.

---

## 5. Integrations

| Area | Candidates | Hackathon plan | Notes |
|---|---|---|---|
| **Tempo** | Tempo SDK / viem, TIP-20, Fee AMM, testnet faucet | **Live on testnet** | Memo encoding is the showcase. Move to mainnet if time allows. |
| **Solana** | @solana/kit, SPL / Token-2022, Helius | **Live on devnet** | Routing vault and partner-wallet simulation |
| **Tempo ↔ Solana** | Across (supports Tempo), Circle CCTP (check Tempo support), LayerZero | **Simulated bridge** with the same interface; real bridge after the hackathon | Must be scoped honestly. Say "simulated" in the demo. |
| **Off-ramp / liquidity (NGN, KES)** | Yellow Card, Kotani Pay, Busha, Onafriq, Flutterwave, Fonbnk | **Sandbox API where available**, otherwise a mock adapter against the documented API | Target 1–2 LOIs from this list |
| **Customer PSPs (design partners)** | Zynta and similar EU→Africa payout companies | LOIs plus one sandbox integration | Traction criterion |
| **Compliance** | Chainalysis / TRM (wallet screening), Sumsub (KYB) | Mocked screening hook | Real after the hackathon |
| **Yield on float** | Tokenized T-bill venues, TIP-20 rewards | Modelled only | Requires customer opt-in and legal review |
| **Zcash (optional)** | Zallet/zcashd RPC, lightwalletd, NEAR Intents for ZEC swaps | See §9 | Stretch goal |

---

## 6. Security and risk

| Risk | Mitigation |
|---|---|
| Key compromise | Per-corridor vaults, KMS-wrapped keys, spend limits per vault. MPC after the hackathon. |
| Partner insolvency / non-payout | Cap exposure per partner, prefer partners that pay out on receipt, and keep compensation flows in the saga |
| FX move during settlement | Short quote TTL, partner firm-quote backing, max-slippage guard |
| Stablecoin depeg | Multi-issuer support, depeg circuit breaker that halts new quotes |
| Reconciliation drift | Ledger invariants, a nightly full rebuild of the projection, alert on any unmatched item older than 1 h |
| Regulatory | We only serve licensed customers, run KYB and sanctions screening, and use regulated ramp partners. We do not take consumer custody. |

---

## 7. Build strategy (13 days to submission)

Principle: **one corridor that works for real beats five corridors that are faked.** The demo video walks one EUR → NGN payout from quote to reconciled journal entry, showing the Tempo memo on the explorer.

| Days | Milestone | Deliverables | Exit criteria |
|---|---|---|---|
| **D1–D2** (30 Sep–1 Oct) | Foundations | Monorepo, Postgres schema, ledger package with invariant tests, Tempo testnet wallet and TIP-20 transfer-with-memo script | A memo-tagged transfer shows on the Tempo explorer and is booked in the ledger |
| **D3–D5** (2–4 Oct) | Settlement saga | Saga runner, steps 1–3 and 6–7 live, bridge and partner steps behind adapters (mocks), quote engine | A payout goes through all steps with a compensation demo on a forced failure |
| **D6–D7** (5–6 Oct) | Solana and partner leg | Solana devnet routing vault, partner adapter (sandbox or mock), webhook ingest | Solana leg is visible, and a partner webhook closes the saga |
| **D8–D9** (7–8 Oct) | Recon and console | Recon engine (three-way match), console: corridor board, forecast, exceptions | 100% match on happy path and seeded exceptions visible |
| **D10** (9 Oct) | Hardening | Idempotency tests, seed data for two corridors, deployment | Public demo URL is stable |
| **D11** (10 Oct) | Pitch assets | Demo video (≤3 min), pitch video, deck final, LOIs attached | Assets reviewed |
| **D12** (11 Oct) | Buffer / stretch | Shielded lane spike (§9) **only if D1–D10 are green** | None |
| **D13** (12 Oct) | Submit | Submission form, repo cleanup, README screenshots | Submitted before the deadline |

**Business development runs in parallel from day 1:** contact 10 PSPs and MTOs and 6 ramp partners, with a goal of 2–3 LOIs by D10. A one-page LOI template goes in `docs/` on D1.

### 7.1 After the hackathon (indicative)

| Horizon | Focus |
|---|---|
| 0–3 months | Real bridge, one production ramp partner per corridor, MPC custody, first paying design partner on EUR → NGN |
| 3–6 months | KES, GHS, ZAR corridors, float-yield programme (opt-in), SOC 2 readiness |
| 6–12 months | Multi-partner smart routing, credit lines for pre-funding, stronger shielded B2B lane |

---

## 8. Metrics we instrument from day 1

- Settlement time (quote → partner confirmation), p50 and p95
- Auto-reconciliation rate
- Capital efficiency: pre-funding required with Corridor vs. the baseline nostro model
- Take rate (bps) per corridor, split across fee, FX share and SaaS

---

## 9. Optional module: shielded B2B settlement lane

This is the combined "1 + 3" strategy. It puts Corridor in the Zcash track without changing the core product.

**Use case:** a PSP's B2B customer pays suppliers across borders and does not want amounts and counterparties visible on a public chain.

**Flow:**
1. The B2B payout is flagged `privacy: shielded`.
2. The saga converts USD stablecoin to ZEC through a swap route (NEAR Intents supports ZEC swaps).
3. ZEC is sent from Corridor's shielded (Orchard) address to the supplier's shielded address, with an encrypted memo that carries the invoice reference.
4. The supplier receives shielded ZEC, or it is swapped out to a stablecoin at the destination.
5. Corridor issues the PSP a **viewing key** per payment batch, which gives auditors selective disclosure.
6. The ledger books the shielded leg against a `venue=zcash_shielded` account. Recon matches on the decrypted memo using the viewing key.

**Honest scoping:**
- ZEC price exposure during transit must be hedged or kept to a short window. The MVP limits it to small amounts with an instant swap.
- The Tempo ↔ Zcash connection is real engineering (swap route plus watcher). In the hackathon it is a spike: shielded send and viewing-key reconciliation on testnet, with the conversion simulated.
- The full version of this lane lives in the **Stipend** repository. Shared components: Zcash adapter and viewing-key recon.

---

## 10. Open decisions (need your call before build)

1. **Primary settlement asset on Tempo:** USDC vs. a native TIP-20 USD stablecoin. This affects the Fee AMM path and partner acceptance.
2. **Bridge:** simulate it for the hackathon (recommended), or spend 2 days on a live Across integration.
3. **First ramp partner to approach for a sandbox:** your Zynta network probably decides this.
4. **Include the shielded lane in this submission?** Recommended as a stretch goal only, gated on D10.
