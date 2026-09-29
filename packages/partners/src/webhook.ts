import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC-SHA256 webhook signatures over `{timestamp}.{raw body}`, versioned as
 * `v1=<hex>`. This is Paj's scheme, and Corridor uses the same one for its
 * own mock partner and for the webhooks Corridor sends to its customers.
 */

export const MAX_WEBHOOK_AGE_SECONDS = 300;

export function signWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  timestampHeader: string | undefined,
  signatureHeader: string | undefined,
  now: Date = new Date(),
): boolean {
  if (!timestampHeader || !signatureHeader) return false;
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > MAX_WEBHOOK_AGE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestampHeader}.${rawBody}`).digest("hex");
  // A header may carry several schemes during a rotation ("v1=…, v2=…"); accept any v1 match.
  return signatureHeader
    .split(/[,\s]+/)
    .filter((part) => part.startsWith("v1="))
    .some((part) => {
      const received = part.slice(3);
      return received.length === expected.length && timingSafeEqual(Buffer.from(received), Buffer.from(expected));
    });
}

/** Header lookup that tolerates any casing (Node lowercases, fetch preserves). */
export function header(headers: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : undefined;
}
