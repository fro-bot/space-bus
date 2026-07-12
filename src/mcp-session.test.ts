import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoster } from "./registry";
import { makeBusRegistry, type RegistrySession } from "./tools/bus_registry";

// Unit 5's session-state seam is exercised directly here (the honest seam
// the plan calls for) rather than by spawning src/mcp.ts as a stdio
// process — mcp.ts wires this exact RegistrySession shape to a
// module-level `activeRoster` variable (see mcp.ts's `registrySession`);
// importing mcp.ts in a test would start its stdio transport. This test
// proves the seam contract mcp.ts depends on: `use` mutates the session,
// and a later read observes it — the same shape mcpLoadContext's
// `rosterName ?? activeRoster` ambient-resolution precedence relies on.
describe("mcp session-state seam (Unit 5)", () => {
  let configHome: string;
  let scratchDir: string;

  function setup(): void {
    configHome = mkdtempSync(join(tmpdir(), "space-bus-mcp-session-config-"));
    process.env["XDG_CONFIG_HOME"] = configHome;
    scratchDir = mkdtempSync(join(tmpdir(), "space-bus-mcp-session-scratch-"));
  }

  function teardown(): void {
    rmSync(configHome, { recursive: true, force: true });
    rmSync(scratchDir, { recursive: true, force: true });
  }

  test("use() sets the session's active roster; subsequent ambient resolution (rosterName ?? activeRoster) picks it up", async () => {
    setup();
    try {
      const rosterPath = join(scratchDir, "spacebus.json");
      writeFileSync(
        rosterPath,
        JSON.stringify({
          server: { baseUrl: "http://127.0.0.1:4096" },
          projects: [],
        }),
      );
      expect(registerRoster("mainboard", rosterPath)).toEqual({ ok: true });

      let activeRoster: string | undefined;
      const session: RegistrySession = {
        getActive: () => activeRoster,
        setActive: (name) => {
          activeRoster = name;
        },
        clearActive: () => {
          activeRoster = undefined;
        },
      };

      const busRegistry = makeBusRegistry(session);
      await busRegistry.execute(
        { action: "use", roster: "mainboard" },
        // biome-ignore lint: minimal stub
        {} as any,
      );

      // Mirrors mcp.ts's mcpLoadContext precedence: explicit rosterName
      // (undefined here) ?? session.getActive().
      const explicitRosterName: string | undefined = undefined;
      const effectiveRosterName = explicitRosterName ?? session.getActive();
      expect(effectiveRosterName).toBe("mainboard");
    } finally {
      teardown();
    }
  });

  test("edge: a fresh session has no active roster (ephemeral, process-local)", () => {
    let activeRoster: string | undefined;
    const session: RegistrySession = {
      getActive: () => activeRoster,
      setActive: (name) => {
        activeRoster = name;
      },
      clearActive: () => {
        activeRoster = undefined;
      },
    };
    expect(session.getActive()).toBeUndefined();
    void activeRoster;
  });
});
