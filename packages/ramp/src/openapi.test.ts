import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { rampHandler } from "./server.ts";
import { testRamp } from "./testing.ts";

const spec = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));

describe("OpenAPI spec", () => {
  it("documents exactly the routes the server serves", async () => {
    const t = await testRamp();
    try {
      const served = rampHandler(t.ramp)
        .routes.map((r) => `${r.method} ${r.path.replace(/:([a-zA-Z]+)/g, "{$1}")}`)
        .sort();
      const documented = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
        .flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${path}`))
        .sort();
      expect(documented).toEqual(served);
    } finally {
      await t.close();
    }
  });

  it("is well-formed: every operation answers, every $ref resolves", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, { responses?: object; parameters?: Array<{ in: string; name: string }> }>>)) {
      for (const [method, op] of Object.entries(ops)) {
        expect(Object.keys(op.responses ?? {}).length, `${method} ${path}`).toBeGreaterThan(0);
        const declared = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
        const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
        expect(declared.sort(), `${method} ${path} path params`).toEqual(inPath.sort());
      }
    }
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/([^"]+)"/g)].map((m) => m[1]!);
    for (const r of refs) {
      const target = r.split("/").reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], spec);
      expect(target, r).toBeDefined();
    }
  });
});
