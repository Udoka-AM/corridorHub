import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fromZcashMemo, type Observation } from "@corridor/core";
import { buildPaymentRequest, type ShieldedPayment } from "./zip321.ts";

/**
 * Corridor's Zcash sidecar for the hackathon: a thin wrapper over
 * zcash-devtool (librustzcash, Ironwood-aware) for writes, plus read-only
 * access to its wallet database for observation. The account model is
 * ZIP-32: account 0 is the treasury; each (customer, period) gets its own
 * account, so its viewing key discloses exactly that customer's period.
 */

export interface ZcashWalletOptions {
  /** Path to the zcash-devtool binary. */
  bin: string;
  walletDir: string;
  /** age identity that decrypts the wallet mnemonic (needed to spend). */
  identity?: string;
  /** lightwalletd server alias or host:port (zcash-devtool default: zecrocks). */
  server?: string;
}

export interface ZcashAccount {
  uuid: string;
  name: string;
  index?: number;
  ufvk?: string;
  uivk?: string;
}

export interface ZcashBalance {
  chainTipHeight: number;
  ironwoodSpendable: bigint;
  orchardSpendable: bigint;
  saplingSpendable: bigint;
  transparentSpendable: bigint;
  total: bigint;
}

export interface ZcashOutput {
  txid: string;
  minedHeight: number | null;
  pool: "transparent" | "sapling" | "orchard" | "ironwood" | "unknown";
  outputIndex: number;
  fromAccount: string | null;
  toAccount: string | null;
  toAddress: string | null;
  zatoshi: bigint;
  isChange: boolean;
  memo: Uint8Array | null;
}

const POOLS: Record<number, ZcashOutput["pool"]> = { 0: "transparent", 2: "sapling", 3: "orchard", 4: "ironwood" };

export class ZcashWallet {
  constructor(private readonly opts: ZcashWalletOptions) {}

  private run(args: string[]): string {
    const out = execFileSync(this.opts.bin, ["wallet", "-w", this.opts.walletDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", RUST_LOG: "warn" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.replace(/\x1b\[[0-9;]*m/g, "");
  }

  private withServer(args: string[]): string[] {
    return this.opts.server ? [...args, "-s", this.opts.server] : args;
  }

  /**
   * Scan new blocks, then fetch full transactions. Compact blocks carry no
   * memos, so without the second step a light wallet sees payments but not
   * their Corridor References.
   */
  sync(): void {
    this.run(this.withServer(["sync"]));
    this.run(this.withServer(["enhance"]));
  }

  chainTip(): number {
    return JSON.parse(this.run(this.withServer(["get-info"])).trim().split("\n").at(-1)!).chain_tip_height;
  }

  accounts(): ZcashAccount[] {
    const out = this.run(["list-accounts"]);
    const accounts: ZcashAccount[] = [];
    for (const block of out.split(/^Account /m).slice(1)) {
      const uuid = /^([0-9a-f-]{36})/.exec(block)?.[1];
      if (!uuid) continue;
      accounts.push({
        uuid,
        name: /Name: (.+)/.exec(block)?.[1]?.trim() ?? "",
        index: /Account index: (\d+)/.exec(block) ? Number(/Account index: (\d+)/.exec(block)![1]) : undefined,
        ufvk: /UFVK: (\S+)/.exec(block)?.[1],
        uivk: /UIVK: (\S+)/.exec(block)?.[1],
      });
    }
    return accounts;
  }

  account(name: string): ZcashAccount {
    const a = this.accounts().find((x) => x.name === name);
    if (!a) throw new Error(`no Zcash account named ${name}`);
    return a;
  }

  generateAccount(name: string): ZcashAccount {
    this.run(["generate-account", "--name", name, "-i", this.requireIdentity()]);
    return this.account(name);
  }

  defaultAddress(accountUuid: string): string {
    const m = /Default Address: (\S+)/.exec(this.run(["list-addresses", accountUuid]));
    if (!m) throw new Error(`no default address for ${accountUuid}`);
    return m[1]!;
  }

  balance(accountUuid: string): ZcashBalance {
    const j = JSON.parse(this.run(["balance", accountUuid, "--json"]).trim().split("\n").at(-1)!);
    return {
      chainTipHeight: j.chain_tip_height,
      ironwoodSpendable: BigInt(j.ironwood_spendable),
      orchardSpendable: BigInt(j.orchard_spendable),
      saplingSpendable: BigInt(j.sapling_spendable),
      transparentSpendable: BigInt(j.transparent_spendable),
      total: BigInt(j.total),
    };
  }

  /**
   * Pay a whole batch in one shielded transaction: one output per recipient,
   * each with its own encrypted memo. Returns the txid.
   */
  payBatch(accountUuid: string, payments: ShieldedPayment[]): string {
    const out = this.run(
      this.withServer([
        "pay",
        accountUuid,
        "-i",
        this.requireIdentity(),
        "--payment-uri",
        buildPaymentRequest(payments),
        "--disable-confirmation",
      ]),
    );
    const txid = out.trim().split("\n").at(-1)?.trim();
    if (!txid || !/^[0-9a-f]{64}$/.test(txid)) throw new Error(`could not read txid from zcash-devtool output:\n${out}`);
    return txid;
  }

  /** Every output the wallet can see (received, sent, change), with decrypted memos. */
  outputs(): ZcashOutput[] {
    const db = new DatabaseSync(`${this.opts.walletDir}/data.sqlite`, { readOnly: true });
    try {
      const rows = db
        .prepare(
          `select lower(hex(txid)) txid_le, tx_mined_height, output_pool, output_index, from_account_uuid,
                  to_account_uuid, to_address, value, is_change, memo
             from v_tx_outputs order by tx_mined_height, txid, output_index`,
        )
        .all() as Record<string, unknown>[];
      return rows.map((r) => ({
        // Stored in internal (little-endian) byte order; explorers show it reversed.
        txid: Buffer.from(String(r.txid_le), "hex").reverse().toString("hex"),
        minedHeight: (r.tx_mined_height as number | null) ?? null,
        pool: POOLS[Number(r.output_pool)] ?? "unknown",
        outputIndex: Number(r.output_index),
        fromAccount: uuidOrNull(r.from_account_uuid),
        toAccount: uuidOrNull(r.to_account_uuid),
        toAddress: (r.to_address as string | null) ?? null,
        zatoshi: BigInt(r.value as number),
        isChange: Boolean(r.is_change),
        memo: r.memo ? new Uint8Array(r.memo as Uint8Array) : null,
      }));
    } finally {
      db.close();
    }
  }

  /** Track an externally controlled account (e.g. a FROST treasury) from its UFVK. */
  importUfvk(name: string, ufvk: string, birthday: number): ZcashAccount {
    const existing = this.accounts().find((a) => a.ufvk === ufvk);
    if (existing) return existing;
    this.run(this.withServer(["import-ufvk", "--name", name, ufvk, String(birthday)]));
    return this.account(name);
  }

  // ---- PCZT (partially created Zcash transaction) flow, for spends signed outside the wallet ----

  private pczt(args: string[]): string {
    const out = execFileSync(this.opts.bin, ["pczt", "-w", this.opts.walletDir, ...args], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1", RUST_LOG: "warn" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.replace(/\x1b\[[0-9;]*m/g, "");
  }

  /** Build an unsigned batch transaction (one output + memo per payment) from an account. */
  pcztCreateBatch(accountUuid: string, payments: ShieldedPayment[], outPath: string): void {
    this.pczt(["create", accountUuid, "--payment-uri", buildPaymentRequest(payments), "--output", outPath]);
  }

  /** Add zero-knowledge proofs. Needs no spending key. */
  pcztProve(inPath: string, outPath: string): void {
    this.pczt(["prove", inPath, "--output", outPath]);
  }

  pcztCombine(inPaths: string[], outPath: string): void {
    this.pczt(["combine", ...inPaths.flatMap((p) => ["-i", p]), "-o", outPath]);
  }

  /** Extract the finished transaction, broadcast it, and return its txid. */
  pcztSend(inPath: string): string {
    const out = this.pczt(this.opts.server ? ["send", inPath, "-s", this.opts.server] : ["send", inPath]);
    const txid = /\b([0-9a-f]{64})\b/.exec(out.trim().split("\n").at(-1) ?? "")?.[1];
    if (!txid) throw new Error(`could not read txid from pczt send output:\n${out}`);
    return txid;
  }

  /** Initialise a view-only wallet from a viewing key: what an auditor runs. */
  initViewOnly(name: string, ufvk: string, birthday: number): void {
    this.run(this.withServer(["init-fvk", "--name", name, "--fvk", ufvk, "--birthday", String(birthday)]));
  }

  private requireIdentity(): string {
    if (!this.opts.identity) throw new Error("this operation needs the wallet's age identity");
    return this.opts.identity;
  }
}

function uuidOrNull(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  const h = Buffer.from(v as Uint8Array).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Shielded observer: turns the outputs a wallet (or an auditor's view-only
 * wallet) can decrypt into Observations for the shared reconciliation engine.
 * Change outputs are internal and skipped.
 */
export function shieldedObservations(outputs: ZcashOutput[]): Observation[] {
  return outputs
    .filter((o) => !o.isChange && (o.pool === "ironwood" || o.pool === "orchard" || o.pool === "sapling"))
    .map((o) => ({
      venue: "zcash_ironwood" as const,
      externalRef: `${o.txid}:${o.pool}:${o.outputIndex}`,
      reference: o.memo ? (fromZcashMemo(o.memo)?.ref ?? null) : null,
      asset: "ZEC" as const,
      amount: o.zatoshi,
      from: o.fromAccount ?? undefined,
      to: o.toAddress ?? o.toAccount ?? undefined,
      blockNumber: o.minedHeight != null ? BigInt(o.minedHeight) : undefined,
      observedAt: new Date(),
    }));
}
