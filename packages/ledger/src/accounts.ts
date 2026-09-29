import type { Asset, CorridorCode, Venue } from "@corridor/core";
import type { AccountSpec, Ledger } from "./ledger.ts";

/**
 * Named account conventions, so legs never build account ids by hand.
 * Opens accounts on first use and caches the ids.
 */
export class Accounts {
  private readonly opened = new Map<string, Promise<string>>();

  constructor(private readonly ledger: Ledger) {}

  /** What Corridor owes the customer, available to spend. */
  customer(customerId: string, corridor: CorridorCode, asset: Asset, venue: Venue) {
    return this.open({ type: "liability", ownerType: "customer", ownerId: customerId, corridor, asset, venue, noOverdraft: true });
  }

  /** Customer funds held for an in-flight payout. */
  customerHold(customerId: string, corridor: CorridorCode, asset: Asset, venue: Venue) {
    return this.open({ type: "liability", ownerType: "customer_hold", ownerId: customerId, corridor, asset, venue, noOverdraft: true });
  }

  /** A Corridor-controlled address holding real funds on a venue. */
  vault(name: string, asset: Asset, venue: Venue) {
    return this.open({ type: "asset", ownerType: "vault", ownerId: name, asset, venue, noOverdraft: true });
  }

  /** Conversion between assets (1:1 USD stablecoins, USD→ZEC, …). Nets to zero per pair over time. */
  clearing(name: string, asset: Asset, venue: Venue) {
    return this.open({ type: "clearing", ownerType: "clearing", ownerId: name, asset, venue });
  }

  revenue(name: string, asset: Asset, venue: Venue) {
    return this.open({ type: "revenue", ownerType: "revenue", ownerId: name, asset, venue });
  }

  private open(spec: AccountSpec): Promise<string> {
    const k = JSON.stringify(spec);
    let id = this.opened.get(k);
    if (!id) {
      id = this.ledger.openAccount(spec);
      this.opened.set(k, id);
    }
    return id;
  }
}
