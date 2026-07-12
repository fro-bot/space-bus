import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadContext,
  loadContextForRosterPath,
  resolveRosterPath,
} from "./config";
import { readRegistry, registerRoster, setDefaultRoster } from "./registry";

// Fix 8 pin: mcp.ts's mcpLoadContext ambient branch falls back to the
// registry default when SPACE_BUS_CONFIG is unset. mcp.ts itself can't be
// imported directly in tests (it starts a stdio transport on import — see
// mcp-session.test.ts's note), so this test exercises the same
// building-block seam mcpLoadContext is built from (resolveRosterPath,
// readRegistry, loadContextForRosterPath) and asserts the precedence
// mcpLoadContext implements: SPACE_BUS_CONFIG wins when set; the registry
// default is consulted only when it's unset (or unresolvable).
describe("MCP ambient resolution: registry-default fallback (Fix 8)", () => {
  let perTestConfigHome: string;
  let scratchDir: string;
  const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];

  beforeEach(() => {
    perTestConfigHome = mkdtempSync(
      join(tmpdir(), "space-bus-mcp-ambient-config-"),
    );
    process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
    scratchDir = mkdtempSync(join(tmpdir(), "space-bus-mcp-ambient-scratch-"));
    delete process.env["SPACE_BUS_CONFIG"];
  });

  afterEach(() => {
    rmSync(perTestConfigHome, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) delete process.env["SPACE_BUS_CONFIG"];
    else process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
  });

  function writeRoster(name: string, baseUrl: string): string {
    const path = join(scratchDir, `${name}.json`);
    writeFileSync(path, JSON.stringify({ server: { baseUrl }, projects: [] }));
    return path;
  }

  // Mirrors mcp.ts's mcpLoadContext ambient-fallback logic exactly: try
  // SPACE_BUS_CONFIG resolution first, and on failure, fall back to the
  // registry default resolved via the once-only registry->path pipeline.
  function ambientLoad(): { rosterPath: string } {
    try {
      const rosterPath = resolveRosterPath();
      loadContext();
      return { rosterPath };
    } catch {
      const read = readRegistry();
      if (read.ok && read.registry.default !== undefined) {
        const entry = read.registry.rosters.find(
          (r) => r.name.toLowerCase() === read.registry.default?.toLowerCase(),
        );
        if (entry) {
          loadContextForRosterPath(entry.path);
          return { rosterPath: entry.path };
        }
      }
      throw new Error("space-bus: no ambient roster resolvable");
    }
  }

  test("with SPACE_BUS_CONFIG unset and a registry default set, resolution loads the default", () => {
    const betaPath = writeRoster("beta", "http://127.0.0.1:4096");
    expect(registerRoster("beta", betaPath)).toEqual({ ok: true });
    expect(setDefaultRoster("beta")).toEqual({ ok: true });

    const loaded = ambientLoad();
    expect(loaded.rosterPath).toBe(realpathSync(betaPath));
  });

  test("with SPACE_BUS_CONFIG set, it wins over the registry default", () => {
    const betaPath = writeRoster("beta", "http://127.0.0.1:4096");
    expect(registerRoster("beta", betaPath)).toEqual({ ok: true });
    expect(setDefaultRoster("beta")).toEqual({ ok: true });

    const explicitPath = writeRoster("explicit", "http://127.0.0.1:4097");
    process.env["SPACE_BUS_CONFIG"] = explicitPath;

    const loaded = ambientLoad();
    expect(loaded.rosterPath).not.toBe(betaPath);
    expect(loaded.rosterPath).toContain("explicit.json");
  });
});
