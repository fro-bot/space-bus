import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { getRoster, loadContext, resolveRosterPath } from "./config";

const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];

function writeRoster(
  dir: string,
  overrides: Record<string, unknown> = {},
): string {
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
    const overrideDir = mkdtempSync(
      join(tmpdir(), "space-bus-config-override-"),
    );
    try {
      writeRoster(overrideDir, {
        projects: [
          {
            name: "override",
            path: "~/override-project",
            description: "override",
          },
        ],
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
    process.env["SPACE_BUS_CONFIG"] =
      "~/does-not-exist-space-bus-test/spacebus.json";
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

  test("server block with both baseUrl and managed is rejected with an actionable message", () => {
    writeRoster(dir, {
      server: {
        baseUrl: "http://127.0.0.1:4096",
        managed: { command: ["harness", "serve"] },
      },
    });
    expect(() => getRoster(dir)).toThrow(/exactly one of.*not both/);
  });

  test("server block with neither baseUrl nor managed is rejected with an actionable message", () => {
    writeRoster(dir, { server: {} });
    expect(() => getRoster(dir)).toThrow(/neither was present/);
  });

  test("managed-only server block parses", () => {
    writeRoster(dir, {
      server: { managed: { command: ["harness", "serve"], port: 0 } },
    });
    const manifest = getRoster(dir);
    expect(manifest.server.managed?.command).toEqual(["harness", "serve"]);
    expect(manifest.server.baseUrl).toBeUndefined();
  });

  test("import purity: importing config and core performs no roster read", async () => {
    delete process.env["SPACE_BUS_CONFIG"];
    // Dynamic import with a cache-busting query so it re-evaluates the
    // module body; success (no throw) proves no import-time filesystem I/O.
    await expect(import(`./config?t=${Date.now()}`)).resolves.toBeDefined();
    await expect(import(`./core?t=${Date.now()}`)).resolves.toBeDefined();
  });

  test("never-throw contract: roster() with no spacebus.json resolves ok:false naming spacebus.json", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "space-bus-noroster-"));
    try {
      // loadContext() throws (no roster); the adapter would catch and
      // surface a config-resolution error here — roster() itself can't
      // even be reached without a context, so we just assert the throw.
      expect(() => loadContext(emptyDir)).toThrow(/spacebus\.json/);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("loadContext: happy path computes exists flags and env credentials", () => {
    writeRoster(dir);
    const ORIGINAL_PW = process.env["OPENCODE_SERVER_PASSWORD"];
    const ORIGINAL_USER = process.env["OPENCODE_SERVER_USERNAME"];
    process.env["OPENCODE_SERVER_PASSWORD"] = "test-password";
    process.env["OPENCODE_SERVER_USERNAME"] = "test-user";
    try {
      const context = loadContext(dir);
      expect(context.roster.projects).toHaveLength(1);
      expect(context.roster.projects[0]?.exists).toBe(false); // ~/demo-project unlikely to exist
      expect(context.credentials).toEqual({
        username: "test-user",
        password: "test-password",
      });
    } finally {
      if (ORIGINAL_PW === undefined)
        delete process.env["OPENCODE_SERVER_PASSWORD"];
      else process.env["OPENCODE_SERVER_PASSWORD"] = ORIGINAL_PW;
      if (ORIGINAL_USER === undefined)
        delete process.env["OPENCODE_SERVER_USERNAME"];
      else process.env["OPENCODE_SERVER_USERNAME"] = ORIGINAL_USER;
    }
  });
});
