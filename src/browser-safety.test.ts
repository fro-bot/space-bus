import { describe, expect, test } from "bun:test";
import type { BunPlugin } from "bun";

// CI-enforced browser-safety guard: the public browser-facing subpaths
// (core, contract, format) must bundle cleanly for a browser target with
// Node builtins forbidden, and their module graphs must never reach
// src/config.ts, src/server.ts, src/discovery.ts, or src/cli.ts (the
// Node-only boundary, including the managed-server lifecycle modules).
// Mirrors the build-based version-injection test pattern — runs a real
// Bun.build rather than reimplementing bundler logic.
//
// Bun's browser target silently stubs Node builtins (e.g. `node:fs`
// resolves to an empty module) instead of failing the build — so a plain
// "output text doesn't contain node:" check would NOT catch a Node import.
// This plugin intercepts any `node:*` resolution during the browser build
// and turns it into a hard build failure, making the guard actually
// enforce the invariant.

const BROWSER_ENTRYPOINTS = [
  "./src/core.ts",
  "./src/contract.ts",
  "./src/format.ts",
];

// Distinctive string that only appears in src/config.ts's source. If this
// shows up in a browser bundle, config.ts leaked into the graph.
const CONFIG_ONLY_MARKER = "SPACE_BUS_CONFIG must be an absolute path";

// Distinctive strings unique to the other Node-only lifecycle modules. If
// any of these show up in a browser bundle, that module leaked into the
// graph — server.ts/discovery.ts/cli.ts are Node-only by construction and
// must never be reachable from core/contract/format.
const SERVER_ONLY_MARKER =
  "ensureServer called on an externally-managed roster";
const DISCOVERY_ONLY_MARKER = "discovery.json";
const CLI_ONLY_MARKER = "thin CLI for the managed OpenCode bus server";

// Node-only constructs that must never appear in these browser-safe bundles.
// Word-boundary regexes keep this pragmatic (avoid false positives inside
// unrelated identifiers/strings) without trying to fully parse the output.
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\bBuffer\.from\(/,
  /\bprocess\.env\b/,
  /\brequire\(/,
];

const forbidNodeBuiltins: BunPlugin = {
  name: "forbid-node-builtins",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => {
      throw new Error(
        `browser-safety violation: "${args.path}" imported from ${args.importer} — Node builtins are forbidden in browser-safe modules`,
      );
    });
  },
};

describe("browser-safety: core/contract/format bundle for browser target", () => {
  test("Bun.build succeeds with target browser, external zod, Node builtins forbidden", async () => {
    const result = await Bun.build({
      entrypoints: BROWSER_ENTRYPOINTS,
      target: "browser",
      format: "esm",
      external: ["zod"],
      plugins: [forbidNodeBuiltins],
    });

    if (!result.success) {
      const messages = result.logs
        .map((l) => l.message ?? String(l))
        .join("\n");
      throw new Error(`browser build failed:\n${messages}`);
    }

    expect(result.success).toBe(true);
    expect(result.outputs.length).toBeGreaterThan(0);

    for (const output of result.outputs) {
      const text = await output.text();

      // Belt-and-suspenders: no literal node: specifier should survive.
      expect(text).not.toContain("node:");

      // config.ts must never be reachable from these browser-safe graphs.
      expect(text).not.toContain(CONFIG_ONLY_MARKER);

      // Node-only lifecycle modules (server.ts/discovery.ts/cli.ts) must
      // never be reachable from these browser-safe graphs either.
      expect(text).not.toContain(SERVER_ONLY_MARKER);
      expect(text).not.toContain(DISCOVERY_ONLY_MARKER);
      expect(text).not.toContain(CLI_ONLY_MARKER);

      // Node-only APIs (Buffer, process.env, require()) must never survive
      // into a browser bundle — this is what catches e.g. authHeader()
      // regressing to Buffer.from() for base64 encoding.
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(text).not.toMatch(pattern);
      }
    }
  }, 30_000);
});
