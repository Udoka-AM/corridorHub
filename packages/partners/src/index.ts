import type { Fiat } from "@corridor/core";
import type { PartnerChain, RampPartner } from "./types.ts";

export * from "./mock.ts";
export * from "./paj.ts";
export * from "./sep.ts";
export * from "./types.ts";
export * from "./webhook.ts";

/** Picks the partner for a spoke. First registered partner that covers the currency and chain wins. */
export class PartnerRegistry {
  private readonly partners: RampPartner[] = [];

  register(partner: RampPartner): this {
    this.partners.push(partner);
    return this;
  }

  get(id: string): RampPartner {
    const p = this.partners.find((x) => x.id === id);
    if (!p) throw new Error(`no partner ${id}`);
    return p;
  }

  forPayout(currency: Fiat, chain?: PartnerChain): RampPartner {
    const p = this.partners.find((x) => x.payoutCurrencies.includes(currency) && (!chain || x.chains.includes(chain)));
    if (!p) throw new Error(`no payout partner for ${currency}${chain ? ` on ${chain}` : ""}`);
    return p;
  }

  forCollection(currency: Fiat, chain?: PartnerChain): RampPartner {
    const p = this.partners.find((x) => x.collectionCurrencies.includes(currency) && (!chain || x.chains.includes(chain)));
    if (!p) throw new Error(`no collection partner for ${currency}${chain ? ` on ${chain}` : ""}`);
    return p;
  }

  all(): readonly RampPartner[] {
    return this.partners;
  }
}
