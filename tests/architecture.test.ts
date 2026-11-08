import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "node:test";

const root = join(import.meta.dirname, "..");

// What each layer may import, besides its own relative files. See docs/architecture.md.
const rules: Record<string, RegExp> = {
  "packages/domain": /^(zod|node:crypto)$/,
  "packages/application": /^(@rapi\/domain|node:crypto|zod|yaml)$/,
  "packages/adapters":
    /^(@rapi\/(domain|application)|node:.+|fast-xml-parser|pg)$/,
  "packages/config": /^(zod)$/,
};

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

function declarations(layer: string): Array<{
  file: string;
  kind: string;
  name: string;
  implemented: string[];
}> {
  return sources(join(root, layer, "src")).flatMap((file) =>
    [
      ...readFileSync(file, "utf8").matchAll(
        /^export (?:abstract )?(interface|class|type) (\w+)(?:[^{=]*?implements ([\w,\s]+?))?\s*[{=]/gm,
      ),
    ].map((match) => ({
      file: relative(root, file),
      kind: match[1]!,
      name: match[2]!,
      implemented: (match[3] ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    })),
  );
}

describe("hexagonal boundaries", () => {
  it("keeps every layer to what it may import", () => {
    assert.deepEqual(crossings(), []);
  });

  it("declares no package dependency a layer may not use", () => {
    for (const layer of Object.keys(rules)) {
      const manifest = JSON.parse(
        readFileSync(join(root, layer, "package.json"), "utf8"),
      ) as { dependencies?: Record<string, string> };
      for (const name of Object.keys(manifest.dependencies ?? {}))
        assert.match(name, rules[layer]!, `${layer} depends on ${name}`);
    }
  });
});

describe("names", () => {
  it("declares Store and Gateway ports only in a feature's ports.ts", () => {
    const misplaced = declarations("packages/application")
      .filter(({ name }) => /(Store|Gateway)$/.test(name))
      .filter(({ file }) => !/\/src\/[a-z-]+\/ports\.ts$/.test(file));
    assert.deepEqual(misplaced, []);
  });

  it("keeps ports out of domain and adapters", () => {
    for (const layer of ["packages/domain", "packages/adapters"])
      assert.deepEqual(
        declarations(layer).filter(
          ({ kind, name }) =>
            kind === "interface" && /(Store|Gateway)$/.test(name),
        ),
        [],
      );
  });

  it("names an implementation after its port, with what it uses in front", () => {
    const wrong = declarations("packages/adapters").flatMap(
      ({ name, implemented }) =>
        implemented
          .filter((port) => /(Store|Gateway)$/.test(port))
          .filter(
            (port) =>
              name === port ||
              name.slice(-5) !== port.slice(-5) ||
              !name.endsWith(port.replace(/^\w*?(?=(Store|Gateway)$)/, "")),
          )
          .map((port) => `${name} implements ${port}`),
    );
    assert.deepEqual(wrong, []);
  });

  it("uses no other suffix for ports and adapters", () => {
    const old = ["packages/domain", "packages/application", "packages/adapters"]
      .flatMap((layer) => declarations(layer))
      .filter(({ name }) => /Adapter$/.test(name))
      .map(({ file, name }) => `${file}: ${name}`);
    assert.deepEqual(old, []);
  });
});
