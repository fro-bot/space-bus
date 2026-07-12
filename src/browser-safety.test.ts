import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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
  "./src/attach.ts",
];

// Distinctive string that only appears in src/config.ts's source. If this
// shows up in a browser bundle, config.ts leaked into the graph.
const CONFIG_ONLY_MARKER = "SPACE_BUS_CONFIG must be an absolute path";

// Distinctive strings unique to the other Node-only lifecycle modules. If
// any of these show up in a browser bundle, that module leaked into the
// graph — server.ts/discovery.ts/cli.ts/launchd.ts/service.ts are Node-only
// by construction and must never be reachable from core/contract/format.
const SERVER_ONLY_MARKER =
  "ensureServer called on an externally-managed roster";
// Note: "discovery.json" itself is NOT usable as this marker — attach.ts
// legitimately references that filename literal by design (it reads the
// same on-disk file discovery.ts writes). Use a string unique to
// discovery.ts's Node-only code path instead (the provisional-spawn-record
// filename, never referenced by attach.ts).
const DISCOVERY_ONLY_MARKER = "spawn.provisional.json";
const CLI_ONLY_MARKER = "thin CLI for the managed OpenCode bus server";
const LAUNCHD_ONLY_MARKER = "launchd agent plist XML for a roster";
const SERVICE_ONLY_MARKER =
  "space-bus service is not supported on this platform";
const REGISTRY_ONLY_MARKER = "refusing to register a symlinked roster file";
const ROSTER_EDIT_ONLY_MARKER = "refusing to overwrite existing roster file at";

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
      expect(text).not.toContain(LAUNCHD_ONLY_MARKER);
      expect(text).not.toContain(SERVICE_ONLY_MARKER);
      expect(text).not.toContain(REGISTRY_ONLY_MARKER);
      expect(text).not.toContain(ROSTER_EDIT_ONLY_MARKER);

      // Node-only APIs (Buffer, process.env, require()) must never survive
      // into a browser bundle — this is what catches e.g. authHeader()
      // regressing to Buffer.from() for base64 encoding.
      for (const pattern of FORBIDDEN_PATTERNS) {
        expect(text).not.toMatch(pattern);
      }
    }
  }, 30_000);
});

// Dist-level browser-safety gate: the src-bundle test above proved the
// module GRAPH is browser-safe, but that's not sufficient — it doesn't
// catch the actual published artifacts. Bun's node-target build injects a
// createRequire(node:module) prelude into every output of a build call,
// even into files with no genuine node:* dependency, if that build call's
// target is "node". The src-level test never runs the real build.ts, so it
// can't see this. This gate runs `bun run build` and scans the PUBLISHED
// dist/*.js files for these browser-facing subpaths directly.
const projectRoot = join(import.meta.dir, "..");
const DIST_BROWSER_SAFE_FILES = [
  "dist/core.js",
  "dist/contract.js",
  "dist/format.js",
  "dist/attach.js",
];

function runDistBuild() {
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    console.warn("bun not found on PATH, skipping dist browser-safety test");
    return false;
  }
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    const stdout = build.stdout.toString();
    const stderr = build.stderr.toString();
    throw new Error(
      `bun run build failed (exit ${build.exitCode}):\n${stdout}\n${stderr}`,
    );
  }
  return true;
}

describe("browser-safety: published dist artifacts carry no node: imports", () => {
  test("dist/core.js, dist/contract.js, dist/format.js, dist/attach.js are free of node: module imports", async () => {
    if (!runDistBuild()) return;

    for (const relativePath of DIST_BROWSER_SAFE_FILES) {
      const text = await Bun.file(join(projectRoot, relativePath)).text();

      expect(text).not.toMatch(/from\s+"node:/);
      expect(text).not.toMatch(/require\(\s*"node:/);
    }
  }, 60_000);

  // dist/registry-entry.js is the ./registry subpath's Node-only artifact
  // (registry.ts + roster-edit.ts, both fs/crypto/path consumers) — it is
  // NOT part of the browser-safe set and MAY legitimately contain node:
  // imports. Assert it's excluded from the browser-safe list above (a
  // regression here would mean someone widened DIST_BROWSER_SAFE_FILES to
  // include it) and that it actually exists post-build.
  test("dist/registry-entry.js is Node-lane, not part of the browser-safe artifact set", async () => {
    if (!runDistBuild()) return;

    expect(DIST_BROWSER_SAFE_FILES).not.toContain("dist/registry-entry.js");

    const text = await Bun.file(
      join(projectRoot, "dist/registry-entry.js"),
    ).text();
    expect(text.length).toBeGreaterThan(0);
  }, 60_000);
});
