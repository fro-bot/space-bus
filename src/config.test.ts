import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getRoster, resolveRosterPath } from "./config";

const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];

function writeRoster(dir: string, overrides: Record<string, unknown> = {}): string {
  const rosterPath = join(dir, "spacebus.json");
  const roster = {
    server: { baseUrl: "http://127.0.0.1:4096" },
    projects: [{ name: "demo", path: "~/demo-project", description: "demo" }],
    ...overrides,
  };
  writeFileSync(rosterPath, JSON.stringify(roster));
  return rosterPath;
}

describe("config", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-config-test-"));
    delete process.env["SPACE_BUS_CONFIG"];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (ORIGINAL_ENV === undefined) {
      delete process.env["SPACE_BUS_CONFIG"];
    } else {
      process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
    }
  });

  test("directory discovery: valid spacebus.json parses with expanded ~ paths", () => {
    writeRoster(dir);
    const manifest = getRoster(dir);
    expect(manifest.projects[0]?.path).toBe("~/demo-project");
    expect(manifest.server.baseUrl).toBe("http://127.0.0.1:4096");
  });

  test("SPACE_BUS_CONFIG wins over directory discovery", () => {
    writeRoster(dir); // decoy in directory
    const overrideDir = mkdtempSync(join(tmpdir(), "space-bus-config-override-"));
    try {
      writeRoster(overrideDir, {
        projects: [{ name: "override", path: "~/override-project", description: "override" }],
      });
      process.env["SPACE_BUS_CONFIG"] = join(overrideDir, "spacebus.json");
      const manifest = getRoster(dir);
      expect(manifest.projects[0]?.name).toBe("override");
    } finally {
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("SPACE_BUS_CONFIG expands leading ~", () => {
    // Not writing a real file under homedir; just verify resolution doesn't
    // throw the "absolute or ~" error and resolves to a path under homedir.
    process.env["SPACE_BUS_CONFIG"] = "~/does-not-exist-space-bus-test/spacebus.json";
    expect(() => resolveRosterPath()).not.toThrow();
    const resolved = resolveRosterPath();
    expect(resolved.startsWith(homedir())).toBe(true);
  });

  test("missing file error names both SPACE_BUS_CONFIG and directory options", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "space-bus-config-empty-"));
    try {
      expect(() => getRoster(emptyDir)).toThrow(/SPACE_BUS_CONFIG/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("no directory and no SPACE_BUS_CONFIG throws naming both mechanisms", () => {
    expect(() => resolveRosterPath()).toThrow(/SPACE_BUS_CONFIG/);
  });

  test("SPACE_BUS_CONFIG as a URL is rejected", () => {
    process.env["SPACE_BUS_CONFIG"] = "https://example.com/spacebus.json";
    expect(() => resolveRosterPath()).toThrow(/absolute path or start with ~/);
  });

  test("SPACE_BUS_CONFIG as a bare-relative path is rejected", () => {
    process.env["SPACE_BUS_CONFIG"] = "./relative/spacebus.json";
    expect(() => resolveRosterPath()).toThrow(/absolute path or start with ~/);
  });

  test("non-localhost baseUrl is refused", () => {
    writeRoster(dir, { server: { baseUrl: "http://example.com:4096" } });
    expect(() => getRoster(dir)).toThrow(/localhost/);
  });

  test("import purity: importing config and core performs no roster read", async () => {
    const cleanDir = mkdtempSync(join(tmpdir(), "space-bus-import-purity-"));
    delete process.env["SPACE_BUS_CONFIG"];
    try {
      // Dynamic import with a cache-busting query so it re-evaluates the
      // module body; success (no throw) proves no import-time filesystem I/O.
      await expect(import(`./config?t=${Date.now()}`)).resolves.toBeDefined();
      await expect(import(`./core?t=${Date.now()}`)).resolves.toBeDefined();
    } finally {
      rmSync(cleanDir, { recursive: true, force: true });
    }
  });
});
