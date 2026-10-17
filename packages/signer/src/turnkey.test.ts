import { createECDH, createPublicKey, verify as nodeVerify, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashMessage, keccak256 } from "viem";
import { privateKeyToAccount, sign as secp256k1Sign } from "viem/accounts";
import { getAddressDecoder, verifySignature } from "@solana/kit";
import type { Hex } from "@corridor/core";
import { ed25519PublicKeyBytes, evmAccount, evmAddress, solanaSigner } from "./index.ts";
import { TurnkeyApi, TurnkeyError, turnkeyEd25519Signer, turnkeySecp256k1Signer } from "./turnkey.ts";

const EVM_KEY = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318" as Hex;
const EVM_ADDRESS = privateKeyToAccount(EVM_KEY).address;

/** A Turnkey stand-in: checks every request's API-key stamp, signs with real keys, and can hold an activity for "consensus" once. */
async function fakeTurnkey(opts: { holdFirst?: boolean; fail?: boolean } = {}) {
  const api = createECDH("prime256v1");
  api.generateKeys();
  const point = api.getPublicKey();
  const apiPublic = createPublicKey({
    format: "jwk",
    key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") },
  });
  const ed = (await webcrypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const solAddress = getAddressDecoder().decode(new Uint8Array(await webcrypto.subtle.exportKey("raw", ed.publicKey)));
  const requests: { path: string; body: any }[] = [];
  let held = opts.holdFirst;
  const pending = new Map<string, object>();

  const fetchImpl = (async (url: string, init: { body: string; headers: Record<string, string> }) => {
    const path = new URL(url).pathname;
    const stamp = JSON.parse(Buffer.from(init.headers["X-Stamp"]!, "base64url").toString());
    const ok =
      stamp.scheme === "SIGNATURE_SCHEME_TK_API_P256" &&
      stamp.publicKey === api.getPublicKey("hex", "compressed") &&
      nodeVerify("sha256", Buffer.from(init.body), { key: apiPublic, dsaEncoding: "der" }, Buffer.from(stamp.signature, "hex"));
    if (!ok) return new Response("bad stamp", { status: 401 });
    const body = JSON.parse(init.body);
    requests.push({ path, body });
    if (path === "/public/v1/query/get_activity") {
      return Response.json({ activity: { id: body.activityId, status: "ACTIVITY_STATUS_COMPLETED", result: pending.get(body.activityId) } });
    }
    const { signWith, payload, hashFunction } = body.parameters;
    let result: object;
    if (hashFunction === "HASH_FUNCTION_NO_OP") {
      expect(signWith).toBe(EVM_ADDRESS);
      const sig = await secp256k1Sign({ hash: payload, privateKey: EVM_KEY });
      const hex = (v: `0x${string}`) => v.slice(2).padStart(64, "0");
      result = { signRawPayloadResult: { r: hex(sig.r), s: hex(sig.s), v: `0${sig.yParity}` } };
    } else {
      expect(signWith).toBe(solAddress);
      const raw = new Uint8Array(await webcrypto.subtle.sign("Ed25519", ed.privateKey, Buffer.from(payload.slice(2), "hex")));
      result = { signRawPayloadResult: { r: Buffer.from(raw.subarray(0, 32)).toString("hex"), s: Buffer.from(raw.subarray(32)).toString("hex") } };
    }
    const id = `act_${requests.length}`;
    if (opts.fail) return Response.json({ activity: { id, status: "ACTIVITY_STATUS_FAILED", failure: { message: "policy denied" } } });
    if (held) {
      held = false;
      pending.set(id, result);
      return Response.json({ activity: { id, status: "ACTIVITY_STATUS_CONSENSUS_NEEDED" } });
    }
    return Response.json({ activity: { id, status: "ACTIVITY_STATUS_COMPLETED", result } });
  }) as unknown as typeof fetch;

  const client = new TurnkeyApi({ organizationId: "org_1", apiPrivateKey: api.getPrivateKey("hex"), fetch: fetchImpl, pollMs: 1 });
  return { client, requests, solAddress, edPublic: ed.publicKey };
}

describe("Turnkey adapter", () => {
  it("signs EVM digests with a Turnkey-held secp256k1 key", async () => {
    const tk = await fakeTurnkey();
    const signer = turnkeySecp256k1Signer(tk.client, EVM_ADDRESS);
    expect(await evmAddress(signer)).toBe(EVM_ADDRESS); // public key recovered from a probe signature
    const base = await evmAccount(signer);
    expect(base.address).toBe(EVM_ADDRESS);
    expect(tk.requests.every((r) => r.body.organizationId === "org_1")).toBe(true);
    expect(tk.requests[0]!.body.parameters).toMatchObject({ encoding: "PAYLOAD_ENCODING_HEXADECIMAL", hashFunction: "HASH_FUNCTION_NO_OP" });
  });

  it("signs Solana transaction messages with a Turnkey-held Ed25519 key", async () => {
    const tk = await fakeTurnkey();
    const signer = turnkeyEd25519Signer(tk.client, tk.solAddress);
    const message = new TextEncoder().encode("corridor:solana-message");
    const signature = await signer.signBytes(message);
    expect(await verifySignature(tk.edPublic, signature as never, message)).toBe(true);
    const [dict] = await solanaSigner(signer).signTransactions([{ messageBytes: message, signatures: {} } as never]);
    expect(dict![tk.solAddress as never]).toEqual(signature);
    expect(tk.requests[0]!.body.parameters.hashFunction).toBe("HASH_FUNCTION_NOT_APPLICABLE");
  });

  it("waits for policy consensus, and surfaces a denied activity as an error", async () => {
    const held = await fakeTurnkey({ holdFirst: true });
    const sig = await turnkeySecp256k1Signer(held.client, EVM_ADDRESS).signDigest(keccak256("0x01"));
    expect(sig.s > 0n).toBe(true);
    expect(held.requests.map((r) => r.path)).toEqual(["/public/v1/submit/sign_raw_payload", "/public/v1/query/get_activity"]);

    const denied = await fakeTurnkey({ fail: true });
    await expect(turnkeySecp256k1Signer(denied.client, EVM_ADDRESS).signDigest(keccak256("0x01"))).rejects.toThrow(TurnkeyError);
  });
});
