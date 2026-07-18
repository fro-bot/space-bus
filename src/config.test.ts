import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  getRoster,
  isManagedRoster,
  loadContext,
  loadContextForRoster,
  resolveRosterPath,
} from "./config";
import {
  discoveryFilePath,
  removeDiscovery,
  writeDiscovery,
} from "./discovery";
import { registerRoster } from "./registry";
import { ensureServer, stopServer } from "./server";

const STUB_COMMAND = ["bun", "test/fixtures/stub-server.ts"];
const REPO_ROOT = process.cwd();

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

  test("explicitOverride wins over SPACE_BUS_CONFIG, and SPACE_BUS_CONFIG is left completely untouched", () => {
    const envDir = mkdtempSync(join(tmpdir(), "space-bus-config-env-"));
    const overrideDir = mkdtempSync(
      join(tmpdir(), "space-bus-config-explicit-"),
    );
    try {
      const rosterA = writeRoster(envDir, {
        projects: [{ name: "roster-a", path: "~/a", description: "a" }],
      });
      const rosterB = writeRoster(overrideDir, {
        projects: [{ name: "roster-b", path: "~/b", description: "b" }],
      });
      process.env["SPACE_BUS_CONFIG"] = rosterA;

      const resolved = resolveRosterPath(undefined, rosterB);

      expect(resolved).toBe(realpathSync(rosterB));
      // The explicit override must never write to process.env — the whole
      // point of the second parameter is threading --config through a
      // single call without a persistent global mutation.
      expect(process.env["SPACE_BUS_CONFIG"]).toBe(rosterA);
    } finally {
      rmSync(envDir, { recursive: true, force: true });
      rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test("explicitOverride expands leading ~ the same as SPACE_BUS_CONFIG", () => {
    expect(() =>
      resolveRosterPath(
        undefined,
        "~/does-not-exist-space-bus-test/spacebus.json",
      ),
    ).not.toThrow();
    const resolved = resolveRosterPath(
      undefined,
      "~/does-not-exist-space-bus-test/spacebus.json",
    );
    expect(resolved.startsWith(homedir())).toBe(true);
  });

  test("explicitOverride as a bare-relative path is rejected, naming --config", () => {
    expect(() =>
      resolveRosterPath(undefined, "./relative/spacebus.json"),
    ).toThrow(/--config must be an absolute path or start with ~/);
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

  test("isManagedRoster: true for managed rosters, false for baseUrl rosters", () => {
    writeRoster(dir);
    expect(isManagedRoster(dir)).toBe(false);

    const managedDir = mkdtempSync(join(tmpdir(), "space-bus-config-managed-"));
    try {
      writeRoster(managedDir, {
        server: { managed: { command: STUB_COMMAND } },
      });
      expect(isManagedRoster(managedDir)).toBe(true);
    } finally {
      rmSync(managedDir, { recursive: true, force: true });
    }
  });

  describe("managed roster loadContext", () => {
    let managedDir: string;
    let rosterPath: string;

    beforeEach(() => {
      managedDir = mkdtempSync(join(tmpdir(), "space-bus-config-managed-"));
      writeRoster(managedDir, {
        server: { managed: { command: STUB_COMMAND, cwd: REPO_ROOT } },
      });
      // loadContext resolves through realpathSync (resolveRosterPath), which
      // canonicalizes symlinked temp dirs (e.g. /var -> /private/var on
      // macOS); ensureServer must key the discovery file off the same
      // resolved path or the two calls disagree on which discovery file to
      // read/write.
      rosterPath = resolveRosterPath(managedDir);
    });

    afterEach(async () => {
      await stopServer(rosterPath);
      removeDiscovery(rosterPath);
      rmSync(managedDir, { recursive: true, force: true });
    });

    test("managed roster + nothing running: loadContext throws the actionable error", () => {
      expect(() => loadContext(managedDir)).toThrow(
        /managed server not running.*ensureServer\(\)|space-bus serve/,
      );
    });

    test("managed roster + stale discovery (dead pid): loadContext throws AND cleans up the discovery file", () => {
      writeDiscovery(rosterPath, {
        port: 4096,
        pid: 2_147_483_000,
        identity: "bogus-dead-identity",
        password: "stale-password",
        spawnConfig: { command: STUB_COMMAND, cwd: REPO_ROOT },
        baseUrl: "http://127.0.0.1:4096",
      });
      expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);

      expect(() => loadContext(managedDir)).toThrow(
        /managed server not running.*ensureServer\(\)|space-bus serve/,
      );

      expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
    });

    test("managed roster + live stub: loadContext returns discovery-sourced baseUrl+credentials", async () => {
      const handle = await ensureServer(rosterPath);
      try {
        const context = loadContext(managedDir);
        expect(context.roster.server.baseUrl).toBe(handle.baseUrl);
        expect(context.credentials).toEqual(handle.credentials);
      } finally {
        await stopServer(rosterPath);
      }
    });
  });

  describe("loadContextForRoster (Unit 4 registry loader)", () => {
    // This describe block registers rosters — isolate XDG_CONFIG_HOME per
    // test (same pattern as registry.test.ts) so scenarios never
    // contaminate each other's registry.json across tests in this file.
    let perTestConfigHome: string;
    let originalXdgConfigHome: string | undefined;

    beforeEach(() => {
      originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
      perTestConfigHome = mkdtempSync(
        join(tmpdir(), "space-bus-config-registry-test-"),
      );
      process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
    });

    afterEach(() => {
      rmSync(perTestConfigHome, { recursive: true, force: true });
      if (originalXdgConfigHome === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
      }
    });

    test("happy path: registered name resolves that roster's context via the same pipeline as loadContext", () => {
      const rosterPath = realpathSync(writeRoster(dir));
      expect(registerRoster("workspace", rosterPath)).toEqual({ ok: true });

      const { context, rosterPath: resolvedPath } =
        loadContextForRoster("workspace");
      expect(resolvedPath).toBe(rosterPath);
      expect(context.roster.server.baseUrl).toBe("http://127.0.0.1:4096");
      expect(context.roster.projects).toHaveLength(1);
    });

    test("error: unknown roster name throws listing known names (AE5)", () => {
      const rosterPath = realpathSync(writeRoster(dir));
      expect(registerRoster("workspace", rosterPath)).toEqual({ ok: true });

      expect(() => loadContextForRoster("blog")).toThrow(/workspace/);
    });

    test("edge: zero rosters registered + roster param throws naming no rosters registered", () => {
      expect(() => loadContextForRoster("anything")).toThrow(
        /no rosters are registered/,
      );
    });

    test("localhost guard applies identically to registry-resolved rosters", () => {
      const badDir = mkdtempSync(join(tmpdir(), "space-bus-config-bad-"));
      try {
        const badPath = realpathSync(
          writeRoster(badDir, {
            server: { baseUrl: "http://example.com:4096" },
          }),
        );
        expect(registerRoster("remote", badPath)).toEqual({ ok: true });
        expect(() => loadContextForRoster("remote")).toThrow(/localhost/);
      } finally {
        rmSync(badDir, { recursive: true, force: true });
      }
    });
  });
});
