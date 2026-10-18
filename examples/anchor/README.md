# A local receiving anchor

Stellar's own [Anchor Platform](https://developers.stellar.org/docs/platforms/anchor-platform), configured as a **receiving SEP-31 anchor**, so Corridor's `SepAnchor` can be exercised against a real SEP server over the network instead of an in-process stub.

No anchor is signed, so this is the closest thing to a real counterparty that is entirely in our hands. Testnet only, and not a production configuration.

```bash
./up.sh                                        # or: ANCHOR_SEP_PORT=8180 ./up.sh
CORRIDOR_ANCHOR_BASE_URL=http://localhost:8080 \
CORRIDOR_ANCHOR_PLATFORM_URL=http://localhost:8085/ \
CORRIDOR_PAYOUT_CURRENCY=USD \
  pnpm stellar:payout
./down.sh
```

`up.sh` creates and funds two testnet accounts with the repo's own Stellar tooling — the SEP-10 signing key and the account that receives the funding payment — fills the config templates, starts the stack and waits for SEP-1 to answer. Keys land in `.env` (gitignored), which `docker compose` reads on its own, so `docker compose logs -f platform` works afterwards.

## What a run exercises

Everything Corridor does on a SEP-31 payout, against a server it does not control:

| Step | What is proven |
|---|---|
| **SEP-1** | `stellar.toml` discovery, over HTTP at a base URL that is not the home domain |
| **SEP-10** | The anchor's challenge is **verified before the vault signs it** — built by the anchor's own `SIGNING_KEY`, naming this vault, on the expected network — and the JWT is cached |
| **SEP-38** | A firm quote, `stellar:native` sold for `iso4217:USD`, `context: "sep31"` |
| **SEP-31** | An order opened with the quote, the beneficiary fields and the Corridor Reference; the anchor returns its receiving account and **its own memo** |
| **The funding payment** | A real Stellar payment carrying the **anchor's** memo, not the Corridor Reference ([ADR 0003](https://corridor.udokaam.dev/decisions/0003-reference-in-memo-hash)) |
| **The anchor's observer** | The anchor sees the payment on-chain by itself and advances the transaction |
| **Polling to completion** | SEP-31 has no webhook, so the saga polls `GET /transactions/{id}` |
| **The books** | Every movement booked double-entry, invariants clean, the customer's balance closed |

A recorded run is on the [evidence page](https://corridor.udokaam.dev/status/evidence#against-a-real-sep-server).

## What is a stand-in, and what is not

- **Real:** every SEP exchange, the Stellar payment, the anchor's on-chain observation, the saga and the ledger.
- **A stand-in:** no local currency moves. `CORRIDOR_ANCHOR_PLATFORM_URL` lets the run tell the anchor "the beneficiary has been paid" through its Platform API, which a real anchor does itself, off its own rail, when the money lands. Leave it unset against a real anchor.

## Why XLM and USD

**XLM**, because a funded testnet USDC trustline needs an issuer faucet. Switching is `config/assets.yaml.template` plus a trustline on both the anchor's distribution account and Corridor's treasury:

```yaml
- id: stellar:USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

**USD**, because the Anchor Platform's stock reference server prices a fixed pair table and `stellar:native → iso4217:USD` is in it. KES — Corridor's first corridor — is not. Serving another currency means either editing `assets.yaml` and running your own business server behind `CALLBACK_API_BASE_URL`, or using a pair the reference server already prices. The run against the stand-in `MockPartner` uses KES, so both are covered.

## Layout

| | |
|---|---|
| `docker-compose.yaml` | The stack, trimmed from the Anchor Platform's own quick-run file. The SEP-24 interactive UI is left out: Corridor is a sending anchor and never uses it. |
| `dev.env` | Platform configuration. SEP-1, 10, 12, 31 and 38 on; SEP-6, 24 and 45 off. |
| `config/*.template` | Filled by `up.sh` with the generated accounts and the chosen port. The filled files are gitignored. |
| `keys.ts` | Creates and funds the two testnet accounts, so the Stellar CLI is not needed. |

## Ports

`ANCHOR_SEP_PORT` (default 8080) moves the SEP server, and the SEP-1 endpoints and the SEP-10 home domain follow it. `up.sh` refuses to start if the port is already taken — worth having, because a clash is easy to miss: `curl` may prefer IPv6 and reach Docker while an IPv4-first client like Node reaches whatever else is listening. `ANCHOR_PLATFORM_PORT` (8085) and `ANCHOR_REFERENCE_PORT` (8091) move the other two.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `no stellar.toml at http://localhost:8080` while `curl` works | Something else holds IPv4 `127.0.0.1:8080`. Use `ANCHOR_SEP_PORT`. |
| `'rate.buy_amount' has incorrect number of significant decimals` | `significant_decimals` in `assets.yaml` does not match what the business server quotes. |
| `funding_method cannot be empty` | The asset's `funding_methods` are missing from `assets.yaml`; Corridor reads them from `GET /sep31/info`. |
| The order never leaves `pending_sender` | The anchor has not seen the funding payment. Check `docker compose logs platform | grep Observer`. |
| `reference-server` exits on startup | A required block is missing from `reference-config.yaml`; its loader wants `sep24` even when SEP-24 is off. |

The Anchor Platform is third-party software under its own licence; nothing here is affiliated with or endorsed by anyone.
