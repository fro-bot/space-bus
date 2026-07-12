import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBusStatus } from "./bus_status";

// Fix 1 pin (plugin surface): a core `ok:false` error result — not just a
// success — must still carry the resolved-roster header. Exercises the
// not-found-session error path, which resolves context successfully but
// then fails inside status().
describe("bus_status tool: roster header on error paths (Fix 1)", () => {
  const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];
  let dir: string;
  let configDir: string;
  let rosterPath: string;

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "space-bus-status-alpha-"));
    configDir = mkdtempSync(join(tmpdir(), "space-bus-status-config-"));
    rosterPath = join(configDir, "spacebus.json");
    writeFileSync(
      rosterPath,
      JSON.stringify({
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [{ name: "alpha", path: dir, description: "Alpha" }],
      }),
    );
    process.env["SPACE_BUS_CONFIG"] = rosterPath;
  }

  function teardown(): void {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) {
      delete process.env["SPACE_BUS_CONFIG"];
    } else {
      process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
    }
  }

  test("not-found session error still carries the roster: header", async () => {
    setup();
    try {
      globalThis.fetch = (async () =>
        new Response(JSON.stringify([]), {
          status: 404,
        })) as unknown as typeof fetch;
      const busStatus = makeBusStatus(dir);
      let thrown: Error | undefined;
      try {
        await busStatus.execute(
          { sessionId: "ses_missing" },
          // biome-ignore lint: minimal stub, only `directory` is consumed
          { directory: dir } as any,
        );
      } catch (e) {
        thrown = e as Error;
      }
      expect(thrown).toBeDefined();
      expect(thrown?.message.startsWith("roster: ")).toBe(true);
      expect(thrown?.message).toContain(rosterPath);
    } finally {
      teardown();
    }
  });
});
