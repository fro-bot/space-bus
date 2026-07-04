import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRosterPath } from "./config";
import { discoveryFilePath, removeDiscovery } from "./discovery";
import SpaceBusPlugin from "./index";
import { stopServer } from "./server";

const STUB_COMMAND = ["bun", "test/fixtures/stub-server.ts"];
const REPO_ROOT = process.cwd();
const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];

function teardownEnv(): void {
  if (ORIGINAL_ENV === undefined) delete process.env["SPACE_BUS_CONFIG"];
  else process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
}

describe("managed roster wiring: plugin tools ensure before loadContext", () => {
  let dir: string;
  let rosterPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-wiring-managed-"));
    writeFileSync(
      join(dir, "spacebus.json"),
      JSON.stringify({
        server: { managed: { command: STUB_COMMAND, cwd: REPO_ROOT } },
        projects: [],
      }),
    );
    rosterPath = resolveRosterPath(dir);
  });

  afterEach(async () => {
    await stopServer(rosterPath);
    removeDiscovery(rosterPath);
    rmSync(dir, { recursive: true, force: true });
    teardownEnv();
  });

  test("bus_roster against a managed roster with the bus down: ensures (stub spawns) and the tool works", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: dir } as any,
    );
    const busRoster = hooks.tool?.bus_roster;
    // Nothing running yet — this call must transparently ensure a server
    // (spawning the stub), then succeed.
    const output = await busRoster?.execute(
      {},
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: dir } as any,
    );
    expect(typeof output).toBe("string");
  }, 20_000);
});

describe("managed roster wiring: baseUrl rosters never spawn", () => {
  let dir: string;
  let configDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-wiring-baseurl-"));
    configDir = mkdtempSync(join(tmpdir(), "space-bus-wiring-baseurl-cfg-"));
    writeFileSync(
      join(configDir, "spacebus.json"),
      JSON.stringify({
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [{ name: "alpha", path: dir, description: "Alpha" }],
      }),
    );
    process.env["SPACE_BUS_CONFIG"] = join(configDir, "spacebus.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    teardownEnv();
  });

  test("bus_roster against a baseUrl roster never attempts ensure/spawn — no stub process appears", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: dir } as any,
    );
    const busRoster = hooks.tool?.bus_roster;
    // No fetch mock and no live server on :4096 — if ensure() were called
    // for this baseUrl roster it would throw "ensureServer called on an
    // externally-managed roster ... nothing to spawn". It must NOT: the
    // adapter helper's isManagedRoster() gate must skip ensure entirely,
    // so the failure surfaced here is a plain connection error from
    // core's fetch to :4096, not a spawn-related one. No discovery file
    // is ever written for a baseUrl roster either way (nothing calls
    // writeDiscovery on this path).
    let thrown: Error | undefined;
    try {
      await busRoster?.execute(
        {},
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: dir } as any,
      );
    } catch (e) {
      thrown = e as Error;
    }
    // Whatever the outcome (network reachability of :4096 is
    // environment-dependent — something may already be listening there),
    // it must never be the ensureServer-on-externally-managed-roster
    // error, and no discovery file may ever be written for a baseUrl
    // roster (the adapter's isManagedRoster() gate must have skipped
    // ensure entirely).
    if (thrown) {
      expect(thrown.message).not.toMatch(
        /ensureServer called on an externally-managed/,
      );
    }
    expect(existsSync(discoveryFilePath(resolveRosterPath(dir)))).toBe(false);
  });
});
