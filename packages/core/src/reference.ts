import { createHash, createHmac, randomBytes } from "node:crypto";
import { CORRIDORS, type CorridorCode, corridorFromId } from "./model.ts";

/**
 * Corridor Reference: one 32-byte identifier that follows a payout across
 * Tempo (TIP-20 memo, an indexed event topic), Solana (SPL Memo) and Zcash
 * (encrypted output memo). Layout (docs/ARCHITECTURE.md §5):
 *
 *   0      version
 *   1      kind
 *   2      corridor id
 *   3      flags (bit0 = shielded)
 *   4–19   payout / batch id (UUIDv7)
 *   20–27  customer tag (keyed hash, 8 bytes)
 *   28–31  checksum = sha256(bytes 0–27)[0..4]
 */

export const REF_VERSION = 0x01;
export const REF_BYTES = 32;

export const RefKind = { Payout: 0x01, Batch: 0x02, BatchItem: 0x03, Sweep: 0x04 } as const;
export type RefKind = (typeof RefKind)[keyof typeof RefKind];

export type Hex = `0x${string}`;

export interface CorridorRef {
  kind: RefKind;
  corridor: CorridorCode;
  shielded: boolean;
  /** UUIDv7 of the payout, batch or batch item. */
  id: string;
  /** 8-byte keyed hash of the customer id (see `customerTag`). */
  customerTag: Uint8Array;
}

const FLAG_SHIELDED = 0b0000_0001;

export function encodeRef(ref: CorridorRef): Hex {
  if (ref.customerTag.length !== 8) throw new Error("customerTag must be 8 bytes");
  const buf = new Uint8Array(REF_BYTES);
  buf[0] = REF_VERSION;
  buf[1] = ref.kind;
  buf[2] = CORRIDORS[ref.corridor];
  buf[3] = ref.shielded ? FLAG_SHIELDED : 0;
  buf.set(uuidToBytes(ref.id), 4);
  buf.set(ref.customerTag, 20);
  buf.set(checksum(buf.subarray(0, 28)), 28);
  return toHex(buf);
}

export function decodeRef(hex: string): CorridorRef {
  const buf = fromHex(hex);
  if (buf.length !== REF_BYTES) throw new Error(`reference must be ${REF_BYTES} bytes, got ${buf.length}`);
  if (buf[0] !== REF_VERSION) throw new Error(`unsupported reference version ${buf[0]}`);
  const expected = checksum(buf.subarray(0, 28));
  if (!expected.every((b, i) => b === buf[28 + i])) throw new Error("reference checksum mismatch");
  const kind = buf[1] as RefKind;
  if (!Object.values(RefKind).includes(kind)) throw new Error(`unknown reference kind ${kind}`);
  return {
    kind,
    corridor: corridorFromId(buf[2]!),
    shielded: (buf[3]! & FLAG_SHIELDED) !== 0,
    id: bytesToUuid(buf.subarray(4, 20)),
    customerTag: buf.slice(20, 28),
  };
}

/** Returns the decoded reference, or null for memos that are not Corridor references. */
export function tryDecodeRef(hex: string): CorridorRef | null {
  try {
    return decodeRef(hex);
  } catch {
    return null;
  }
}

/** Keyed so that customer ids cannot be recovered or linked from public memos. */
export function customerTag(customerId: string, secret: string | Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", secret).update(customerId).digest().subarray(0, 8));
}

// ---- per-chain encodings of the same reference ----

/** Solana: carried as an SPL Memo instruction in the same transaction. */
export function toSolanaMemo(ref: Hex): string {
  return `corridor:${ref.slice(2)}`;
}

export function fromSolanaMemo(memo: string): Hex | null {
  const m = /^corridor:([0-9a-f]{64})$/.exec(memo.trim());
  return m ? (`0x${m[1]}` as Hex) : null;
}

export const ZCASH_MEMO_BYTES = 512;
/** ZIP-302: a leading 0xFF marks the memo as arbitrary (non-text) data. */
const ZIP302_ARBITRARY = 0xff;
const ZCASH_MEMO_MAGIC = [0x43, 0x52] as const; // "CR"

/**
 * Zcash: the reference plus an invoice reference, packed into the 512-byte
 * encrypted memo of each shielded output. Only the recipient and holders of
 * the viewing key can read it.
 */
export function toZcashMemo(ref: Hex, invoiceRef = ""): Uint8Array {
  const inv = new TextEncoder().encode(invoiceRef);
  if (inv.length > 255) throw new Error("invoiceRef must be at most 255 bytes");
  const memo = new Uint8Array(ZCASH_MEMO_BYTES);
  memo[0] = ZIP302_ARBITRARY;
  memo.set(ZCASH_MEMO_MAGIC, 1);
  memo.set(fromHex(ref), 3);
  memo[35] = inv.length;
  memo.set(inv, 36);
  return memo;
}

export function fromZcashMemo(memo: Uint8Array): { ref: Hex; invoiceRef: string } | null {
  if (memo.length !== ZCASH_MEMO_BYTES || memo[0] !== ZIP302_ARBITRARY) return null;
  if (memo[1] !== ZCASH_MEMO_MAGIC[0] || memo[2] !== ZCASH_MEMO_MAGIC[1]) return null;
  const ref = toHex(memo.subarray(3, 35));
  if (!tryDecodeRef(ref)) return null;
  const len = memo[35]!;
  return { ref, invoiceRef: new TextDecoder().decode(memo.subarray(36, 36 + len)) };
}

// ---- helpers ----

/** RFC 9562 UUIDv7: time-ordered, so references sort by creation time. */
export function uuidv7(now = Date.now()): string {
  const b = randomBytes(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return bytesToUuid(b);
}

function checksum(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest().subarray(0, 4));
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`invalid uuid "${uuid}"`);
  return fromHex(hex);
}

function bytesToUuid(b: Uint8Array): string {
  const h = Buffer.from(b).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function toHex(b: Uint8Array): Hex {
  return `0x${Buffer.from(b).toString("hex")}`;
}

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(h)) throw new Error("invalid hex");
  return new Uint8Array(Buffer.from(h, "hex"));
}
