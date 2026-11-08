import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");

// What each layer may import, besides its own relative files. See docs/architecture.md.
const rules: Record<string, RegExp> = {
  "packages/contracts": /^(zod)$/,
  "packages/core": /^(@rapi\/contracts|node:crypto)$/,
  "packages/agent": /^(@rapi\/(core|contracts)|node:crypto|zod|yaml)$/,
  "packages/db": /^(@rapi\/(core|contracts)|node:(crypto|fs\/promises)|pg)$/,
  "packages/adapters": /^(@rapi\/(core|contracts)|node:.+|fast-xml-parser)$/,
  "packages/config": /^(zod)$/,
};

// Imports that still cross a boundary. Each one is being moved behind a port;
// the test fails when an entry here is no longer needed, so the list only shrinks.
const pending = new Set<string>([
  "packages/agent/src/discord-layout-manager.ts -> node:fs/promises",
  "packages/agent/src/discount-candidates.ts -> @rapi/adapters",
  "packages/agent/src/discount-candidates.ts -> node:fs/promises",
]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.ts$/.test(entry.name) && !entry.name.endsWith(".d.ts")
      ? [path]
      : [];
  });
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [
    ...text.matchAll(
      /^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gms,
    ),
  ]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((specifier) => !specifier.startsWith("."));
}

function crossings(): string[] {
  return Object.entries(rules).flatMap(([layer, allowed]) =>
    sources(join(root, layer, "src")).flatMap((file) =>
      imports(file)
        .filter((specifier) => !allowed.test(specifier))
        .map((specifier) => `${relative(root, file)} -> ${specifier}`),
    ),
  );
}

describe("hexagonal boundaries", () => {
  it("keeps every layer to what it may import", () => {
    const found = crossings();
    assert.deepEqual(
      found.filter((crossing) => !pending.has(crossing)),
      [],
    );
  });

  it("only lists crossings that still exist", () => {
    const found = new Set(crossings());
    assert.deepEqual(
      [...pending].filter((crossing) => !found.has(crossing)),
      [],
    );
  });

  it("declares no package dependency a layer may not use", () => {
    for (const layer of Object.keys(rules)) {
      const manifest = JSON.parse(
        readFileSync(join(root, layer, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      const stillCrossing = [...pending].some((crossing) =>
        crossing.startsWith(`${layer}/`),
      );
      for (const name of Object.keys(manifest.dependencies ?? {})) {
        if (stillCrossing && name.startsWith("@rapi/")) continue;
        assert.match(name, rules[layer]!, `${layer} depends on ${name}`);
      }
    }
  });
});
