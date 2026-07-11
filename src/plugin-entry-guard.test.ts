import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the OpenCode plugin-loader collision: OpenCode
// resolves a plugin package's entry as `exports["./server"]` BEFORE
// falling back to `main`. If that subpath ever points at the
// managed-server lifecycle module (dist/server.js — a namespace with
// non-function exports like SUPERVISE_FAILURE_THRESHOLD) instead of the
// actual plugin entry (dist/index.js — a single default function), the
// loader's V1 shape check throws "Plugin export is not a function" and
// the whole plugin fails to load. This test emulates that resolution
// step and asserts the resolved module has exactly the V1 shape OpenCode
// requires. It also asserts the lifecycle API is reachable at its
// relocated subpath, `./managed-server`.
//
// Runs against real build output (mirrors version-injection.test.ts's
// e2e pattern) so a `bun run build` regression is caught here too.

const projectRoot = join(import.meta.dir, "..");

function runBuild() {
  const bunPath = Bun.which("bun");
  if (!bunPath) {
    console.warn("bun not found on PATH, skipping build e2e test");
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

describe('plugin entry guard: exports["./server"] must resolve to the plugin entry', () => {
  test("loader-resolved entry has exactly one enumerable export, default, a function", async () => {
    if (!runBuild()) return;

    const pkg = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );

    // Mirror OpenCode's plugin loader resolution: exports["./server"]
    // (import condition) with a fallback to main.
    const resolved: string = pkg.exports?.["./server"]?.import ?? pkg.main;
    expect(typeof resolved).toBe("string");

    const mod = await import(join(projectRoot, resolved));
    const entries = Object.entries(mod);

    expect(entries.length).toBe(1);
    expect(entries[0]?.[0]).toBe("default");
    expect(typeof mod.default).toBe("function");
  }, 60_000);

  test('exports["./managed-server"] resolves to dist/server.js and it exists post-build', () => {
    if (!runBuild()) return;

    const pkg = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );

    const managedServerImport: string =
      pkg.exports?.["./managed-server"]?.import;
    expect(managedServerImport).toBe("./dist/server.js");
    expect(existsSync(join(projectRoot, managedServerImport))).toBe(true);
  }, 60_000);
});
