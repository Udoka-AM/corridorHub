import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wrapper for `corridor-frost` (services/zcash-frost): threshold control of
 * a shielded Zcash vault. The vault's spend-authorizing key exists only as
 * FROST shares; any `threshold` of the signers can authorize a batch.
 */

export interface FrostVault {
  threshold: number;
  signers: number;
  network: "test" | "main";
  /** FROST group verifying key = the Orchard/Ironwood spend validating key `ak`. */
  groupKey: string;
  ufvk: string;
  address: string;
}

export interface FrostSignResult {
  ironwoodActions: number;
  signed: number;
  signers: number[];
  threshold: number;
  sighash: string;
}

export class FrostSigner {
  constructor(private readonly bin: string, private readonly keysDir: string) {}

  private run(args: string[]): string {
    return execFileSync(this.bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  static keygen(bin: string, keysDir: string, opts: { threshold: number; signers: number; network: "test" | "main" }): FrostSigner {
    execFileSync(bin, [
      "keygen",
      "--threshold", String(opts.threshold),
      "--signers", String(opts.signers),
      "--network", opts.network,
      "--out", keysDir,
    ]);
    return new FrostSigner(bin, keysDir);
  }

  vault(): FrostVault {
    const j = JSON.parse(readFileSync(join(this.keysDir, "public.json"), "utf8"));
    return {
      threshold: j.threshold,
      signers: j.signers,
      network: j.network,
      groupKey: j.group_key,
      ufvk: j.ufvk,
      address: j.address,
    };
  }

  /** Co-sign every Ironwood spend of this vault in the PCZT with the given signers. */
  sign(pcztPath: string, signers: number[], outPath: string): FrostSignResult {
    const out = this.run(["sign", "--pczt", pcztPath, "--keys", this.keysDir, "--signers", signers.join(","), "--out", outPath]);
    const j = JSON.parse(out.trim().split("\n").at(-1)!);
    return { ironwoodActions: j.ironwood_actions, signed: j.signed, signers: j.signers, threshold: j.threshold, sighash: j.sighash };
  }
}
