# Corridor: architecture, build strategy and integrations

| | |
|---|---|
| **Status** | v0.2, decisions locked, build in progress |
| **Target** | Colosseum Crypto World's Fair, submissions close **12 Oct 2026** |
| **Tracks** | Tempo (primary) · Solana · Zcash · general pool |
| **Scope change from v0.1** | Stipend's shielded payouts are now part of Corridor's core model, not an add-on module |

---

## 0. Decision log

| # | Question | Decision | Why |
|---|---|---|---|
| D-1 | Settlement asset on Tempo | **pathUSD is the canonical settlement unit. The edges accept any USD TIP-20.** | See §0.1 |
| D-2 | Tempo ↔ Solana bridge | **Live Across integration first.** The simulated adapter is only a fallback. | Across supports Tempo mainnet (4217). There is no direct Tempo↔Solana route, so we go in **two hops through Base**, both live and quoted (§6.3). |
| D-3 | First ramp partner | Paj (Solana → NGN, business API) for the demo; approach FossaPay, Yellow Card, Kotani Pay and others in parallel | See §9 |
| D-4 | Shielded lane in this submission | **Yes, native to the architecture** | See §2 |
| D-5 | Who holds the keys (3 Oct 2026) | **The customer.** Corridor runs in the customer's environment and signs through `@corridor/signer` (local for testnet, AWS KMS built, MPC next). | A licensed payment company cannot route funds through wallets an unlicensed vendor controls. Docs: ADR 0009. |
| D-6 | Which stablecoins (3 Oct 2026) | **Issuer-neutral:** USDC, USDT, PYUSD, EURC alongside pathUSD, each booked in its own asset. | African payout liquidity is USDT-heavy; Solana partners lean USDC; euro senders want EURC. Docs: ADR 0010. |
| D-7 | How a customer starts (3 Oct 2026) | **Read-only first:** watch existing wallets, match the customer's payout records, exceptions and CSV. Routing comes second. | No keys and no money at risk to start; the visibility problem is the one customers feel daily. Docs: ADR 0011. |

### 0.1 D-1 in detail: which stablecoin on Tempo

Choosing "USDC or a native TIP-20" is a false choice. **Every stablecoin on Tempo is a TIP-20**, including USDC.e, which is Stargate-bridged USDC at `0x20C0…b9537d11c60E8b50`. The real question is which TIP-20 Corridor treats as its unit of account, and whether partners ever see it.

Partners never see it. Every ramp partner is paid in **USDC on Solana**, and the Tempo-side asset stays inside Corridor:

```
Ingress (any USD TIP-20)          Core (Tempo)                     Egress
USDC.e / USDT0 / pathUSD ──DEX──▶ pathUSD vaults + ledger ──Across──▶ Base USDC ──Across──▶ Solana USDC ──▶ ramp partner
```

Why pathUSD is the core unit:
- **Built for exactly this.** Bridge (a Stripe company) issues it as Tempo's neutral quote token. Every USD TIP-20 routes through it on the enshrined stablecoin DEX, so conversion on the way in is one atomic transaction.
- **Fee AMM native.** Validators accept pathUSD as a fee token, so vaults pay gas in the asset they already hold.
- **Available on testnet.** The Moderato faucet issues pathUSD, so the demo runs on the same asset as production.
- **Supported by Across.** Live routes include `pathUSD (4217) → USDC` on Base, Arbitrum, Ethereum and others.
- **Ecosystem story.** Volume on Tempo's native quote token and DEX is what the Tempo track wants to see.

Guardrail: pathUSD circulating supply is still small (single-digit millions of dollars as of mid-2026). The ledger is multi-asset per venue, and each corridor has a `settlementAsset` policy. If a ticket is bigger than pathUSD depth, the corridor settles in USDC.e directly, since Across routes exist for both. Switching is a config change, not a migration.

---

## 1. Scope for the hackathon

1. **Inbound payout, EUR → NGN.** Quote, then settle on Tempo (memo), bridge live Tempo → Base → Solana through Across, then pay out with a ramp partner, then run a three-way reconciliation.
2. **Outbound import payment, NGN → supplier in Asia or the Americas.** A Nigerian importer's NGN is collected into the Tempo hub, then paid out to a supplier in CNY/HKD/USD. This shows the network works in both directions (§2.1).
3. **Shielded lane, B2B supplier batch and contributor payroll.** One batch of N private payouts funded from the same Tempo vaults and paid in **one Ironwood shielded transaction**. It is approved with FROST 2-of-3 and disclosed to an auditor through a viewing key scoped to the customer and the period.
4. **One ledger, one saga engine and one reconciliation engine** serve every lane and direction.
5. **Treasury console** with balances per corridor **and per venue** (Tempo, Solana, partner fiat, Zcash shielded), the pre-funding forecast, the exceptions queue and disclosure exports.

Out of scope: live fiat collection (the PSP collection arrives as a signed webhook), production custody (KMS-wrapped dev keys), and executing yield.

---

## 2. The design principle: privacy is a venue, not a feature

A bolt-on would look like `if (shielded) callZcashService()`. Corridor does this instead:

| Concept | Public lane | Shielded lane | Same code? |
|---|---|---|---|
| **Venue** (where value sits) | `tempo`, `solana`, `partner_fiat` | `zcash_ironwood` | Yes: `Venue` is one enum |
| **Route** (how value moves) | legs through the route graph | legs through the same graph | Yes: one planner |
| **Saga** | forward and compensation per leg | forward and compensation per leg | Yes: one engine |
| **Ledger** | accounts keyed `(owner, corridor, asset, venue)` | same, `venue = zcash_ironwood` | Yes: one journal |
| **Reference** | Corridor Reference in TIP-20 memo / Solana memo | same reference in the Zcash encrypted memo | Yes: one codec |
| **Reconciliation** | ledger ↔ chain logs ↔ partner webhook | ledger ↔ viewing-key scan ↔ recipient | Yes: one matcher, different *observers* |
| **Disclosure** | public by nature | viewing key per `(customer, period)` | Built in from the start |

The route graph decides how a payout moves. `privacy: "shielded"` is a constraint on the path (the final leg must end in the `zcash_ironwood` venue). It is not a separate subsystem.

### 2.1 A global network: hub and spokes

Corridor is not limited to EU → Africa. **Tempo is the settlement hub, and every region is a spoke.** Every flow is one of two things:

- **Collection:** local currency comes in through a ramp partner, is converted to USDC, bridged to Tempo, and credited to the customer's pathUSD balance.
- **Payout:** the customer's Tempo balance goes out to a spoke, either public (partner pays local currency) or shielded (Ironwood).

A cross-border flow is a collection followed by a payout:

```
          collections                         payouts
 NGN ─┐                                              ┌─▶ NGN / KES / GHS / ZAR …   (inbound remittance, payroll)
 KES ─┤                                              ├─▶ CNY / HKD / INR / AED … (import payments to Asia)
 GHS ─┼─▶ USDC (Solana) ─▶ TEMPO HUB (pathUSD) ─▶ ────┼─▶ USD / BRL / MXN / COP … (payments to the Americas)
 USD ─┤         customer balances · ledger · recon   ├─▶ EUR / GBP …             (payments to Europe)
 EUR ─┘                                              └─▶ Zcash Ironwood          (shielded supplier batches, payroll)
```

Why this shape:
- **N integrations, not N×N corridors.** Adding a region means adding one ramp partner, and every existing spoke can then reach it.
- **The hub is enforced.** The planner rejects any payout not funded from the Tempo hub and any collection that doesn't land on it. So every flow is settled, held, reconciled and visible to treasury in one place, which is the product. (Tested in `routing.test.ts`.)
- **Currency-pair references.** The Corridor Reference encodes the funding and beneficiary currencies directly (§5), so a new corridor such as `GHS-HKD` needs no registry change.
- **The shielded lane fits import payments.** Importers don't want competitors reading supplier prices and volumes on a public chain.

**Priority flows:**

| Flow | Direction | Example | Payout rail |
|---|---|---|---|
| Diaspora and B2B payouts into Africa | Inbound | EUR/GBP/USD → NGN, KES, GHS | Local bank / mobile money |
| **Import payments to China and Hong Kong** | Outbound | NGN/KES/GHS → CNY, HKD, USD | Supplier's HK or offshore USD/HKD account. Onshore CNY conversion is restricted, so most China trade settles in USD/HKD/USDT. |
| Import payments to India, UAE, Turkey, SE Asia | Outbound | NGN → INR, AED, TRY, IDR | Local payout partners |
| Payments to the Americas | Outbound | NGN/KES → USD, BRL, MXN | ACH/wire, Pix, SPEI |
| Intra-Africa trade | Both | NGN ↔ KES, GHS, XOF | Local ramps |

**Payout partner candidates by region** (all to be verified in outreach):

| Region | Candidates |
|---|---|
| Africa | Paj, FossaPay, Yellow Card, Kotani Pay, Bitnob, HoneyCoin, Busha |
| China / HK / Asia | Nium (USDC-funded payouts to 100+ countries), licensed HK payment institutions, Conduit |
| Americas | Bridge (Stripe; USD rails, and the issuer of pathUSD), Bitso Business (MXN/COP/ARS), Pix partners (BRL), Conduit |
| Global aggregators | BVNK, Conduit, Nium |

**Regulation of outbound flows.** Outbound FX from markets like Nigeria is regulated. For example, import payments need a Form M and have to go through institutions licensed for FX. Corridor stays infrastructure: the licensed PSP or IMTO customer holds the FX permissions and the KYC. Corridor carries the compliance references (invoice number, Form M number) in the saga data and off-chain payload, and the reconciliation trail is audit evidence.

---

## 3. System architecture

```
                 ┌──────────────────────────────────────────────────────────────────┐
PSP / B2B ──API─▶│  API (quotes · payouts · batches · disclosures)                   │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Route planner ── route graph (venues × assets × legs)            │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Settlement saga engine (durable, per-leg compensation)           │
                 │     │            │              │              │                  │
                 │  ┌──▼───┐   ┌────▼────┐   ┌─────▼─────┐   ┌────▼──────┐           │
                 │  │Tempo │   │ Across  │   │ Solana +  │   │ Zcash     │           │
                 │  │legs  │   │ bridge  │   │ ramp legs │   │ shielded  │           │
                 │  │memo, │   │ Tempo→  │   │ SPL memo, │   │ legs:     │           │
                 │  │DEX,  │   │ Base→   │   │ partner   │   │ NEAR swap,│           │
                 │  │FeeAMM│   │ Solana  │   │ payout    │   │ Ironwood  │           │
                 │  └──┬───┘   └────┬────┘   └─────┬─────┘   │ batch tx, │           │
                 │     │            │              │         │ FROST     │           │
                 │     │            │              │         └────┬──────┘           │
                 │     ▼            ▼              ▼              ▼                  │
                 │  Observers (log watchers · webhooks · viewing-key scanner)        │
                 │     │                                                             │
                 │     ▼                                                             │
                 │  Double-entry ledger (Postgres) ◀──▶ Reconciliation engine        │
                 └─────┼─────────────────────────────────────────────────────────────┘
                       ▼
                 Treasury console: corridors · venues · forecast · recon · disclosures
```

---

## 4. Core model

```ts
type Venue = "tempo" | "base" | "solana" | "partner_fiat" | "zcash_ironwood";
type Asset = "pathUSD" | "USDC.e" | "USDC" | "ZEC" | "NGN" | "KES" | "EUR";

interface LegSpec {                 // one edge in the route graph
  kind: "tempo.transfer" | "tempo.dexSwap" | "across.bridge" | "solana.transfer"
      | "partner.payout" | "near.swap" | "zcash.shieldedBatch";
  from: { venue: Venue; asset: Asset };
  to:   { venue: Venue; asset: Asset };
}

interface PayoutIntent {
  corridor: "EUR-NGN" | "USD-KES" | ...;
  amount: Money;                    // target amount
  privacy: "public" | "shielded";
  recipient: PublicRecipient | ShieldedRecipient;
  reference: CorridorRef;           // §5
}
```

**Route examples:**
- Public EUR→NGN: `tempo.transfer → across.bridge(tempo→base) → across.bridge(base→solana) → partner.payout`
- Shielded supplier/payroll: `tempo.transfer → near.swap(USDC→ZEC) → zcash.shieldedBatch`

---

## 5. Corridor Reference: one ID across three chains

One 32-byte reference, carried in each chain's native reference field:

```
byte 0      version (0x02)
byte 1      kind   (payout · batch · batch item · sweep · deposit · collection)
byte 2      funding currency (Corridor currency index: 32 currencies across 4 regions today, room for 255)
byte 3      beneficiary currency
byte 4      flags  (bit0 shielded)
bytes 5–20  payout / batch id (UUIDv7, 16 bytes)
bytes 21–27 customer tag (7 bytes, keyed hash, so the customer can't be identified from a public memo)
bytes 28–31 checksum (first 4 bytes of sha256 over bytes 0–27)
```

| Chain | Where it lives | Why this chain fits |
|---|---|---|
| Tempo | TIP-20 `transferWithMemo(to, amount, bytes32 memo)`; `memo` is an **indexed** topic of `TransferWithMemo` | Recon can filter logs by reference directly, with no indexer |
| Solana | SPL Memo instruction (hex of the reference) in the same transaction | Native pattern for ramp partners |
| Zcash | Encrypted 512-byte memo on each Ironwood output (reference + invoice ref) | Only the recipient and viewing-key holders can read it |

---

## 6. Components

### 6.1 Ledger (`packages/ledger`), carried over from Arc
- Accounts: `(owner_type, owner_id, corridor, asset, venue, type)`. Types are asset, liability, revenue, expense and clearing.
- Immutable journal. Postings balance **per asset**. FX and swaps go through `clearing:{pair}` accounts.
- Invariants are enforced at write time and tested: entries balance, asset accounts flagged no-overdraft never go negative, and each on-chain reference is booked exactly once (unique `(venue, external_ref)`).
- The shielded venue gets its own accounts, e.g. `customer:acme:pathUSD:tempo` → `clearing:USD-ZEC` → `customer:acme:ZEC:zcash_ironwood` → `payable:supplier`.

### 6.2 Saga engine (`packages/saga`), carried over from Arc
- Postgres-backed step table plus an outbox. Every leg is `forward()` / `compensate()` / `observe()`.
- Idempotency key per `(saga_id, step)`. Retries and timeouts per leg kind. Exhausted retries go to `manual_review`.

### 6.3 Tempo legs (`packages/chain-tempo`)
- viem with its built-in `viem/tempo` chains and actions.
- Moderato testnet (chain 42431, `rpc.moderato.tempo.xyz`), with faucet via RPC `tempo_fundAddress`. Mainnet is chain 4217.
- `transferWithMemo` for every movement. Vaults pay gas in pathUSD through the Fee AMM.
- `dexSwap` for ingress conversion (USDC.e → pathUSD) on the enshrined stablecoin DEX.

### 6.4 Across bridge (`packages/bridge-across`)
- Swap API `GET /swap/approval` returns calldata. Deposit, then watch for the fill.
- Verified live quotes on 29 Sep 2026: **Tempo USDC.e → Base USDC**, 5 USDC in, fill ~1 s, fee ≈ $0.004. **Base USDC → Solana USDC**, fill ~8 s, fee ≈ $0.0006. Across does not yet support destination swaps into Solana in one call, so the saga runs **two legs**, each with its own compensation.
- **There is no Across Tempo testnet.** The live bridge runs on mainnet with micro-amounts ($5–20). The testnet demo can switch to the `simulated` adapter, which has the same interface.

### 6.5 Solana, ramp partners and webhooks (`packages/chain-solana`, `packages/partners`, `packages/webhooks`)
- **Solana leg:** `@solana/kit` transaction that creates the recipient's USDC account if missing, does a `TransferChecked`, and adds an SPL **Memo `corridor:<ref>`**, all in one transaction. An observer reads the reference back from the transaction's memo field.
- **Partner interface (`RampPartner`):** `rates`, `openPayout` (offramp), `openCollection` (onramp), `getOrder`, `verifyWebhook`, `parseWebhook`. Every provider is normalised to `open → processing → completed | failed`, so legs never depend on one provider's API. A `PartnerRegistry` picks the partner per (currency, direction, chain).
- **Paj adapter:** built against Paj Public API v2 ([OpenAPI](https://docs.paj.cash/api-reference/openapi.json)).
  - Offramp orders return a **one-off funding address** (valid for 2 hours). Onramp orders return a **one-off virtual bank account**.
  - The Corridor Reference rides in `description` / `userExternalId` and is echoed back on webhooks.
  - Paj settles on **Solana** (USDC) for Corridor; Base appears in its API but is not live, so the adapter refuses Base orders. A mainnet NGN payout is therefore **two Across hops** (Tempo → Base → Solana → Paj). `BASE_PAYOUT_CURRENCIES` stays empty until a Base-settling partner is live. `ZCASH` already appears in Paj's chain enum (not open yet), a future path for shielded payouts straight to naira.
- **Mock partner:** the same lifecycle and the same signed webhooks, for testnet. Payout funding is a real Solana devnet memo transfer whenever the devnet vault holds USDC.
- **Webhooks:** `POST /webhooks/:partner`.
  - Each delivery is verified with HMAC-SHA256 over `{timestamp}.{raw body}` (`v1=` prefix, 5-minute window, constant-time compare). This is Paj's scheme.
  - Each order status is stored **once**. Redeliveries are acknowledged; forgeries get a 401.
  - A completed order becomes an Observation for reconciliation (`partner_fiat`, `${partner}:${orderId}`).
- **Payout leg safety:**
  - The step records its partner order and funding transaction durably (`partner_order_links`), so **funding is exactly-once** across retries and crashes.
  - A partner failure **after funding** stops the saga at `manual_review` rather than compensating, because the money is at the partner until its refund is confirmed.
- **Collections (importer flow):** `partner.collect` (virtual account → USDC delivered to the Corridor ingress wallet) → bridge into the hub → `ledger.credit` (the customer's pathUSD balance). The customer can then pay suppliers from the hub like any other payout.

### 6.6 Shielded legs (`packages/chain-zcash`, `services/zcash-frost`)
- **Wallet tooling:** [`zcash-devtool`](https://github.com/zcash/zcash-devtool), which is librustzcash and Ironwood-aware, syncing through `testnet.zec.rocks`. Its wallet database is read read-only for observation. The Z3 node stack is the production path. Orchard has been sealed since NU6.3 (July 2026), so all new notes land in **Ironwood**.
- **Vault model:** each `(customer, period)` gets its own shielded **vault** (a ZIP-32 account or a FROST vault). Its viewing key discloses exactly that customer's period and nothing else.
- **Batch payout:** a ZIP-321 payment request becomes **one shielded transaction with N outputs**. Each output carries a ZIP-302 text memo (`INV-… / corridor:<ref>`) that is encrypted to the recipient and readable in their wallet.
- **Threshold control (FROST 2-of-3):** the vault's spend-authorizing key `ak` *is* a FROST group key (RedPallas ciphersuite). Nobody holds the whole spending key, and any 2 of {customer approver, customer finance lead, Corridor} can authorize.
  1. `corridor-frost keygen` produces 3 shares. The group verifying key must have a positive-y encoding, which the keygen retries until it does. The Orchard FVK `ak ‖ nk ‖ rivk` then goes into `FullViewingKey::from_bytes` (a public API, no crate fork), and from there into the UFVK and vault address.
  2. `zcash-devtool` imports the UFVK (view-only) and builds the batch as an unsigned **PCZT** (`pczt create --payment-uri`, a small patch kept in `services/zcash-frost/patches/`), then proves it.
  3. `corridor-frost sign` reads each unsigned Ironwood action's `alpha`. It checks `rk == ak + [alpha]G`, so it only signs this vault's spends. It runs FROST rounds 1 and 2 **rerandomized by alpha**, aggregates, verifies the RedPallas signature against `rk`, and applies it with `Signer::apply_ironwood_signature`. A signer set below the threshold is refused.
  4. `zcash-devtool pczt combine` merges proofs and signatures, then `pczt send` broadcasts.
  - *Hackathon scope:* the dealer is trusted, and both FROST rounds run in one process over separate share files. *Production:* DKG, and each signer on their own device relaying through `frostd`. The PCZT interface and the cryptography are unchanged.
- **Runs through the saga engine like any payout.** The route planner produces `ledger.reserve → near.swap → zcash.shieldedBatch` on testnet, and `ledger.reserve → across.bridge (Tempo→Base) → near.swap (Base USDC→ZEC) → zcash.shieldedBatch` on mainnet (NEAR Intents has no Tempo market). The same engine, ledger, compensation rules and reconciliation apply. `privacy: "shielded"` changes only the path.
- **`near.swap` (funding):** prices with a **live NEAR Intents 1Click quote** (USDC→ZEC, delivered straight to the vault's unified address). Checked 30 Sep: $50 bought 0.0348 ZEC with a 150-second estimate. On testnet the Tempo leg is real (treasury → swap escrow, batch reference as memo) and delivery is real testnet ZEC into the FROST vault, sized from the live quote. Bookings convert the customer's pathUSD hold into a ZEC liability through a `usd-zec` clearing pair. Each delivery is recorded durably (`leg_artifacts`) so it is never sent twice.
- **`zcash.shieldedBatch` (approval + payment):** splits the delivered ZEC across recipients by USD share (keeping the ZIP-317 fee back), builds and proves the PCZT, then **opens an approval request and waits** until `threshold` of the vault's FROST signers approve (console buttons or API). Only then does `corridor-frost` co-sign with exactly the approving signers. It then combines, broadcasts, waits for mining, and books one ledger entry per recipient output plus the actual fee (`expense:zcash-fees`). Failures after broadcast go to `manual_review`.
- **Observer:** any wallet that holds the vault's viewing key, including an auditor's view-only wallet, emits Observations into the same reconciliation engine.

### 6.7 Reconciliation (`packages/recon`)
Observers emit `Observation {venue, externalRef, reference, amount, asset, at}`. The matcher joins observations with ledger expectations on `reference` and produces `matched`, `partial`, `unmatched` or `amount_mismatch`. It works the same way for both lanes.

### 6.8 Console (`apps/console`)
Corridor board · venue balances (including shielded, visible only to the customer) · pre-funding forecast · saga timelines · exceptions · **Disclosures** (export a viewing key per period, auditor verification view) · **Batches** (payroll or supplier CSV, then approvals, then status).

---

## 7. Networks and environments

| Leg | Hackathon environment | Notes |
|---|---|---|
| Tempo | Moderato testnet (42431), plus mainnet (4217) for the bridge demo | Faucet via `tempo_fundAddress` |
| Across | **Mainnet only for Tempo** | Micro-amounts. Needs a funded mainnet vault. |
| Solana | Devnet for development, mainnet for the bridge and ramp demo | |
| Ramp partner | Paj business API (production, micro-amounts) or mock | FossaPay is production-only (no sandbox) |
| Zcash | Testnet, Ironwood | Confirm Ironwood support in Zallet/FROST on day 1 of that track |
| NEAR Intents | Mainnet quotes, simulated on testnet | |

**Needed from Udoka:** about $30–50 of USDC to fund a mainnet demo vault (Tempo USDC.e or pathUSD), plus a Paj business API key. Keys are generated locally and never committed.

---

## 8. Build plan (13 days, revised)

| Day | Date | Milestone | Exit criteria |
|---|---|---|---|
| D1 | 29–30 Sep | Monorepo, ledger with invariants, Corridor Reference codec, Tempo testnet transfer with memo | A memo transfer shows on the Tempo explorer and is booked exactly once in the ledger |
| D2 | 1 Oct | Saga engine, route planner, Tempo observer (log filter by memo) | A public payout runs through Tempo legs with a forced-failure compensation |
| D3 | 2 Oct | Across adapter (mainnet micro), two-hop bridge legs, fill watcher | $5 goes Tempo → Base → Solana through the saga and is reconciled |
| D4 | 3 Oct | Solana memo leg, Paj adapter (or mock), webhook ingest | Partner payout closes the public saga |
| D5 | 4 Oct | **Zcash spike**: Z3/Ironwood testnet, shielded send via RPC, ZIP-32 accounts | A shielded testnet transaction from code |
| D6 | 5 Oct | Shielded batch leg (N outputs, encrypted reference), viewing-key scanner observer | A batch of 5 is reconciled through the viewing key |
| D7 | 6 Oct | FROST 2-of-3 on the batch spend (fallback: single-sig plus a separate FROST demo) | A FROST-signed batch lands |
| D8 | 7 Oct | NEAR Intents funding leg (simulated on testnet, mainnet quote) and the disclosure export | Auditor view shows only one period |
| D9–D10 | 8–9 Oct | Console: corridors, venues, forecast, recon, batches, disclosures | Full demo script runs |
| D11 | 10 Oct | Hardening, seed data, deploy | Public demo URL |
| D12 | 11 Oct | Demo video, pitch video, final deck, LOIs | Assets reviewed |
| D13 | 12 Oct | Submit | Submitted |

---

## 9. Partners: who to approach

**Ramps and payout rails (liquidity side):**

| Company | Fit | Notes |
|---|---|---|
| **Paj** (paj.cash) | ✅ Strong for NGN | Solana-native crypto → NGN bank. Business API (offramp orders, bank account registration, rates, webhooks) across Solana, Base, Ethereum and more. Consumer-leaning, so check business limits. |
| **FossaPay** | ✅ For NGN fiat rails | Neobank/fintech infrastructure: NGN virtual accounts, NGN payouts, fiat and stablecoin wallets, webhooks. Production-only, no sandbox. Chain and stablecoin details aren't public, so ask. |
| Yellow Card | ✅ Tier-1 target | Stablecoin ↔ fiat API across many African markets including NGN and KES |
| Kotani Pay | ✅ For KES | Stablecoin → mobile money off-ramp API |
| Bitnob | ✅ | Stablecoin API across NGN, KES, GHS and more |
| HoneyCoin | ✅ | Stablecoin payments and payout API, East Africa focus |
| Busha | ✅ For NGN | Nigerian exchange with business API |
| Mansa | ✅ Strategic | Stablecoin liquidity and pre-funding credit for cross-border payment companies |

**Customers (LOI targets):** Zynta, LemFi, Afriex, Nala, Grey, Cleva, Leatherback, Chipper Cash. These are EU/UK/US → Africa payout and remittance operators.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Across has no Tempo testnet | Mainnet micro-amounts, with the simulated adapter as fallback (decided) |
| Two-hop bridge latency or failure | Per-leg compensation. Funds are always in a Corridor-owned address on Base between hops. |
| Ironwood tooling immaturity (FROST, Zallet) | Day-5 spike decides. Fallback is single-sig with FROST shown separately. |
| ZEC price exposure on the shielded lane | Swap and send in one saga window, with a slippage guard and small batches in the demo |
| pathUSD depth | Per-corridor `settlementAsset` policy, with USDC.e as an alternative |

---

## 11. Build log

| Day | Status | Evidence |
|---|---|---|
| D1 | ✅ Done 29 Sep | `pnpm tempo:smoke`: Moderato `transferWithMemo`, found by indexed memo topic, booked exactly once |
| D2 | ✅ Done 30 Sep | `pnpm payout:demo`: saga runs reserve → bridge (real Tempo leg to escrow, simulated fill) → partner. A forced partner failure is compensated in reverse order with a real Tempo refund. The observer then reconciles all vault movements (4/4 matched, clearing nets to 0). |
| — | ✅ 30 Sep | **Global network:** hub-and-spoke routing (collections and payouts), 30+ currencies across Africa, Asia, the Americas and Europe, Corridor Reference v2 with currency pairs, and hub enforcement tests. Importer flows NGN → CNY/HKD/INR/AED/USD/BRL/MXN plan end to end. |
| D5–D6 | ✅ 30 Sep | **Shielded batch on Zcash testnet (Ironwood):** `pnpm zcash:spike` — one shielded tx pays 3 recipients ([de5d2562…](https://testnet.zcashexplorer.app/transactions/de5d25625a372d6d79d0b071f0727cdcf8a8718c48d69057fd060825c09d4a7b)); each reads its invoice memo (`INV-2026-10-00x / corridor:<ref>`) in its own wallet; an auditor with only the period account's viewing key sees exactly the 3 payouts (no treasury activity) and reconciles 3/3 against the ledger. Tooling: `zcash-devtool` (librustzcash, Ironwood-aware); memos need `enhance` after sync (compact blocks carry none). |
| D3 (partial) | 🔄 30 Sep | **Across adapter** (`@corridor/bridge-across`): quote → approvals + deposit → fill tracking; the same code for testnet and mainnet. **Live testnet deposit** Base Sepolia → Solana devnet, 2 USDC ([0x782d8b52…](https://sepolia.basescan.org/tx/0x782d8b52d1278892e5215a7a72bf731fa0e205a9274f38f99e0bcb9992c76e02)): the USDC was burned and **Circle's CCTP v2 attestation is complete**. The final Solana mint is restricted to Across's designated `destinationCaller` (its testnet relayer), which had not executed it after 2+ hours, so it is stuck on Across testnet infrastructure outside our control. The mainnet run (Tempo → Base → Paj, one hop) goes ahead when the ~$10 demo float lands. |
| D7 | ✅ 30 Sep | **FROST 2-of-3 vault on testnet:** `pnpm zcash:frost` — vault key exists only as shares (`corridor-frost`, RedPallas, rerandomized by each action's alpha); signer 2 alone refused; signers 1 + 3 co-signed; one Ironwood tx paid 3 recipients ([878b44b8…](https://testnet.zcashexplorer.app/transactions/878b44b81d518e5d5333f9d21e5f4d6017c6ce16afbdf484eb7a038b7edd355c)); recipients read invoice memos; auditor with the vault viewing key matched 3/3. Rust tests: any 2 of 3 verify under rk, 1 of 3 fails. Scope: trusted-dealer keygen, both rounds in one process; production = DKG + per-device signers via `frostd`. |
| D4 | ✅ 30 Sep | **Partners, webhooks, Solana leg, importer flow:** Paj adapter (OpenAPI v2: offramp, onramp, Solana USDC), Paj-shaped mock, HMAC webhook ingest over HTTP, exactly-once funding, `manual_review` on post-funding failure, collection → credit legs, Solana USDC + memo leg, and support for Base-direct payouts (one Across hop) for any partner that settles on Base; none does today. Live on Tempo testnet: `pnpm payout:demo` (5/5 matched) and `pnpm importer:demo`: ₦1,560,000 collected → 1,000 USDC into the hub → ¥7,140 paid to a Shenzhen supplier, 4/4 matched. Real Solana devnet funding turns on once the devnet vault holds USDC (after the Across testnet hop). |
| D9–D10 | ✅ 30 Sep | **Treasury console** (`pnpm console`, http://localhost:4400): KPIs (hub balances, in flight, settled via partners, saga outcomes, reconciliation rate), a hub-and-spoke network map with live planned routes, one-click live flows (EUR→NGN payout, forced partner failure with on-chain compensation, importer ₦ → supplier ¥), a settlement timeline with explorer links per step, the corridor board, a 7-day pre-funding forecast, venue balances (Tempo, Solana, partners, Zcash, with clearing netting to zero), **cross-chain reconciliation** (Tempo + partner webhooks + Zcash viewing-key observations: 25/25 matched), the shielded lane (FROST 2-of-3 vault, Ironwood batches with encrypted invoice memos, FROST vs single-key per batch), and an **auditor disclosure export** (vault viewing key: scope, what it reveals, how to verify). Local demo only: the disclosure and action endpoints need authentication before any hosted deployment. |
| D8 + #1 | ✅ 30 Sep | **Shielded lane through the saga engine, live:** the console action "Pay 3 suppliers privately" planned `reserve → near.swap → zcash.shieldedBatch`. The live NEAR Intents mainnet quote put $15 at 0.01022830 ZEC (~$1,466.52 per ZEC). A real Tempo leg left the treasury (`0xbafdbde3…`), and real testnet ZEC was delivered into the FROST vault ([1f05d641…](https://testnet.zcashexplorer.app/transactions/1f05d6415ad694bdc3ecffc06ef57eb9b859b2fbc1c5724601faf5bf806ee720)). The batch then **held with 1 approval**, and after signers 1 + 3 approved it was co-signed and broadcast ([ba4e845b…](https://testnet.zcashexplorer.app/transactions/ba4e845b81b7d6faf350fd01cf967d9d35d717d5bc3eb455eb48ee945b3c38c7)): 3 recipients, 20,000-zat fee booked as an expense. **Real Solana devnet partner funding** with the Corridor memo in the Memo program logs ([nDGHfRgM…](https://explorer.solana.com/tx/nDGHfRgMgK1Xc8gjE3bqUvgfp5qP13HnP6nTtLQGBSqaLLtdDfg2nXYPEzbHfcwpYjv1xQFedMcRh3KkJyRZicH?cluster=devnet)). Cross-chain reconciliation: **31/31 matched** (Tempo 17, partners 4, Zcash 10). |
| Gaps | ✅ 1 Oct | **Vault accounting from the chain.** Tempo charges each fee as a TIP-20 transfer from the payer to the Fee Manager (`0xfeec…`), so the vault observer now reports those transfers and plain deposits alongside memo transfers. `bookVaultMovements` books fees paid by a vault to `expense:gas` and deposits from approved funding sources (testnet faucet mints from the zero address; owner top-up wallets via `CORRIDOR_FUNDING_SOURCES` on mainnet) to `equity:owner`, each keyed by its log so it is booked exactly once. Any other deposit without a reference is never credited and stays "unreferenced" for review. `checkVaults` compares each vault's on-chain balance with the ledger, and the console replays the treasury's whole history from its first funded block (found by bisecting historical balances). Live on Moderato: **treasury on-chain 1,000,051.994555 pathUSD = ledger 1,000,051.994555 pathUSD**, 10 fees booked (0.005445 pathUSD), reconciliation **45/45 matched** (Tempo 30, partners 5, Zcash 10). |
| D11 | ✅ 1 Oct | **Public demo:** [corridorapp.udokaam.dev/console](https://corridorapp.udokaam.dev/console/). `pnpm console:snapshot` records every console API response from live testnet runs into `apps/site/public/console/`, next to the console page in replay mode, and refuses to publish if any value from `.env.local` or `.keys/` appears in the data. The flow buttons open the recorded run of each flow with its explorer links (Tempo, Solana devnet funding, Zcash delivery and FROST batch). The auditor disclosure exports the testnet viewing key, so anyone can verify the shielded payouts. Deployed with the landing page through GitHub Pages. |

**Known gaps (next up):**
- **Solana and Base gas.** Tempo vault gas is booked from the chain; SOL and Base ETH fees on the egress and relay wallets are not yet.
- **Lease fencing.** A worker whose lease expired mid-leg could still finish its call. Legs are idempotent via the memo lookup, but a fencing token on bookings would make this airtight.
