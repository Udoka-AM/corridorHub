import { money, type Asset, type Observation, type Venue } from "@corridor/core";
import type { Accounts, Ledger } from "@corridor/ledger";

/**
 * Vault accounting from the chain's point of view. Memo-tagged movements are
 * booked by the legs that make them; this covers what no leg books:
 *
 *  - gas: Stellar charges each transaction's fee in XLM to its source
 *    account, so each fee is observed with the transaction that paid it and
 *    is booked against it;
 *  - funding: deposits into a vault from an approved funding source (owner
 *    top-ups on mainnet, faucet mints on testnet) are owner equity.
 *
 * Anything else without a reference stays unbooked and shows up in
 * reconciliation as "unreferenced": a deposit sent without a memo may be a
 * customer's money, so it is never credited automatically.
 */

export interface VaultRef {
  /** Ledger vault name, e.g. "treasury". */
  name: string;
  address: string;
  asset: Asset;
  venue: Venue;
}

export interface VaultBookingOptions {
  vaults: VaultRef[];
  /** Addresses whose deposits are owner funding. The zero address covers testnet faucet mints. */
  fundingSources: string[];
  /** Where fees go on this venue (a pseudo-address, since Stellar, Solana and Base fees have no payee account). */
  feeCollector: string;
  /** Other costs a vault pays, by pseudo-address → expense name, e.g. Solana account rent. */
  expenses?: Record<string, string>;
}

export interface VaultBookingResult {
  gas: number;
  /** Bookings to the other expenses in `expenses` (e.g. account rent). */
  other?: number;
  funding: number;
  /** Fee and funding movements that could not be booked yet (e.g. would overdraw the vault). */
  failed: { externalRef: string; error: string }[];
}

const lower = (a?: string) => a?.toLowerCase();

export async function bookVaultMovements(
  ledger: Ledger,
  accounts: Accounts,
  observations: Observation[],
  opts: VaultBookingOptions,
): Promise<VaultBookingResult> {
  const vaults = new Map(opts.vaults.map((v) => [lower(v.address)!, v]));
  const sources = new Set(opts.fundingSources.map(lower));
  const collector = lower(opts.feeCollector);
  const result: VaultBookingResult = { gas: 0, funding: 0, failed: [] };

  // Chain order, so a top-up is booked before the fees it pays for.
  const ordered = observations
    .filter((o) => !o.reference)
    .sort((a, b) => Number((a.blockNumber ?? 0n) - (b.blockNumber ?? 0n)) || logIndex(a) - logIndex(b));

  for (const o of ordered) {
    const payer = vaults.get(lower(o.from)!);
    const payee = vaults.get(lower(o.to)!);
    const sameVenue = payer && payer.asset === o.asset && payer.venue === o.venue;
    const otherExpense = sameVenue ? Object.entries(opts.expenses ?? {}).find(([addr]) => lower(addr) === lower(o.to))?.[1] : undefined;
    const isGas = sameVenue && (lower(o.to) === collector || otherExpense !== undefined);
    const isFunding = payee && sources.has(lower(o.from)) && payee.asset === o.asset && payee.venue === o.venue;
    if (!isGas && !isFunding) continue;
    try {
      if (isGas) {
        const vault = await accounts.vault(payer!.name, o.asset, o.venue);
        const gas = await accounts.expense(otherExpense ?? "gas", o.asset, o.venue);
        const { duplicate } = await ledger.post({
          kind: otherExpense ?? "gas",
          external: { venue: o.venue, ref: o.externalRef },
          metadata: { vault: payer!.name },
          lines: [
            { account: gas, direction: "D", money: money(o.asset, o.amount) },
            { account: vault, direction: "C", money: money(o.asset, o.amount) },
          ],
        });
        if (!duplicate) {
          if (otherExpense) result.other = (result.other ?? 0) + 1;
          else result.gas++;
        }
      } else {
        const vault = await accounts.vault(payee!.name, o.asset, o.venue);
        const owner = await accounts.equity("owner", o.asset, o.venue);
        const { duplicate } = await ledger.post({
          kind: "vault.funding",
          external: { venue: o.venue, ref: o.externalRef },
          metadata: { vault: payee!.name, from: o.from },
          lines: [
            { account: vault, direction: "D", money: money(o.asset, o.amount) },
            { account: owner, direction: "C", money: money(o.asset, o.amount) },
          ],
        });
        if (!duplicate) result.funding++;
      }
    } catch (err) {
      result.failed.push({ externalRef: o.externalRef, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return result;
}

export interface VaultCheck {
  vault: string;
  asset: Asset;
  venue: Venue;
  onchain: bigint;
  ledger: bigint;
  /** On-chain minus ledger: positive means funds the books don't know about. */
  diff: bigint;
  status: "balanced" | "drift";
}

/**
 * The completeness check memo matching can't give: does each vault's real
 * balance equal what the ledger says it holds?
 */
export async function checkVaults(
  accounts: Accounts,
  ledger: Ledger,
  vaults: (VaultRef & { onchain: bigint })[],
): Promise<VaultCheck[]> {
  const out: VaultCheck[] = [];
  for (const v of vaults) {
    const booked = (await ledger.balance(await accounts.vault(v.name, v.asset, v.venue))).amount;
    const diff = v.onchain - booked;
    out.push({ vault: v.name, asset: v.asset, venue: v.venue, onchain: v.onchain, ledger: booked, diff, status: diff === 0n ? "balanced" : "drift" });
  }
  return out;
}

function logIndex(o: Observation): number {
  const i = Number(o.externalRef.split(":").at(-1));
  return Number.isFinite(i) ? i : 0;
}
