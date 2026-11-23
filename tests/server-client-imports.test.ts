import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// A server file can render a client component, but never call a function or read a value from a "use client" file:
// in production that's "Attempted to call itemChips() from the server" and the page breaks (Nov 23 2026, every
// Overview). Imports from a client file into a server file must be components (Capitalized) or types.

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(p) ? [p] : [];
  });
}
const isClient = (src: string) => /^\s*["']use client["']/.test(src);
function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? resolve("src", spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null;
  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) if (existsSync(base + ext)) return base + ext;
  return null;
}

describe("server files and client files", () => {
  it("server files only take components and types from client files", () => {
    const bad: string[] = [];
    for (const f of files("src/app")) {
      const src = readFileSync(f, "utf8");
      if (isClient(src) || src.includes('"use server"')) continue;
      for (const m of src.matchAll(/^import\s+(?!type\b)\{([^}]+)\}\s+from\s+"([^"]+)";/gm)) {
        const target = resolveImport(f, m[2]);
        if (!target || !isClient(readFileSync(target, "utf8"))) continue;
        for (const raw of m[1].split(",")) {
          const name = raw.trim();
          if (!name || name.startsWith("type ")) continue;
          const local = name.split(/\s+as\s+/)[0].trim();
          if (!/^[A-Z][A-Za-z0-9]*$/.test(local) || /^[A-Z0-9_]+$/.test(local)) bad.push(`${f}: ${local} from ${m[2]}`);
        }
      }
    }
    expect(bad, "move these into a plain (not \"use client\") module").toEqual([]);
  });
});
