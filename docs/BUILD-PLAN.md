# Corridor build plan · 18–24 October 2026

This is the working plan for the week. It is written so that an engineer or an agent who has never seen this repository can read this one file, understand the whole body of work, pick up any task, and know when it is done.

Read in this order if you are new: this file → [`README.md`](../README.md) → [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) → the two test files named in §4.

---

## 1. The goal and the clock

Corridor is being submitted to **Stellar Community Fund #46, Open Track**, asking about **$140K**.

| Date | What |
|---|---|
| **Sat 17 Oct 2026** | Today. Code conversion to Stellar is done and pushed; docs site and landing page rewritten (PR #1) |
| **Sun 18 – Sat 24 Oct** | **This plan.** Close the build gaps that are inside our control |
| Sun 25 Oct – Fri 6 Nov | Submission assets: 3-minute video, budget, referral, written application |
| **Sat 7 Nov** | Target submission date |
| Sun 8 Nov | SCF #46 submissions close |
| 11–18 Nov | Panel review · 23 Nov – 3 Dec community vote |

**The week's job is not to build everything.** It is to make the evidence a reviewer can check as strong as it honestly can be in seven days, and to leave every remaining gap stated rather than hidden. Two things decide the outcome and only one is in our control:

- **In our control:** how much of the system actually runs, against real infrastructure, reproducibly, with a green CI badge.
- **Not in our control:** whether a licensed anchor signs. Chase it in parallel (§9), never block on it.

### Hard scope rules (these are not negotiable)

1. **Stellar-only budget and scope.** No Tempo and no Solana line items in anything SCF-facing, even though both exist in the portfolio. Solana appears in this repo *only* as the naira exception, and it is described that way.
2. **No language implying SDF endorsement**, anywhere — code comments, docs, site, video, application.
3. **Nothing from the prediction-market projects** (Agent Circle, RetinaOS) touches this repo or the submission. SCF rules make gambling ineligible.
4. **Never claim what is not built.** This is the repository's single most valuable property with a technical panel. Every gap in §5 is stated in the README, the architecture doc and the docs site. If you build something, move it between tables in §4 and §5 in the same PR. If you cannot finish something, say so in the PR rather than softening the claim.

---

## 2. What Corridor is, in one page

Corridor is the **payment ledger and router** that licensed payment companies run **in their own environment, on their own keys**, for cross-border stablecoin payouts. It does not hold funds, provide liquidity or carry licences — anchors and licensed operators do that. Corridor runs payouts across them exactly once and keeps one set of books that matches the chain.

**Stellar is the settlement hub.** Two properties of Stellar decide the shape of everything:

1. **`MEMO_HASH` is exactly 32 bytes**, which is exactly a Corridor Reference. The reference travels whole, inside the signed transaction, so reconciliation is a join rather than an inference.
2. **Anchors settle on Stellar itself.** The fiat spoke touches the hub directly, so the common payout path is `ledger.reserve → partner.payout` with no bridge in it.

Every flow is one of two shapes:

- **Collection** — local currency comes in through an anchor and is credited to the customer's USDC balance on the hub.
- **Payout** — the customer's balance on Stellar goes out to a spoke, where an anchor pays local currency.

A cross-border payment is a collection followed by a payout, with the customer's hub balance sitting between them. Because every anchor speaks the same SEPs, adding a region is a home domain and an asset rather than an integration: **N integrations instead of N×N corridors**.

Adoption is two-stage: **read-only** first (watch the Stellar accounts a company already runs, match its own payout records, no keys, nothing moves), then **routing** (payouts on the company's own signer).

Corridor order: **KES → XOF → TZS → NGN** (through a licensed partner until a naira anchor exists) → Ghana, South Africa.

---

## 3. Repo map

```text
packages/
  core/            Venues, 32 fiat currencies, assets at 7 dp, Money, the Corridor Reference codec, Observation
  chain-stellar/   The hub: Horizon client, asset registry by issuer, payments with MEMO_HASH, observer, trustlines
  routing/         Route graph and planner; the hub is enforced here
  saga/            Durable saga engine: leases, fencing tokens, reverse-order compensation
  ledger/          Double-entry ledger with invariants (PGlite locally / Postgres in production)
  partners/        RampPartner interface, SepAnchor (SEP-1/10/12/38/31), Paj adapter, MockPartner
  legs/            The leg implementations the saga executes
  recon/           Reconciliation, read-only matching, vault accounting
  signer/          Signer interfaces: local, AWS KMS (secp256k1), Turnkey (both curves)
  webhooks/        Partner event store, webhook verification, a webhook server
  chain-solana/    The one spoke off the hub (naira), until a Stellar naira anchor exists
  chain-evm/       Base, for USDC inflows
apps/
  site/            The public landing page (React + three.js)
  docs/            The documentation site (48 Mintlify MDX files)
  console/         The Tempo prototype's console, kept as a static replay. No server.
scripts/           stellar-wallets · stellar-smoke · stellar-payout · watch-report · runtime · signers · env
examples/          Recorded runs and sample read-only configs
docs/              ARCHITECTURE.md (authoritative) · this file
```

**Commands**

```bash
pnpm install
pnpm test                 # 145 tests, 18 files, no network
pnpm typecheck            # tsc -b
pnpm stellar:wallets      # create and fund two testnet vaults (Friendbot)
pnpm stellar:smoke        # a real payment, reference read back off Horizon
pnpm stellar:payout       # the whole saga: route, reserve, fund the anchor, book it
CORRIDOR_WATCH=G…,G… pnpm watch:report
pnpm --filter @corridor/site build
```

---

## 4. What is built

Verified by audit on 17 Oct 2026. "Run" means a script exercised it against Stellar testnet; "tested" means unit tests only.

### Run on Stellar testnet

| Capability | Where | Evidence |
|---|---|---|
| Payment carrying the reference in `MEMO_HASH`, read back off Horizon and decoded | `chain-stellar` · `scripts/stellar-smoke.ts` | [`175ad420…`](https://stellar.expert/explorer/testnet/tx/175ad4206f85b279831178a5ad896da123105005f265fb5c798ae3d09254781c), 17 Oct 2026 |
| A whole payout through the saga: route planned, balance reserved, order opened, funded exactly once with a real payment, booked double-entry, invariants clean | `routing` + `saga` + `legs` + `ledger` · `scripts/stellar-payout.ts` | [`88074bfa…`](https://stellar.expert/explorer/testnet/tx/88074bfac3cead1adeb75209cd9aa685bfda44589397b6990dbc92deccbdc10e), 17 Oct 2026 |
| Account creation and funding, balance reporting | `scripts/stellar-wallets.ts` | Friendbot |
| Horizon observation of watched accounts, reconciled against the ledger | `recon` · `scripts/watch-report.ts` | Runs; see the caveat in §5 |

### Built and unit-tested (128 tests, 16 files)

| Capability | Package | Tests |
|---|---|---|
| Corridor Reference codec — encode, decode, checksum, version rejection, currency pairs | `core` | 12 |
| Stellar venue — reference on a real transaction shape, issuer identity, held-key signer, Horizon `join=transactions` quirks | `chain-stellar` | 15 |
| Route planner — hub enforcement, every route shape, the shielded refusal, the off-Stellar list | `routing` | 11 |
| Double-entry ledger — balance per asset, no-overdraft, exactly-once external refs, append-only triggers, global invariants | `ledger` | 7 |
| Saga engine — compensation order, `manual_review`, lease fencing under a real race | `saga` | 6 |
| Legs — payout funding, anchor rounding, slow fills, crash recovery, collect and credit | `legs` | 6 |
| SEP anchor adapter — discovery, the challenge check before signing, quote, order, status mapping | `partners` | 8 |
| Partner adapters and registry | `partners` | 11 |
| Signers — local, AWS KMS DER/low-s/recovery, Turnkey | `signer` | 10 |
| Webhooks — HMAC, replay window, exactly-once order status | `webhooks` | 5 |
| Read-only matching — reference and heuristic, short, missing, unexpected, CSV | `recon` | 5 |
| Vault accounting — fees, funding, the on-chain-vs-ledger check | `recon` | 5 |
| Solana and Base registries and watchers | `chain-solana`, `chain-evm` | 13 |

### Documentation and surfaces

| | State |
|---|---|
| `README.md`, `docs/ARCHITECTURE.md` | Rewritten for Stellar, authoritative |
| `apps/docs` — 48 MDX files, 12 ADRs, 8 diagram pairs | Rewritten for Stellar (PR #1) |
| `apps/site` — landing page | Rewritten for Stellar (PR #1) |
| `apps/console` | The Stellar treasury console: six read-only panels over the ledger and sagas. The Tempo replay is kept beside it at `public/prototype.html`, labelled. |

---

## 5. What is left

Everything below is a real gap. The right-hand column is what it would take.

### A. Defects found in the 17 Oct audit — **fixed 17 Oct**

| # | Defect | Why it mattered | What landed |
|---|---|---|---|
| **D1** ✅ | **No code path could honour an anchor's own memo.** `chain-stellar` only ever built `Memo.hash(...)`. `PartnerOrder.fundingMemo` / `fundingMemoType` were carried through the interface but nothing could send with them. | It blocked **every real SEP-31 payout**: a receiving anchor assigns the memo on the funding payment, so without this, funding an anchor order was impossible. | `transferWithMemo` (hash, text and id) with `transferWithReference` expressed in terms of it; `findTransfersByMemo` so the duplicate check works for any memo; `fundingMemoFor`; and `stellarAnchorFunder` in `legs`, a reusable funder that carries the anchor's memo and stays retry-safe. `MockPartner` now assigns a funding memo on Stellar orders, so the script exercises the real path. Proven on testnet: [`ac025984…`](https://stellar.expert/explorer/testnet/tx/ac025984a302d98edbb771bcf7f39f21fa83134938e10510e76d71ccba33bf89), `memo_type: text`. |
| **D2** ✅ | **`SepAnchor.discover()` hardcoded `https://`.** | Blocked pointing Corridor at a local Anchor Platform on `http://localhost:8080` — which is how W1 gets a real SEP-31 run. | `baseUrl?: string` on `SepAnchorOptions`, defaulting to `https://{domain}`. `domain` stays the SEP-10 `home_domain`. |

Also corrected while in there: `PartnerOrder.usdcAmount` was documented as 6 dp when every adapter treats it as the hub's 7 dp.

**W1-1 and W1-3 below are therefore already done.** W1 now starts at W1-2.

### B. Not built

| # | Gap | Blocker | Estimate |
|---|---|---|---|
| **B1** | **No signed anchor.** No real local currency has moved on Stellar. | A third party. The SEP path itself is no longer the gap: it has run end to end against Stellar's own Anchor Platform (`examples/anchor`). What is missing is a licensed counterparty. | Weeks (theirs) |
| **B2** | **SEP-6 collections.** `openCollection` checks for `TRANSFER_SERVER` then raises. | Deliberate: no signed anchor has exercised the flow. | 2–3 days once an anchor exists |
| **B3** | **The `cctp.transfer` leg.** Declared in the route graph, not written. Mainnet naira payouts do not run. | Nothing, but see §8 — we are deliberately not doing this. | 3–5 days |
| **B4** | **The `stellar.pathPayment` leg.** The planner produces the edge; no implementation. A payout cannot be funded from an EURC or MGUSD balance. | Nothing. | 1 day |
| **B5** | **MGUSD, PYUSD, USDT issuers unset** in `STELLAR_ISSUERS`. | Each must be verified against the issuer's own published `stellar.toml`. | 1–2 hours total |
| **B6** | **No treasury console** for Stellar. | The engines produce the data; it is a UI. | 1–2 weeks |
| **B7** | **HTTP API: built as Ramp.** `@corridor/ramp` serves the hosted API (`pnpm ramp:serve`) and `@corridor/ramp-sdk` is its client; see ADR 0013. Its orders run on `planRoute` and the saga engine and settle from the chain; it is specified in `packages/ramp/openapi.json` and runs on Postgres with per-key rate limits, key expiry and rotation, and webhook dead letters. CI (`.github/workflows/ci.yml`) runs typecheck, the tests on PGlite and Postgres, the docs check, the OpenAPI check and the site build on every PR. The Hub's own operator API over the saga and recon remains declared and not built. | Nothing. | Done for Ramp |
| **B8** | **No mainnet run.** Code paths are identical; nothing has run on Stellar mainnet. | Needs a funded mainnet account and, to be meaningful, an anchor. | — |
| **B9** | **The confidential lane.** `SHIELDED_VENUES` is empty; `privacy: "shielded"` is refused with that reason. | Deliberate — deferred to Stellar confidential tokens (ADR 0005). | Out of scope |

### C. Built but never exercised — library code with no entry point

These are the cheapest wins in the repo. The code exists and is tested; nothing runs it.

| # | What | Current state |
|---|---|---|
| **C1** | **`reconcileReadOnly`, `exceptions`, `readOnlyCsv`** — the read-only product, ADR 0011's "first product" | No script. `pnpm watch:report` reconciles watched accounts against the *ledger*; it never reads a payout-records CSV and never produces the exceptions queue. `examples/watch/eu-payco-demo.json` and its CSV are still Tempo/Solana-era and nothing reads them. |
| **C2** | **`bookVaultMovements` + `checkVaults`** — fees booked from the chain, on-chain balance vs ledger | Called by nothing outside their own tests. The "a vault equals the books" claim is a library function, never run on Stellar. |
| **C3** | **`trustAsset`** | Never called. No USDC trustline has ever been opened, which is why both testnet runs move XLM. |
| **C4** | **`stellarTransferLeg`, `simulatedBridgeLeg`, `partnerCollectLeg`, `ledgerCreditLeg`** | Tested; no script wires them. |
| **C5** | **`webhookServer`** | Tested; no script starts it. |
| **C6** | **Turnkey and AWS KMS signers** | Tested against stand-ins; never used against a real KMS or Turnkey org. |

### D. Repository hygiene

| # | Gap |
|---|---|
| **D3** | **No CI.** `.github/workflows/` has only a Cloudflare Pages deploy, gated on secrets that may not be set. Nothing runs `pnpm test` or `pnpm typecheck` on a PR, so the repo shows no green check. |
| **D4** | **Stale example data.** `examples/watch/eu-payco-demo.json` and `eu-payco-demo-records.csv` are Tempo/Solana-era. `examples/mainnet/payouts.json` is the prototype's record — that one is deliberate and stays. |
| **D5** | **Deployment unverified.** Whether the landing page and docs site are actually live at their URLs needs checking before anything links a reviewer to them. |
| **D6** | **`og:image`** on the landing page is still a prototype console screenshot. No Stellar visual exists to replace it. |

---

## 6. The week at a glance

Four tracks. Tracks run in parallel; within a track, order matters.

| Track | Theme | Why it earns its place |
|---|---|---|
| **W1 · Real anchor** | Make a SEP-31 payout run against a real SEP server over the network | Converts "tested against a stub" into "runs against a real anchor". The strongest single upgrade available without a signed partner. |
| **W2 · Real USDC** | Open a trustline, fund with testnet USDC, re-run both scripts in USDC | Removes the "both runs move XLM" caveat from every page of evidence. |
| **W3 · The read-only product** | Give `reconcileReadOnly` an entry point and real Stellar example data | ADR 0011 calls read-only the first product; it currently cannot be run. Cheapest credibility-to-effort ratio in the repo. |
| **W4 · Proof and hygiene** | CI, vault accounting on Stellar, issuer verification, path payment, deployment | A green check, a Δ0 vault run, and three fewer "unset" items. |

### Day by day

| Day | W1 · Anchor | W2 · USDC | W3 · Read-only | W4 · Proof |
|---|---|---|---|---|
| ~~Sat 17~~ | **W1 done**: ~~W1-1~~ ~~W1-2~~ ~~W1-3~~ ~~W1-4~~ ~~W1-5~~ ✅ | — | — | — |
| **Sun 18** | — | W2-1 trustline | W3-1 `watch:report` v2 | W4-1 CI · W4-2 issuers |
| **Mon 19** | — | W2-2 faucet + USDC smoke | W3-2 Stellar example data | — |
| **Tue 20** | — | W2-3 USDC payout | W3-3 docs + evidence | W4-3 vault accounting |
| **Wed 21** | — | — | — | W4-4 path payment leg |
| **Thu 22** | Slack: the anchor hunt (§9), or pull W4-4 forward | | | |
| **Fri 23** | Slack | | | |
| **Sat 24** | W-wrap: re-verify everything, update README / ARCHITECTURE / docs site / this file, tag | | | |

**Parallelism rule for agents:** one agent per track. W1 and W2 both touch `packages/chain-stellar` and `scripts/` — W1 owns `packages/partners/src/sep.ts` and the `fund` callback, W2 owns `scripts/stellar-wallets.ts` and asset selection. Coordinate on `packages/chain-stellar/src/index.ts`: W1 adds the memo function (D1), W2 only calls `trustAsset`. Land W1-3 before W2-3.

---

## 7. The tasks

Every task has an ID, a definition of done, and the files it touches. Do not mark one done without its acceptance check passing.

### W1 · Make a payout run against a real anchor

> **Goal:** `pnpm stellar:payout` opens a SEP-38 quote and a SEP-31 transaction against a SEP server reached over HTTP, funds it with a real Stellar payment carrying **the anchor's own memo**, and polls it to `completed`.
>
> **The funding half of this is done** (W1-1, W1-3). What remains is replacing the stand-in anchor with a real SEP server.

**W1-1 · Let `SepAnchor` reach a non-HTTPS host** *(fixes D2)* — ✅ **done 17 Oct.** `baseUrl?: string` on `SepAnchorOptions`, defaulting to `https://{domain}`; `domain` stays the SEP-10 `home_domain`. Three tests cover the override, the default and the error message.

**W1-2 · Run Stellar's Anchor Platform locally** — ✅ **done 17 Oct.** `examples/anchor` brings it up with `./up.sh`: two testnet accounts created and funded with the repo's own tooling (no Stellar CLI needed), config templates filled, SEP-1/10/12/31/38 on, SEP-6/24/45 off. See its README for the four configuration traps that cost time.

<details><summary>Original task</summary>
- Clone `stellar/anchor-platform`, use its `quick-run/` directory, `./ap_start.sh`. SEP-1 TOML serves at `localhost:8080`.
- Set `SEP31_ENABLED=true` and `SEP38_ENABLED=true` in `dev.env`; configure the asset in `config/assets.yaml` with `sep31.quotes_supported: true`; point `QUOTE_SERVER` at `localhost:8080/sep38` in `stellar.localhost.toml`.
- The Anchor Platform implements SEP-31 **receive-only** — which is exactly the role we need it to play. Corridor is the *sending* anchor.
- **Watch for:** doc versions differ on whether the TOML advertises `/sep12` or `/kyc` as `KYC_SERVER`. Check the TOML the running platform actually serves against what `SepAnchor` reads.
- Commit the compose file and config into `examples/anchor/` with a README so anyone can reproduce the run. Do **not** commit secrets.
- **Done when:** `curl localhost:8080/.well-known/stellar.toml` returns a TOML naming `WEB_AUTH_ENDPOINT`, `ANCHOR_QUOTE_SERVER` and `DIRECT_PAYMENT_SERVER`.
</details>

**W1-3 · Send a payment with the anchor's memo** *(fixes D1)* — ✅ **done 17 Oct.**
- `transferWithMemo` supports `hash`, `text` and `id`; `transferWithReference` is a thin wrapper over it.
- `findTransfersByMemo` generalises the join, so the duplicate check is just as strong when the memo is the anchor's rather than the reference. `findTransfersByReference` is now a wrapper too.
- `stellarAnchorFunder(opts)` in `@corridor/legs` is the reusable funding function — it picks the memo with `fundingMemoFor`, dedupes on whichever memo went out, and returns the chain ref. A deployment uses it as-is.
- `MockPartner` takes `stellarAccount` and assigns a text funding memo on Stellar orders, so `pnpm stellar:payout` exercises the anchor-memo path rather than a shortcut.
- Five tests, including a crash between sending and recording. Verified on testnet: [`ac025984…`](https://stellar.expert/explorer/testnet/tx/ac025984a302d98edbb771bcf7f39f21fa83134938e10510e76d71ccba33bf89) carries `memo_type: text`, `memo: mock-8313e798`.

**W1-4 · The run** — ✅ **done 17 Oct.** `CORRIDOR_ANCHOR_BASE_URL` switches `stellar-payout.ts` from the stand-in to `SepAnchor`; the mock stays the default. A full run completed: SEP-1, SEP-10 (challenge verified before signing), SEP-38 firm quote, SEP-31 order, a real Stellar payment carrying the anchor's `id` memo ([`ecc31ac7…`](https://stellar.expert/explorer/testnet/tx/ecc31ac72a77ff5afbb211db2f41a2e96acf83200b484ff6bf87671337666c6e)), the anchor's own observer seeing it, polling to `completed`, `paid 1538 USD at 2.1978`, invariants clean.

**Four defects in `SepAnchor` that only a real server exposed, all fixed:**

| | What was wrong |
|---|---|
| **D4** | SEP-31 `POST /transactions` was sent without `funding_method`, which the spec requires. Now read from the anchor's own `GET /sep31/info`. |
| **D5** | The receiving account was taken only from the POST reply. SEP-31 lets it arrive on `GET /transactions/{id}` instead, and an anchor may take a moment to assign it — so `openPayout` now waits for it, bounded. |
| **D6** | `amount_out`/`destination_asset` were read in one shape only, so a real anchor's order came back with no currency and a zero fiat amount — which would have been **booked**. Now reads `amount_out_asset`, the nested `{ amount, asset }` and `destination_asset`. |
| **D7** | The native asset was not expressible: `assetIds` always built `stellar:CODE:ISSUER`. Now `stellar:native`, and an issued asset with no issuer is refused rather than guessed. |

Plus: `partnerPayoutLeg` falls back to the order's receiving account when the stored link has none, and `MockPartner` returns a valid `G…` account and assigns a funding memo on Stellar orders, so the default run exercises the same path.

**W1-5 · Write it down** — ✅ **done 17 Oct.** Evidence page, the anchor integration page, the quickstart, the reviewer path and `examples/anchor/README.md`.

<details><summary>Original task</summary>
- Add the run to `apps/docs/status/evidence.mdx` under Stellar testnet, with the transaction link and the reproducing command.
- Update `apps/docs/integrations/sep-anchors.mdx`: the "no anchor is signed" warning stays, but "only ever run against an in-process stub" becomes "run against Stellar's Anchor Platform".
- Update `README.md`, `docs/ARCHITECTURE.md` §9 and §4 of this file.
</details>

### W2 · Settle in USDC, not XLM

> **Goal:** both testnet scripts move **USDC**, so no page has to carry the "it moves XLM because a trustline needs a faucet" caveat.

**W2-1 · Open the trustline** *(~2h)*
- `scripts/stellar-wallets.ts`: after funding, call `trustAsset(client, "USDC")` for each vault when the trustline is absent (C3). Idempotent — check `balances` first.
- **Done when:** `pnpm stellar:wallets` prints a USDC line for both vaults.

**W2-2 · Fund and smoke in USDC** *(~2h)*
- Get testnet USDC: Friendbot for XLM → trustline to `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` → `faucet.circle.com`, select Stellar, paste the address.
- `scripts/stellar-smoke.ts`: default to `USDC`, with `CORRIDOR_SMOKE_ASSET=XLM` as the fallback for an unfunded account. Keep the fallback — a reviewer with no faucet access must still be able to run it.
- **Done when:** `pnpm stellar:smoke` sends USDC and reads the reference back; record the transaction hash.

**W2-3 · Payout in USDC** *(~2h)* — same change in `scripts/stellar-payout.ts`; land after W1-3.
- **Done when:** the payout moves USDC and the ledger entries are in USDC at 7 dp, with no `rescale` error.

### W3 · Make read-only runnable

> **Goal:** a payment company can hand over account ids and a CSV and get an exceptions queue back. Today it cannot.

**W3-1 · `watch:report` v2** *(~half a day)*
- Take a config file argument (`pnpm watch:report examples/watch/<name>.json`) as well as `CORRIDOR_WATCH`.
- Read the config's `records` CSV into `PayoutRecord[]`, run `reconcileReadOnly`, print `summarizeReadOnly`, then `exceptions(results)`, and write `readOnlyCsv(results)` to a file.
- Keep the current ledger-reconciliation mode when no records file is given, and say which mode it is running in.
- **Done when:** the command prints a six-status summary and writes a CSV.

**W3-2 · Real Stellar example data** *(~2h, fixes D4)*
- Replace `examples/watch/eu-payco-demo.json` with a Stellar config (`{ "stellar": { "network": "testnet", "accounts": ["G…"] }, "records": "…" }`) pointing at the testnet vaults.
- Regenerate `eu-payco-demo-records.csv` from the real testnet runs, with one record deliberately short and one deliberately missing, so the output shows every status. Say in the file header that it is a sample.
- **Done when:** the committed example runs end to end against testnet and produces at least one `matched`, one `short` and one `missing`.

**W3-3 · Write it down** *(~1h)* — update `apps/docs/flows/read-only-pilot.mdx` and ADR 0011 with the real command and real output. Both currently describe the library more precisely than the script delivers; this closes that gap in the honest direction.

### W4 · Proof and hygiene

**W4-1 · CI** *(~1h, fixes D3)* — `.github/workflows/ci.yml`: on `push` and `pull_request`, Node 22 + pnpm, `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test`, `pnpm --filter @corridor/site build`. No secrets, no network beyond the registry.
- **Done when:** PR #1 shows a green check.

**W4-2 · Verify three issuers** *(~1–2h, closes B5)* — for MGUSD, PYUSD and USDT, fetch the issuer's own published `stellar.toml`, confirm the issuing account, and set it in `STELLAR_ISSUERS` with a comment naming the source and the date checked. **If an issuer cannot be verified from the issuer's own domain, leave it unset** — that is the whole point of ADR 0007. Record what you found either way.
- **Done when:** each of the three is either set with a cited source or documented as unverifiable.

**W4-3 · Vault accounting on Stellar** *(~half a day, closes C2)* — at the end of `stellar-payout.ts`, run `bookVaultMovements` (fees to `expense:gas`, Friendbot funding to `equity:owner`) and then `checkVaults`, and print the on-chain vs ledger difference per vault.
- **Done when:** the script prints `balanced` with a difference of 0 for both vaults, fees included. If it prints `drift`, that is a finding — fix the cause, do not widen a tolerance.

**W4-4 · The `stellar.pathPayment` leg** *(~1 day, closes B4)* — implement a strict-receive path payment leg in `chain-stellar` + `legs`: EURC/MGUSD → USDC over Stellar's own order books, booked through a `clearing` pair, idempotent by reference, with the received amount booked from what the network reports.
- **Done when:** a payout funded from an EURC balance plans *and runs* on testnet, and the clearing pair nets to zero. If testnet order-book depth makes a live run impossible, land the leg with tests and say exactly that.
- **Why this one and not CCTP:** path payments are Stellar-native and on-ledger. It is the feature that most clearly shows the hub being used as a hub, and it is a day rather than a week.

### W-wrap · Saturday 24 Oct

1. `pnpm test` · `npx tsc -b` · `pnpm --filter @corridor/site build` all clean.
2. Re-run all four scripts end to end from a clean clone, following only the README. Anything the README does not cover is a README bug.
3. `grep -rni "tempo\|zcash\|across\|pathusd" apps/ packages/ scripts/ examples/` — every hit must be a deliberate, labelled reference to the prototype.
4. Update §4 and §5 of this file, the README's "Not done yet" sentence, `ARCHITECTURE.md` §8–9, `apps/docs/status/evidence.mdx`, `apps/docs/status/roadmap.mdx`, `apps/docs/start/ten-minute-review.mdx`.
5. Confirm the landing page and docs site are live (D5).
6. Tag `v0.2.0-testnet`.

---

## 8. Explicitly out of scope this week

Saying why is as important as the decision.

| Not doing | Why |
|---|---|
| **`cctp.transfer`** (B3) | It serves exactly one corridor (naira), it is the most complex piece on the board, and a licensed naira anchor on Stellar removes the need for it entirely. Half-building a bridge leg to look complete is the opposite of the repository's selling point. Deferred with that reason stated. |
| **The treasury console** (B6) | One to two weeks for a UI over engines that already work. The reviewer-facing version of this is the evidence page and the CLI output, both of which we can make excellent in the same time. |
| **The HTTP API** (B7) | Nothing in the submission needs an API that the scripts do not demonstrate. Worth doing before a design partner, not before a panel. |
| **A mainnet run** (B8) | Without a signed anchor it would be a payment to ourselves with real money and no counterparty — a worse artefact than a clean testnet run against a real SEP server. |
| **The confidential lane** (B9) | Deferred to Stellar confidential tokens by ADR 0005. Building it elsewhere would mean a second set of books. |
| **A new `og:image`** (D6) | Needs a designed asset, not engineering time. |

---

## 9. In parallel, all week: the anchor hunt

This is the only thing that can turn B1 from "ours to simulate" into "ours to demonstrate", and it runs on other people's calendars. Start it Sunday, not Friday.

- **Targets, in corridor order:** Minisend (KES), lomi. (XOF), ClickPesa (TZS). Then naira through a licensed partner (Paj or Azza) — cross-chain until a Stellar naira anchor exists.
- **The ask is small:** testnet SEP-31 credentials and a sandbox `stellar.toml`. Not a contract, not a mainnet integration. That ask converts to a yes far more often.
- **What to send:** the docs site's [ten-minute review](https://corridor.udokaam.dev/start/ten-minute-review) page and the evidence page. They were written for exactly this reader.
- **Referral, separately:** a referral code from the Stellar West Africa chapter (Timothy Ovie, @Stellar_WA). 25 of 40 SCF #45 winners were referred, including 7 of 8 Open Track winners. Unreferred teams go through an AI prescreen. **Treat this as a priority task, not a nice-to-have.**
- **Open questions worth asking the chapter:** which African anchors support SEP-31 *receiving* on mainnet; whether any licensed naira anchor is live on Stellar; how to frame the Tempo prototype to reviewers.

---

## 10. After the week: 25 Oct – 7 Nov

Out of scope for this plan, listed so nobody is surprised by it.

- The written SCF application and the **3-minute video**. The video should show `pnpm stellar:smoke` and `pnpm stellar:payout` running, with the explorer open — not slides.
- The budget: **Stellar-only line items**, no Tempo or Solana work (§1).
- Tranche plan: 10% award / 20% MVP / 30% testnet / 40% mainnet, each due within 90 days of the previous.
- Any anchor that said yes in §9 folded into the submission as a named testnet integration.

---

## 11. Conventions

**Commits.** Short, imperative, describing the change in the project's own voice ("Add the SEP anchor adapter", "Run payouts on Stellar testnet from scripts"). Udoka's authorship only — **no `Co-Authored-By` and no "Generated with" lines**. Commit every meaningful step rather than batching.

**Honesty.** Covered in §1 rule 4, and it is the rule most worth re-reading. The phrase to reach for is "declared and not built", not "coming soon".

**ADR numbers are load-bearing.** Six are cited from source: 0002 (`partners/src/sep.ts`), 0003 (`core/reference.ts`, `chain-stellar/observer.ts`, `chain-stellar/index.ts`), 0005 (`core/model.ts`, `routing/index.ts`), 0008 (`core/model.ts`, `chain-stellar/observer.ts`), 0011 (`scripts/watch-report.ts`), 0012 (`chain-stellar/assets.ts`). Do not renumber or move those slugs. New decisions get 0013 onward.

**Precision.** Amounts are integer minor units at 7 decimal places — Stellar's own precision. No floats in monetary code. Conversions to a 6 dp spoke go through `rescale`, which throws rather than rounding. Never add a tolerance to a balance comparison.

**Secrets.** `.env.local` and `.keys/` are gitignored and stay that way. Nothing committed, printed or sent.

**Assumptions.** Every pricing, revenue or volume figure is a proposal, and must be labelled as one wherever it appears.

---

## 12. Risks for the week

| Risk | Likelihood | What we do |
|---|---|---|
| The Anchor Platform's SEP-31 config fights us for more than a day | Medium | Time-box W1-2 to one day. Fallback: an HTTP SEP stub we write ourselves in `examples/anchor/`, served over a real socket. Weaker than the real platform, still far stronger than an in-process fetch stub. |
| Circle's testnet faucet is rate-limited or down | Medium | Keep the XLM path working behind `CORRIDOR_SMOKE_ASSET`. Evidence stays reproducible either way. |
| No anchor replies in time | High | The plan never depends on one. W1 delivers a real SEP-31 run regardless. |
| Testnet order books too thin for a live path payment (W4-4) | Medium | Land the leg with tests and say the live run was not possible. Do not fake it. |
| Scope creep into the console or the API | Medium | §8 exists to be pointed at. |
| A found defect is worse than D1/D2 | Low | Fix it, write a test, and add it to §5A in the same PR. Finding one is a good outcome, not a setback. |
