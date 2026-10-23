import { chainOfDomain, type CctpNetwork } from "./domains.ts";

/**
 * Circle's attestation service. After a burn, Circle observes the source
 * chain and signs the message; the destination will not mint without that
 * signature. So a transfer is two recorded steps — burn, then mint — with a
 * wait in between, which is exactly the shape the saga engine expects.
 */

const IRIS: Record<CctpNetwork, string> = {
  mainnet: "https://iris-api.circle.com",
  testnet: "https://iris-api-sandbox.circle.com",
};

export type AttestationStatus = "pending_confirmations" | "complete" | string;

export interface CctpMessage {
  /** The message bytes the destination replays, hex. */
  message: `0x${string}`;
  /** Circle's signature over it, hex. */
  attestation: `0x${string}`;
  status: AttestationStatus;
  eventNonce?: string;
  /** Present once Circle has decoded the message. */
  decodedMessage?: {
    sourceDomain?: string;
    destinationDomain?: string;
    amount?: string;
    mintRecipient?: string;
  };
}

export class IrisError extends Error {
  constructor(message: string, readonly status?: number, readonly retryable = false) {
    super(message);
  }
}

export interface IrisOptions {
  network: CctpNetwork;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Circle requires an API key on some plans; sent as a bearer token when set. */
  apiKey?: string;
}

export class Iris {
  private readonly http: typeof fetch;

  constructor(private readonly opts: IrisOptions) {
    this.http = opts.fetch ?? fetch;
  }

  private get baseUrl(): string {
    return (this.opts.baseUrl ?? IRIS[this.opts.network]).replace(/\/$/, "");
  }

  /**
   * Messages Circle has seen for one burn transaction. Returns an empty list
   * while Circle has not indexed it yet, which is not an error.
   */
  async messages(args: { sourceDomain: number; transactionHash: string }): Promise<CctpMessage[]> {
    chainOfDomain(args.sourceDomain); // reject a domain Corridor does not know before calling out
    const url = `${this.baseUrl}/v2/messages/${args.sourceDomain}?transactionHash=${encodeURIComponent(args.transactionHash)}`;
    const res = await this.http(url, {
      headers: this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : undefined,
    });
    // Circle answers 404 until it has indexed the burn.
    if (res.status === 404) return [];
    if (res.status === 429) throw new IrisError("Circle rate limit; back off before retrying", 429, true);
    if (res.status >= 500) throw new IrisError(`Circle attestation service error ${res.status}`, res.status, true);
    if (!res.ok) throw new IrisError(`Circle refused the attestation request: ${res.status} ${await res.text()}`, res.status);
    const body = (await res.json()) as { messages?: CctpMessage[] };
    return body.messages ?? [];
  }

  /** The attested message for a burn, or null while Circle is still confirming. */
  async attested(args: { sourceDomain: number; transactionHash: string }): Promise<CctpMessage | null> {
    const found = await this.messages(args);
    return found.find((m) => m.status === "complete" && m.attestation && m.attestation !== "0x") ?? null;
  }

  /**
   * Wait for the attestation. Circle's own guidance is to poll every 5
   * seconds; its limit is 40 requests a second and going over blocks for five
   * minutes, so a 429 doubles the wait rather than retrying straight away.
   */
  async waitForAttestation(args: {
    sourceDomain: number;
    transactionHash: string;
    timeoutMs?: number;
    pollMs?: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<CctpMessage> {
    const pollMs = args.pollMs ?? 5_000;
    const deadline = Date.now() + (args.timeoutMs ?? 20 * 60_000);
    const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let wait = pollMs;
    while (true) {
      try {
        const message = await this.attested(args);
        if (message) return message;
        wait = pollMs;
      } catch (e) {
        if (!(e instanceof IrisError) || !e.retryable) throw e;
        wait = Math.min(wait * 2, 60_000);
      }
      if (Date.now() + wait > deadline) {
        throw new IrisError(`no attestation for ${args.transactionHash} within the timeout`, undefined, true);
      }
      await sleep(wait);
    }
  }
}
