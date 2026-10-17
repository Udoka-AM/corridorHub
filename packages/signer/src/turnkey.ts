import { createECDH, createPrivateKey, sign as nodeSign } from "node:crypto";
import { keccak256, recoverPublicKey, serializeSignature, toHex } from "viem";
import type { Hex } from "@corridor/core";
import { toViemSignature, type EcdsaSignature, type Ed25519Signer, type Secp256k1Signer } from "./index.ts";

/**
 * Turnkey adapter. Keys live in the customer's Turnkey organisation; Corridor
 * calls the raw-payload signing activity with a digest (secp256k1: Base and
 * other EVM chains) or a transaction message (Ed25519: Stellar, Solana) and
 * gets a signature back.
 *
 * Requests are authenticated with an API key stamp: the request body signed
 * with the API key's P-256 private key, sent in the `X-Stamp` header. If the
 * organisation's policies require more approvals, the activity waits for
 * consensus and the adapter polls until it completes or fails.
 */

export interface TurnkeyConfig {
  organizationId: string;
  /** API key pair from the Turnkey dashboard (P-256, hex). The public key is derived and sent in each stamp. */
  apiPrivateKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Polling while an activity awaits policy consensus. */
  pollMs?: number;
  timeoutMs?: number;
}

type Curve = "secp256k1" | "ed25519";

interface RawSignature {
  r: string;
  s: string;
  v?: string;
}

interface Activity {
  id: string;
  status: string;
  result?: { signRawPayloadResult?: RawSignature };
  failure?: { message?: string };
}

export class TurnkeyError extends Error {}

export class TurnkeyApi {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly key;
  /** Compressed P-256 API public key, as Turnkey lists it. */
  readonly apiPublicKey: string;

  constructor(private readonly cfg: TurnkeyConfig) {
    this.baseUrl = cfg.baseUrl ?? "https://api.turnkey.com";
    this.fetchImpl = cfg.fetch ?? fetch;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(cfg.apiPrivateKey.replace(/^0x/, ""), "hex"));
    this.apiPublicKey = ecdh.getPublicKey("hex", "compressed");
    const point = ecdh.getPublicKey();
    this.key = createPrivateKey({
      format: "jwk",
      key: {
        kty: "EC",
        crv: "P-256",
        d: Buffer.from(cfg.apiPrivateKey.replace(/^0x/, ""), "hex").toString("base64url"),
        x: point.subarray(1, 33).toString("base64url"),
        y: point.subarray(33, 65).toString("base64url"),
      },
    });
  }

  /** `X-Stamp` header value for a request body. */
  stamp(body: string): string {
    const signature = nodeSign("sha256", Buffer.from(body), { key: this.key, dsaEncoding: "der" }).toString("hex");
    return Buffer.from(JSON.stringify({ publicKey: this.apiPublicKey, scheme: "SIGNATURE_SCHEME_TK_API_P256", signature })).toString("base64url");
  }

  private async post<T>(path: string, payload: object): Promise<T> {
    const body = JSON.stringify(payload);
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Stamp": this.stamp(body) },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new TurnkeyError(`Turnkey ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  /** Sign a raw payload with the key at `signWith` (an address or private key id). */
  async signRaw(signWith: string, payload: Hex, curve: Curve): Promise<RawSignature> {
    const { activity } = await this.post<{ activity: Activity }>("/public/v1/submit/sign_raw_payload", {
      type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
      timestampMs: String(Date.now()),
      organizationId: this.cfg.organizationId,
      parameters: {
        signWith,
        payload,
        encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
        // The digest is already hashed for secp256k1; Ed25519 signs the message itself.
        hashFunction: curve === "secp256k1" ? "HASH_FUNCTION_NO_OP" : "HASH_FUNCTION_NOT_APPLICABLE",
      },
    });
    return this.result(await this.settle(activity));
  }

  private async settle(activity: Activity): Promise<Activity> {
    const deadline = Date.now() + (this.cfg.timeoutMs ?? 120_000);
    let current = activity;
    while (current.status !== "ACTIVITY_STATUS_COMPLETED") {
      if (current.status === "ACTIVITY_STATUS_FAILED" || current.status === "ACTIVITY_STATUS_REJECTED") {
        throw new TurnkeyError(`Turnkey activity ${current.id} ${current.status.replace("ACTIVITY_STATUS_", "").toLowerCase()}: ${current.failure?.message ?? ""}`);
      }
      if (Date.now() > deadline) throw new TurnkeyError(`Turnkey activity ${current.id} still ${current.status} (awaiting policy approvals?)`);
      await new Promise((r) => setTimeout(r, this.cfg.pollMs ?? 2_000));
      current = (
        await this.post<{ activity: Activity }>("/public/v1/query/get_activity", {
          organizationId: this.cfg.organizationId,
          activityId: current.id,
        })
      ).activity;
    }
    return current;
  }

  private result(activity: Activity): RawSignature {
    const sig = activity.result?.signRawPayloadResult;
    if (!sig?.r || !sig.s) throw new TurnkeyError(`Turnkey activity ${activity.id} returned no signature`);
    return sig;
  }
}

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const PROBE = keccak256(toHex("corridor:turnkey:public-key"));

/**
 * secp256k1 key in Turnkey (Base and other EVM vaults). Pass the key's public key
 * if you have it; otherwise it is recovered once from a signature over a fixed
 * probe digest, so no read permission is needed.
 */
export function turnkeySecp256k1Signer(api: TurnkeyApi, signWith: string, publicKey?: Hex): Secp256k1Signer {
  const signDigest = async (digest: Hex): Promise<EcdsaSignature> => {
    const raw = await api.signRaw(signWith, digest, "secp256k1");
    const r = BigInt(`0x${raw.r.replace(/^0x/, "")}`);
    let s = BigInt(`0x${raw.s.replace(/^0x/, "")}`);
    const v = Number.parseInt((raw.v ?? "00").replace(/^0x/, ""), 16);
    let yParity = (v >= 27 ? v - 27 : v) as 0 | 1;
    if (s > N / 2n) {
      s = N - s;
      yParity = (1 - yParity) as 0 | 1;
    }
    return { r, s, yParity };
  };
  let cached = publicKey;
  return {
    kind: "turnkey",
    async publicKey() {
      if (!cached) {
        const sig = await signDigest(PROBE);
        cached = (await recoverPublicKey({ hash: PROBE, signature: serializeSignature(toViemSignature(sig)) })) as Hex;
      }
      return cached;
    },
    signDigest,
  };
}

/** Ed25519 key in Turnkey (Solana vaults). `address` is the Solana address of the Turnkey wallet account. */
export function turnkeyEd25519Signer(api: TurnkeyApi, address: string): Ed25519Signer {
  return {
    kind: "turnkey",
    address,
    async signBytes(message) {
      const raw = await api.signRaw(address, toHex(message), "ed25519");
      const sig = Buffer.from(raw.r.replace(/^0x/, "") + raw.s.replace(/^0x/, ""), "hex");
      if (sig.length !== 64) throw new TurnkeyError(`expected a 64-byte Ed25519 signature, got ${sig.length}`);
      return new Uint8Array(sig);
    },
  };
}
