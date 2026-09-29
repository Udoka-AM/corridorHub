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

1. **Public corridor, EUR → NGN.** Quote, then settle on Tempo (memo), bridge live Tempo → Base → Solana through Across, then pay out with a ramp partner, then run a three-way reconciliation.
2. **Shielded lane, B2B supplier batch and contributor payroll.** One batch of N private payouts funded from the same Tempo vaults and paid in **one Ironwood shielded transaction**. It is approved with FROST 2-of-3 and disclosed to an auditor through a viewing key scoped to the customer and the period.
3. **One ledger, one saga engine and one reconciliation engine** serve both lanes.
4. **Treasury console** with balances per corridor **and per venue** (Tempo, Solana, partner fiat, Zcash shielded), the pre-funding forecast, the exceptions queue and disclosure exports.

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
byte 0      version (0x01)
byte 1      kind   (0x01 payout · 0x02 batch · 0x03 batch item · 0x04 sweep)
byte 2      corridor id
byte 3      flags  (bit0 shielded)
bytes 4–19  payout / batch id (UUIDv7, 16 bytes)
bytes 20–27 customer id hash (8 bytes, truncated keyed hash)
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

### 6.5 Solana and ramp legs (`packages/chain-solana`, `packages/partners`)
- `@solana/kit`, USDC SPL transfer plus a Memo instruction carrying the Corridor Reference.
- Partner adapter interface: `quote()`, `createPayout()`, `status()`, `verifyWebhook()`. First adapter: **Paj** (Solana USDC → NGN bank, business API with offramp orders and webhooks). The mock adapter follows the same interface.

### 6.6 Shielded legs (`packages/chain-zcash`, Rust sidecar `services/zcash`)
- **Z3 stack** (Zebra, Zaino, Zallet) on Zcash testnet, targeting the **Ironwood** pool. Orchard has been sealed since NU6.3 in July 2026.
- **Account model:** ZIP-32 account per `(customer, period)`. Exporting a viewing key discloses only that customer's period.
- **Batch payout:** one shielded transaction with N outputs, each carrying the encrypted Corridor Reference and invoice ref.
- **FROST 2-of-3** (RedPallas) authorizes the batch spend: customer approver, customer finance lead, and Corridor as co-signer.
- **Funding leg:** pathUSD/USDC to ZEC through NEAR Intents (mainnet only, since there is no testnet liquidity). On testnet it is simulated behind the real API shape. FX exposure is bounded by an immediate swap-and-send window.
- **Observer:** a viewing-key scanner feeds the same reconciliation engine.

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
