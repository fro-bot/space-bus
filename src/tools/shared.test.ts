import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoster, unregisterRoster } from "../registry";
import { ensureAndLoadContext } from "./shared";

// Fix 2 pin: the registry name must be resolved to a path exactly ONCE per
// call — every subsequent step (ensureServer, context load) must use that
// SAME resolved path, never re-resolving the (mutable) registry name. This
// closes a TOCTOU window where the name could be re-registered to a
// different path between the ensureServer call and the context load.
//
// Honest seam: ensureAndLoadContext takes an injectable `ensure` function
// (defaulting to the real ensureServer). This test rebinds the registry
// entry mid-call, INSIDE the injected `ensure` callback — simulating a
// concurrent re-registration racing the resolved call — and asserts the
// context loaded afterward still reflects the roster at the ORIGINAL path
// (proving no second name-resolution happened after the rebind).
describe("ensureAndLoadContext: resolves the registry name exactly once (Fix 2)", () => {
  let perTestConfigHome: string;
  let scratchDir: string;

  beforeEach(() => {
    perTestConfigHome = mkdtempSync(
      join(tmpdir(), "space-bus-shared-toctou-config-"),
    );
    process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
    scratchDir = mkdtempSync(join(tmpdir(), "space-bus-shared-toctou-"));
  });

  afterEach(() => {
    rmSync(perTestConfigHome, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  });

  function writeRoster(baseUrl: string): string {
    const path = join(scratchDir, `${baseUrl.replace(/[^a-z0-9]/gi, "")}.json`);
    writeFileSync(path, JSON.stringify({ server: { baseUrl }, projects: [] }));
    return path;
  }

  test("loaded context reflects the path resolved BEFORE a mid-call re-registration, not after", async () => {
    const pathA = writeRoster("http://127.0.0.1:4096");
    const pathB = writeRoster("http://127.0.0.1:4097");
    expect(registerRoster("racer", pathA)).toEqual({ ok: true });

    // A managed roster is required to reach the `ensure` seam at all — an
    // externally-managed (baseUrl) roster skips ensure(). So flip pathA's
    // file to managed AFTER registering it (registerRoster validates at
    // registration time only) — actually simplest: register a managed
    // roster directly.
    const managedPath = join(scratchDir, "managed.json");
    writeFileSync(
      managedPath,
      JSON.stringify({ server: { managed: {} }, projects: [] }),
    );
    expect(registerRoster("managed-racer", managedPath)).toEqual({
      ok: true,
    });

    let sawEnsureCall = false;
    let ensurePath: string | undefined;
    let thrown: Error | undefined;
    try {
      await ensureAndLoadContext(
        undefined,
        "managed-racer",
        async (rosterPath: string) => {
          sawEnsureCall = true;
          ensurePath = rosterPath;
          // Simulate a concurrent unregister+re-register swapping the name
          // to a different path WHILE ensure() is in flight — if
          // ensureAndLoadContext re-resolved the name after this point, the
          // subsequent context load would follow pathB instead of the
          // already-resolved managed.json path.
          unregisterRoster("managed-racer");
          expect(registerRoster("managed-racer", pathB)).toEqual({ ok: true });
        },
      );
    } catch (e) {
      // No live managed server is actually running for managed.json, so the
      // context load after ensure() throws "managed server not running" —
      // expected. What matters is which PATH it complained about.
      thrown = e as Error;
    }

    expect(sawEnsureCall).toBe(true);
    expect(ensurePath).toContain("managed.json");
    // The error must name the ORIGINALLY resolved path (managed.json), not
    // pathB — proving no second name-resolution happened after the rebind.
    expect(thrown).toBeDefined();
    expect(thrown?.message).toContain("managed.json");
    expect(thrown?.message).not.toContain(pathB);
  });
});
