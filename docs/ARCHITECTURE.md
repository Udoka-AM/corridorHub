# Corridor architecture

This document describes how Corridor is built: the design principles, the network topology, the data model, each component, and how they behave on mainnet and on testnet. Where something is designed but not yet built, it says so.

## 1. Overview

Corridor is the payment ledger and router that licensed payment companies run in their own environment, on their own keys, for cross-border stablecoin payouts. It does not hold funds, provide liquidity or carry licences. Those come from the anchors and licensed operators a company already works with. Corridor runs payouts across them exactly once and keeps one set of books that matches the chain.

A single EUR → KES payout crosses a bank collection, a stablecoin issuer, an anchor and the beneficiary's bank, each with its own identifiers. Corridor carries one 32-byte reference through every step, books every movement from the transaction that caused it, and checks every vault on-chain against the ledger.

Stellar is the settlement hub. Two things about Stellar decide the shape of the system:

1. **`MEMO_HASH` is exactly 32 bytes**, which is exactly a Corridor Reference. The reference travels whole, as part of the signed transaction, so reconciliation is a join rather than an inference (§7, ADR 0003).
2. **Anchors settle on Stellar itself.** The fiat spoke touches the hub directly, so the common payout path has no bridge in it at all (§3, ADR 0002).

Customers adopt it in two stages:

1. **Read-only.** Corridor watches the Stellar accounts the company already runs, matches them against the company's own payout records, and raises an exceptions queue. No keys are shared and nothing moves.
2. **Routing.** Corridor runs payouts out of a balance on Stellar and through anchors, signing with the company's own KMS or MPC signer.

## 2. Design principles

| Principle | What it means in the code |
|---|---|
| **Customer-held keys** | Every vault signs through a signer interface. Stellar and Solana both use Ed25519, so one held key serves both: `ed25519StellarSigner` takes any `signBytes` implementation and its raw public key. Adapters exist for local keys (development), AWS KMS and Turnkey. Corridor never holds a key or a balance. |
| **Book from the chain** (ADR 0008) | Every ledger entry for an on-chain movement is keyed by its transaction. Fees, reserves and rounding are booked from what the network reports, not estimated. The ledger keeps Stellar's own 7 decimal places, so a booked balance can equal an on-chain balance exactly; spokes with fewer decimals convert through `rescale`, which refuses any conversion that would drop value. |
| **One reference end to end** (ADR 0003) | A 32-byte Corridor Reference rides Stellar's `MEMO_HASH`, the Solana memo on cross-chain spokes, and the anchor's own fields. |
| **The hub is enforced** (ADR 0002) | Payouts are funded from a balance on Stellar, and collections land on Stellar. The route planner rejects any other shape, so every flow is settled, held and reconciled in one place. |
| **Exactly once across systems** | Every leg records its external side effect (a payment, an anchor order, a funding transfer) before it waits on it. A retry resumes the recorded work; a gap it cannot resolve stops the payout for a person. |
| **Issuer identity is part of the asset** | USDC from any issuer other than the one Corridor settles in is not USDC. `assetOf` matches code *and* issuer, so a look-alike token is never booked. |
| **Issuer-neutral** | USDC, USDT, PYUSD, MGUSD and EURC are each booked in their own asset. |

**Privacy** is deliberately absent for now (ADR 0005). The reference reserves a flag for it and the ledger and planner already carry the notion of a shielded venue, but no shielded venue is configured: the confidential lane arrives with Stellar confidential tokens and auditor keys, and until then `privacy: "shielded"` is refused with that reason.

## 3. Network topology: hub and spokes

Stellar is the settlement hub and every region is a spoke. Every flow is one of two shapes:

- **Collection:** local currency comes in through an anchor and is credited to the customer's balance on the hub.
- **Payout:** the customer's balance on Stellar goes out to a spoke, where an anchor pays local currency.

A cross-border flow is a collection followed by a payout:

```
          collections                          payouts
 KES ─┐                                               ┌─▶ KES / XOF / TZS / GHS / ZAR … (payouts into Africa)
 XOF ─┤                                               ├─▶ CNY / HKD / INR / AED …       (import payments to Asia)
 TZS ─┼─▶ STELLAR HUB (USDC) ───────────────────────▶ ┼─▶ USD / BRL / MXN / COP …       (payments to the Americas)
 USD ─┤     customer balances · ledger · recon        ├─▶ EUR / GBP …                   (payments to Europe)
 EUR ─┘                                               └─▶ NGN                           (via a partner off Stellar)
```

Why this shape:

- **N integrations, not N×N corridors.** Adding a region means adding one anchor, and every existing spoke can reach it. Because anchors speak the same SEPs, "adding an anchor" is a domain and an asset rather than an integration.
- **One place to settle and reconcile.** Hub enforcement is tested in `packages/routing/src/routing.test.ts`.
- **Currency pairs in the reference.** The Corridor Reference encodes the funding and beneficiary currencies (§7), so a new corridor such as `GHS-HKD` needs no registry change.

Corridors open in this order: **KES** (Minisend), **XOF** (lomi.) and **TZS** (ClickPesa) first, then **NGN** through a licensed partner, then Ghana and South Africa. None of these anchors is signed yet.

**Naira is on the hub as well.** A naira payout partner that settles in USDC on Stellar is available — a payout app rather than a SEP anchor, so it needs its own `RampPartner` adapter in the shape of the existing Paj one, and that adapter is not written yet. What the route graph says is already true: `OFF_STELLAR_PAYOUT_CURRENCIES` is empty, so NGN plans as `ledger.reserve → partner.payout` like every other launch corridor, and no payout crosses a chain.

Putting a currency back into that list routes it over a bridge hop instead, which is what a new corridor does while its first partner settles elsewhere. Paj (Solana → NGN) stays supported as an alternate on exactly that basis.

**Outbound regulation.** Outbound FX from markets like Nigeria is regulated; import payments, for example, need a Form M and an FX-licensed institution. The licensed customer holds the FX permissions and the KYC. Corridor carries the compliance references (invoice number, Form M number) in the saga data and the off-chain payload, and its reconciliation trail is audit evidence.

## 4. Settlement asset on Stellar

Corridor settles in **USDC on Stellar** and books every other issued asset in its own asset:

- **USDC** is the hub's unit of account. Customer balances, the treasury vault and the clearing accounts are all USDC on Stellar.
- **EURC, MGUSD, PYUSD** are first-class. Converting between them is a `stellar.pathPayment` leg over Stellar's own order books — on-ledger FX, no external venue. The edge is in the route graph and the planner produces it; the leg implementation is not written yet (§8.6).
- **XLM** is held only as fee float and booked to `expense:gas`. Stellar charges fees in XLM, so a vault keeps a small balance; `create_account` and sponsored reserves are observed and booked from the transaction that paid them.

Issuers are configured per network in `STELLAR_ISSUERS`, overridable per deployment through `CORRIDOR_STELLAR_ISSUER_<CODE>_<NETWORK>`. USDC (mainnet and testnet) and EURC (mainnet) are set; **MGUSD, PYUSD and USDT are deliberately unset** until each is verified against its issuer's own published `stellar.toml`, and asking for one raises an error that names the missing issuer rather than guessing.

A trustline is what lets an account hold an issued asset. Ramp's end users get theirs sponsored, so they can hold USDC without first holding XLM.

## 5. System architecture

```
                 ┌──────────────────────────────────────────────────────────────────┐
Customer ──API──▶│  API (payouts · batches · read-only watch)                        │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Route planner ── route graph (venues × assets × legs)            │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Settlement saga engine (durable, per-leg compensation, fencing)  │
                 │     │              │                  │                           │
                 │  ┌──▼────────┐ ┌───▼──────────┐ ┌─────▼────────────┐              │
                 │  │ Stellar   │ │ Anchor legs  │ │ Cross-chain legs │              │
                 │  │ legs:     │ │ SEP-10/12/   │ │ CCTP from Base   │              │
                 │  │ payment + │ │ 31/38,       │ │ and Solana,      │              │
                 │  │ MEMO_HASH,│ │ payout and   │ │ SPL memo on the  │              │
                 │  │ path      │ │ collection   │ │ spoke            │              │
                 │  │ payment   │ │ orders       │ │                  │              │
                 │  └──┬────────┘ └───┬──────────┘ └─────┬────────────┘              │
                 │     │              │                  │                           │
                 │     ▼              ▼                  ▼                           │
                 │  Signer interface (customer KMS · Turnkey · MPC)                  │
                 │     │                                                             │
                 │  Observers (Horizon payments · anchor status · webhooks)          │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Double-entry ledger (Postgres) ◀──▶ Reconciliation engine        │
                 └─────┼─────────────────────────────────────────────────────────────┘
                       ▼
                 Treasury console: corridors · venues · forecast · recon · exceptions
```

Everything inside the box runs in the customer's environment.

## 6. Core model

```ts
type Venue = "stellar" | "base" | "solana" | "partner_fiat";
type Asset = "USDC" | "USDT" | "PYUSD" | "MGUSD" | "EURC" | "XLM" | "SOL" | "ETH" | Fiat;

interface Edge {                    // one executable leg in the route graph
  kind: "ledger.reserve" | "ledger.credit" | "stellar.transfer" | "stellar.pathPayment"
      | "cctp.transfer" | "bridge.simulated" | "solana.transfer"
      | "partner.collect" | "partner.payout";
  from: { venue: Venue; asset: Asset };
  to:   { venue: Venue; asset: Asset };
  env?: ("testnet" | "mainnet")[];
}

interface PayoutData {
  corridor: `${Fiat}-${Fiat}`;      // e.g. "EUR-KES"
  asset: Asset;                     // the hub balance the payout is funded from, normally USDC
  venue: Venue;                     // "stellar"
  amount: string;                   // integer minor units, 7 dp
  reference: Hex;                   // §7
  recipient: BankRecipient;
  stellarCursor?: string;           // Horizon paging token the saga started at
}
```

Route examples, as the planner produces them:

- EUR → KES, mainnet: `ledger.reserve → partner.payout` — the anchor is on the hub, so there is nothing in between
- EUR → NGN, mainnet: `ledger.reserve → cctp.transfer (Stellar → Solana) → partner.payout`
- EUR → NGN, testnet: `ledger.reserve → bridge.simulated (Stellar → Solana) → partner.payout`
- Funded in EURC: `ledger.reserve → stellar.pathPayment (EURC → USDC) → partner.payout`
- KES collection: `partner.collect (→ Stellar) → ledger.credit`

## 7. Corridor Reference

One 32-byte reference, carried in each venue's native reference field:

```
byte 0      version (0x02)
byte 1      kind   (payout · batch · batch item · sweep · deposit · collection)
byte 2      funding currency (Corridor currency index: 32 currencies across 4 regions, room for 255)
byte 3      beneficiary currency
byte 4      flags  (bit 0: shielded — reserved for the confidential lane)
bytes 5–20  payout or batch id (UUIDv7)
bytes 21–27 customer tag (7-byte keyed hash, so a public memo never identifies the customer)
bytes 28–31 checksum (first 4 bytes of sha256 over bytes 0–27)
```

| Venue | Where it lives | Why it fits |
|---|---|---|
| Stellar | The transaction's `MEMO_HASH` | 32 bytes exactly: no truncation, no encoding games, and the memo is part of the signed transaction rather than a separate operation |
| Solana | SPL Memo instruction in the same transaction | The native pattern partners already read |
| Anchor | SEP-31 transaction fields, echoed into the bank narration | A bank statement line traces back to the payout that caused it |

**Reconciliation is a join, not an index.** Horizon cannot be asked for a memo network-wide, the way an indexed event topic can. It does not need to be: Corridor reads the payment stream of the account it already watches and filters on the memo. That stream is per-vault and bounded, a stored paging token makes restarts neither miss nor double-count, and no indexer sits in the path.

**One honest exception.** On a SEP-31 leg the *anchor* assigns the memo for the funding payment, so Corridor's reference cannot ride in it. The reference then travels in the SEP-31 transaction fields and the join key becomes `(anchor, transaction id)`, which the saga already records to make funding exactly-once. `PartnerOrder.fundingMemo` carries the anchor's memo, and `stellarAnchorFunder` (`packages/legs`) uses it when it is set, falling back to the reference. The duplicate check (`findTransfersByMemo`) matches on whichever memo went out, so funding stays exactly-once either way.

## 8. Components

### 8.1 Ledger (`packages/ledger`)

The ledger keeps Stellar's own 7 decimal places (ADR 0012), so a booked balance can equal an on-chain balance exactly.

- Accounts keyed `(owner_type, owner_id, corridor, asset, venue, type)`. Types: asset, liability, revenue, expense, clearing, equity.
- Immutable journal. Every entry balances per asset; conversions between assets go through `clearing` accounts (the USD peg, USD → EUR).
- Invariants enforced at write time and tested: entries balance, no-overdraft accounts never go negative, and each external movement is booked exactly once (unique `(venue, external_ref)`).
- `entryTotal(..., { excludeLiabilities: true })` gives the movement across Corridor's own positions. Reconciliation needs this now that the hub and its spokes settle in the same asset: a payout debits the customer's hold in USDC *and* moves USDC on a chain, and only the second is what an observer saw.
- Runs on Postgres; PGlite locally, so development needs no database.

### 8.2 Saga engine (`packages/saga`)

- Postgres-backed sagas, steps and events. Every leg implements `forward()` and optionally `compensate()`.
- Idempotency key per `(saga, step)`. Retries with backoff per leg kind.
- Failure before money leaves: completed steps compensate in reverse order. Failure after money leaves (a funded anchor order): the saga stops at `manual_review` until a person confirms the refund.
- Leases with fencing tokens: every commit checks the token, so a worker whose lease lapsed mid-leg can never book or mark a step done.

### 8.3 Signers (`packages/signer`)

- One interface for secp256k1 (Base and other EVM chains) and Ed25519 (Stellar, Solana) signing.
- Adapters: local keys (development), AWS KMS (DER parsing, low-s normalisation, recovery id), Turnkey (raw-payload signing with API-key stamps, policy approvals respected).
- `ed25519PublicKeyBytes` returns the raw 32-byte key; Solana writes it in base58 and Stellar in StrKey, so one KMS or MPC key addresses both. `ed25519StellarSigner` wraps it for Stellar, and signing is over the transaction hash — the signer never sees transaction semantics.
- Selected at runtime with `CORRIDOR_SIGNER=aws-kms|turnkey`; the same flows run unchanged.

### 8.4 Stellar (`packages/chain-stellar`)

- `@stellar/stellar-sdk` against Horizon. Mainnet and testnet differ only by passphrase, Horizon URL and issuer.
- `transferWithReference` sends a classic-asset payment with the reference as `MEMO_HASH` and returns the observation that gets booked. `trustAsset` opens a trustline. Fees come from Horizon's recent fee stats, falling back to the base fee.
- `StellarObserver` watches accounts (Corridor's vaults, or a customer's own wallets in read-only mode) for payments in and out, resuming from a stored Horizon paging token. With `unreferenced` it also reports account funding, sponsored reserves, plain inbound payments, and the XLM fee each outbound transaction charged.
- Horizon's payment endpoint is called with `join=transactions`, so the memo arrives in the same call. The SDK turns every `_links` entry into a method, so the joined transaction sits in `transaction_attr` and its ledger sequence in `ledger_attr`; `normalizeRecord` lifts both out, and the ledger sequence is cross-checked against the operation's TOID (`paging_token >> 32`). Getting this wrong silently loses every memo, so it is covered by tests.
- Amounts: Stellar carries 7 decimal places as decimal strings, and the ledger keeps the same precision, so conversion is formatting and never rounding.

### 8.5 Anchors (`packages/partners`)

- **Partner interface (`RampPartner`):** `rates`, `openPayout`, `openCollection`, `getOrder`, `verifyWebhook`, `parseWebhook`. Every provider is normalised to `open → processing → completed | failed`, and a `PartnerRegistry` picks the partner per currency, direction and chain.
- **`SepAnchor`** implements that interface over the SEPs: SEP-1 for discovery, SEP-10 for authentication, SEP-12 for customer records, SEP-38 for a firm quote, SEP-31 for the payment itself. It has run end to end against Stellar's own Anchor Platform, brought up locally as a receiving anchor (`examples/anchor`); `baseUrl` points it at a server not served over HTTPS at its home domain, and the SEP-31 funding method is read from the anchor's own `GET /info`. The SEP-10 challenge is checked before the vault signs it — it must be built by the anchor's own `SIGNING_KEY` and name this vault — so a stray endpoint cannot get the vault to sign something else. The JWT is cached for its lifetime.
- SEP-31 has no webhook: the sending anchor polls `GET /transactions/{id}`, which is what the saga's wait loop does, so `verifyWebhook` returns false and `parseWebhook` says so rather than pretending.
- **Not built:** SEP-6 collections. `openCollection` checks the anchor publishes a `TRANSFER_SERVER` and then raises, rather than guessing at a flow no signed anchor has yet.
- **Off-Stellar partners:** Paj (Solana → NGN) is carried over from the prototype for the naira corridor. It settles in 6-decimal USDC, so amounts convert through `rescale`, which refuses an amount carrying a seventh decimal instead of rounding it away.
- **Webhooks (`packages/webhooks`):** `POST /webhooks/:partner`, verified with HMAC-SHA256 over `{timestamp}.{raw body}` (5-minute window, constant-time compare). Each order status is stored once; redeliveries are acknowledged and forgeries rejected.

### 8.6 Legs (`packages/legs`)

- **`stellar.transfer`** pays a counterparty out of the treasury with the flow's reference, and is safe to retry: it first asks the network whether an identical movement (same memo, parties, amount and asset) already landed.
- **`partner.payout`** opens the anchor order, funds it exactly once, and waits. The vault it funds from depends on where the anchor settles: an anchor on the hub is paid out of the treasury; one that settles elsewhere is paid from the egress vault a bridge leg filled, and the customer bears those fees. Anchor rounding is booked as dust held for the customer; a failure after funding stops at `manual_review`.
- **`partner.collect`** opens the onramp order, waits for the anchor to deliver USDC to the ingress vault, and books it. **`ledger.credit`** then credits the customer's USDC balance on the hub.
- **`bridge.simulated`** stands in for CCTP on testnet: the Stellar side is real (value moves to an escrow with the reference as memo) and the far side is simulated, with the same bookings.
- **Not built:** the `cctp.transfer` leg and the `stellar.pathPayment` leg. Both are declared in the route graph and planned for, but neither implementation is written, so mainnet naira payouts do not run and a payout cannot yet be funded from an EURC or MGUSD balance.

### 8.7 Reconciliation and read-only mode (`packages/recon`)

- Observers emit `Observation { venue, externalRef, reference, asset, amount, blockNumber, observedAt }`. The matcher joins them with ledger entries and reports `matched`, `amount_mismatch`, `unbooked` or `unreferenced`, the same way for every venue.
- Vault accounting books fees, reserves and owner top-ups from the chain, then compares each vault's on-chain balance with the ledger.
- Read-only mode (ADR 0011) runs the same observers on accounts the customer already operates and matches them against the customer's own payout records: `matched`, `short`, `over`, `pending`, `missing`, `unexpected`, with an exceptions queue and a CSV export. `pnpm watch:report` runs it.

### 8.8 Treasury console (`apps/console`)

**Not built for Stellar.** The prototype's console read Tempo, Solana and the Zcash lane; it was removed rather than left showing a chain this repo no longer settles on. The read-only reporting it fronted is available from `pnpm watch:report`.

## 9. Environments

| Component | Mainnet | Testnet |
|---|---|---|
| Stellar | Code paths identical; no mainnet run yet | Live: payments with references, read back off Horizon |
| Anchors | None signed | `MockPartner` with the same lifecycle and signed webhooks; `SepAnchor` against Stellar's Anchor Platform, run locally, and against a stubbed anchor in tests |
| CCTP | Leg not built | `bridge.simulated` with the same bookings |
| Solana / Base | Carried over from the prototype for the naira corridor | Devnet |

What has actually run, on Stellar testnet, 17 October 2026:

- A payment carrying a Corridor Reference in `MEMO_HASH`, read back off Horizon and decoded whole — `pnpm stellar:smoke`.
- A whole payout through the saga engine: route planned, customer balance reserved, anchor order opened and funded exactly once with a real Stellar payment, every movement booked double-entry, no invariant violations — `pnpm stellar:payout`.

Both use XLM, because a funded testnet USDC trustline needs an issuer faucet; the USDC path is the same call with a different asset.

## 10. Security and compliance

- Corridor serves licensed payment companies, which own the KYC and KYB of their end customers and hold the licences for each corridor.
- Corridor runs in the customer's environment and signs only through the customer's signer. It is software, not a custodian or a money transmitter.
- Fiat touchpoints go through regulated anchors and licensed partners in each corridor.
- The SEP-10 challenge is verified before signing, and an asset is only recognised from its configured issuer.
- Secrets live outside the repository.

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Anchor supply is thin | The partner interface is uniform, so a corridor moves between a Stellar anchor, a Stellar-settling payout app and an off-Stellar partner by changing one list in the route graph |
| An anchor assigns its own memo on SEP-31 | The reference moves to the SEP-31 fields and the join key becomes the anchor's transaction id, which funding already records |
| Anchor rounding and fees | The payout leg funds exactly the anchor's order and books fees and dust, so vaults still balance to the unit |
| A look-alike asset from another issuer | Issuer is part of asset identity; unknown issuers are not booked |
| Precision loss between a 7 dp hub and 6 dp spokes | `rescale` refuses any conversion that would drop value, so a stroop of dust surfaces as an error |
| Stellar adoption for retail volume | Corridor is a B2B rail: the hub is one set of edges in the planner, and the ledger, saga engine and reconciliation are chain-agnostic |
| Horizon availability | `CORRIDOR_HORIZON_URL` points at a private instance; observers resume from a stored cursor |

## 12. Further reading

- [README](../README.md) — what Corridor is, what runs today, and how to reproduce it.
- [The decision records](https://corridor.udokaam.dev/decisions/index) — twelve records with the context, the decision, the consequences accepted and the alternatives rejected. The ones cited above: 0002 (the hub is enforced), 0003 (the reference in `MEMO_HASH`, and no indexer), 0005 (the confidential lane is deferred), 0008 (book from the chain), 0011 (read-only first), 0012 (the 7-decimal ledger).
- `packages/routing/src/routing.test.ts` — hub enforcement and every route shape above, as tests.
- `packages/chain-stellar/src/stellar.test.ts` — the reference on a real transaction, issuer identity, and the Horizon quirks that would otherwise lose memos.
