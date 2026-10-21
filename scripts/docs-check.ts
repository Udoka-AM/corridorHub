/**
 * Offline check of the Mintlify docs (apps/docs): every page in docs.json's
 * navigation exists, every page on disk is reachable from it, and every
 * internal link and image points at something real. Run in CI on every PR.
 *
 *   pnpm docs:check
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..", "apps", "docs");
const config = JSON.parse(readFileSync(join(root, "docs.json"), "utf8"));
const problems: string[] = [];

const nav = new Set<string>();
(function walk(node: unknown) {
  if (typeof node === "string") nav.add(node);
  else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) if (k === "pages" || k === "groups" || k === "tabs" || k === "anchors") walk(v);
  }
})(config.navigation);

const page = (p: string) => [`${p}.mdx`, `${p}.md`, `${p}/index.mdx`].map((f) => join(root, f)).find(existsSync);
for (const p of nav) if (!page(p)) problems.push(`docs.json lists "${p}" but no such page exists`);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = join(dir, f);
    if (f === "node_modules" || f.startsWith(".") || f === "diagrams-src") return [];
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

const pages = files(root).filter((f) => /\.mdx?$/.test(f));
const reachable = new Set([...nav].map((p) => page(p)));
for (const f of pages) {
  const rel = relative(root, f);
  if (!reachable.has(f) && !rel.startsWith("snippets/") && !rel.startsWith("decisions/")) problems.push(`${rel} is not in docs.json navigation`);
  const text = readFileSync(f, "utf8").replace(/```[\s\S]*?```/g, "");
  const links = [...text.matchAll(/\]\((\/[^)\s#]*)[^)]*\)|(?:href|src)=["'](\/[^"'#]*)/g)].map((m) => m[1] ?? m[2]!);
  for (const link of links) {
    const target = link.replace(/\/$/, "") || "/index";
    if (existsSync(join(root, target)) && statSync(join(root, target)).isFile()) continue;
    if (!page(target.slice(1))) problems.push(`${rel} links to ${link}, which does not exist`);
  }
}

if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`docs ok: ${nav.size} pages in navigation, ${pages.length} files checked`);
