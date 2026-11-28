import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the OpenCode plugin-loader collision: OpenCode
// resolves a plugin package's entry as `exports["./server"]` BEFORE
// falling back to `main`. If that subpath ever points at the
// managed-server lifecycle module (dist/server.js — a namespace with
// non-function exports like SUPERVISE_FAILURE_THRESHOLD) instead of the
// actual plugin entry (dist/index.js — a single default export), the
// loader's shape check rejects the module and the whole plugin fails to
// load. The entry is now the dual-host object `{ id, server, setup }` (v1
// hosts call `server`, v2 hosts call `setup`); it must stay the module's
// ONLY export, because a v1 host handed a legacy function default runs every
// named export as a plugin factory. This test emulates that resolution step
// and asserts the resolved module has exactly that shape. It also asserts the
// lifecycle API is reachable at its relocated subpath, `./managed-server`.
//
// Runs against real build output (mirrors version-injection.test.ts's
// e2e pattern) so a `bun run build` regression is caught here too.

const projectRoot = join(import.meta.dir, "..");

/** The dual-host entry shape both loaders accept: one `default` export, an
 * object with a stable id and the two native entry points. */
function isDualHostEntry(mod: Record<string, unknown>): boolean {
  const entries = Object.entries(mod);
  if (entries.length !== 1 || entries[0]?.[0] !== "default") return false;
  const def = mod["default"] as Record<string, unknown> | null;
  return (
    typeof def === "object" &&
    def !== null &&
    typeof def["id"] === "string" &&
    (def["id"] as string).length > 0 &&
    typeof def["server"] === "function" &&
    typeof def["setup"] === "function"
  );
}

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
  test("loader-resolved entry has exactly one enumerable export, default, a {id, server, setup} object", async () => {
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
    expect(isDualHostEntry(mod)).toBe(true);
    expect(Object.keys(mod.default).sort()).toEqual(["id", "server", "setup"]);
  }, 60_000);

  test("built entry and its declarations never reference the v1 peer; both entry points load with it unresolvable", async () => {
    if (!runBuild()) return;

    const built = readFileSync(join(projectRoot, "dist", "index.js"), "utf8");
    // A static import (or re-export) of the peer would be hoisted and fail on a
    // v2-only install before `setup` ever runs.
    expect(built).not.toMatch(
      /^\s*(import|export)\b[^\n;]*from\s*["']@opencode-ai\/plugin/m,
    );
    expect(built).not.toMatch(/^\s*import\s*["']@opencode-ai\/plugin/m);
    // The v1 adapter is SDK-free: no dynamic import and no type reference to
    // the peer survives into the bundle or the emitted declarations either.
    expect(built).not.toMatch(/["']@opencode-ai\/plugin["'/]/);
    const declarations = join(projectRoot, "dist", "plugin-v1.d.ts");
    expect(existsSync(declarations)).toBe(true);
    expect(readFileSync(declarations, "utf8")).not.toMatch(
      /["']@opencode-ai\/plugin["'/]/,
    );

    // And behaviorally: resolve nothing from the peer, then drive the built
    // entry through setup and a tool execute.
    const script = `
      import { plugin as bunPlugin } from "bun";
      bunPlugin({
        name: "block-v1-peer",
        setup(build) {
          // A virtual module that throws on load stands in for "peer absent".
          build.module("@opencode-ai/plugin", () => {
            throw new Error("V1_PEER_RESOLVED");
          });
        },
      });
      const { default: entry } = await import(${JSON.stringify(join(projectRoot, "dist", "index.js"))});
      const added = [];
      await entry.setup({
        location: { directory: "/tmp" },
        tool: { async transform(cb) { cb({ add: (t) => added.push(t) }); return { dispose: async () => {} }; } },
      });
      let failFast = "";
      try { await added.find((t) => t.name === "bus_task").execute({ prompt: "x" }, {}); } catch (e) { failFast = e.message; }
      let serverCount = 0;
      let serverError = "";
      try { serverCount = Object.keys((await entry.server({ directory: "/tmp" })).tool).length; } catch (e) { serverError = e.message; }
      let controlError = "";
      try { await import("@opencode-ai/plugin"); } catch (e) { controlError = e.message; }
      console.log(JSON.stringify({ count: added.length, failFast, serverCount, serverError, controlError }));
    `;
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    expect(JSON.parse(proc.stdout.toString())).toEqual({
      count: 6,
      failFast: "space-bus: project is required when starting a new session",
      // the v1 `server` entry loads and returns six tools without the peer ...
      serverCount: 6,
      serverError: "",
      // ... and the blocker is live (resolving the peer directly fails).
      controlError: "V1_PEER_RESOLVED",
    });
  }, 60_000);

  test("negative control: dist/server.js fails the V1 shape check the loader applies", async () => {
    if (!runBuild()) return;

    // The pre-fix exports map pointed exports["./server"] at dist/server.js.
    // Prove the guard's shape check actually discriminates: the lifecycle
    // module's namespace must FAIL the dual-host entry check (it exports
    // functions plus numeric constants), i.e. re-pointing the subpath back
    // would turn the positive test above red.
    const mod = await import(join(projectRoot, "./dist/server.js"));
    const entries = Object.entries(mod);

    expect(isDualHostEntry(mod)).toBe(false);
    // Specifically because of non-function exports (the loader's actual trip):
    expect(entries.some(([, v]) => typeof v !== "function")).toBe(true);
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

  test('exports["./registry"] is NOT exports["./server"], and the loader-resolved entry is unaffected by its presence', async () => {
    if (!runBuild()) return;

    const pkg = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );

    const registryImport: string = pkg.exports?.["./registry"]?.import;
    const serverImport: string = pkg.exports?.["./server"]?.import;
    expect(registryImport).toBeDefined();
    expect(registryImport).not.toBe(serverImport);
    expect(existsSync(join(projectRoot, registryImport))).toBe(true);

    // Re-run the loader-emulation check: adding "./registry" to the exports
    // map must not disturb exports["./server"] -> main -> dist/index.js
    // single-default-function resolution.
    const resolved: string = pkg.exports?.["./server"]?.import ?? pkg.main;
    const mod = await import(join(projectRoot, resolved));
    expect(isDualHostEntry(mod)).toBe(true);
  }, 60_000);
});
