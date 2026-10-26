/**
 * Every API failure has a stable machine-readable `code`, so an app or an
 * agent can act on it without parsing the message.
 */
export type RampErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "quote_expired"
  | "quote_used"
  | "spending_limit"
  | "unsupported"
  | "conflict"
  | "transaction_mismatch"
  | "partner_error"
  | "chain_error"
  /** The deployment does not offer this lane — a missing signer or fee payer, not a bad request. */
  | "not_configured"
  | "rate_limited";

const STATUS: Record<RampErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  invalid_request: 400,
  quote_expired: 409,
  quote_used: 409,
  spending_limit: 402,
  unsupported: 422,
  conflict: 409,
  transaction_mismatch: 422,
  partner_error: 502,
  chain_error: 502,
  not_configured: 501,
  rate_limited: 429,
};

export class RampError extends Error {
  readonly status: number;
  constructor(
    readonly code: RampErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.status = STATUS[code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}
