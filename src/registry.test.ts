import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRegistry,
  registerRoster,
  registryPath,
  resolveRosterByName,
  setDefaultRoster,
  unregisterRoster,
} from "./registry";

// Each test in this file gets its OWN fresh XDG_CONFIG_HOME (in addition to
// test/setup.ts's suite-wide preload) so scenarios never contaminate each
// other's registry.json — e.g. the corrupted-JSON test must not leak into
// the "absent registry" test that runs elsewhere in the file.
let perTestConfigHome: string;

beforeEach(() => {
  perTestConfigHome = mkdtempSync(join(tmpdir(), "space-bus-registry-test-"));
  process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
});

afterEach(() => {
  rmSync(perTestConfigHome, { recursive: true, force: true });
});

function makeRosterFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "space-bus-roster-fixture-"));
  const path = join(dir, "spacebus.json");
  writeFileSync(
    path,
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4000" },
      projects: [],
    }),
  );
  return path;
}

describe("registry: test isolation", () => {
  test("XDG_CONFIG_HOME is redirected to a temp dir (never the real user config)", () => {
    const value = process.env["XDG_CONFIG_HOME"];
    expect(value).toBeDefined();
    expect(value).not.toBe(join(process.env["HOME"] ?? "", ".config"));
    expect(value).toContain(tmpdir());
  });
});

describe("registry: happy path", () => {
  test("register two rosters, list both, default flagged, resolve returns canonical path", () => {
    const rosterA = realpathSync(makeRosterFile());
    const rosterB = realpathSync(makeRosterFile());

    expect(registerRoster("alpha", rosterA)).toEqual({ ok: true });
    expect(registerRoster("beta", rosterB)).toEqual({ ok: true });

    const listed = readRegistry();
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.registry.rosters.map((r) => r.name).sort()).toEqual([
      "alpha",
      "beta",
    ]);

    expect(setDefaultRoster("alpha")).toEqual({ ok: true });
    const afterDefault = readRegistry();
    expect(afterDefault.ok).toBe(true);
    if (!afterDefault.ok) return;
    expect(afterDefault.registry.default).toBe("alpha");

    const resolved = resolveRosterByName("beta");
    expect(resolved).toEqual({ ok: true, path: rosterB });
  });
});

describe("registry: edge cases", () => {
  test("absent registry file is an empty, ok registry (not an error)", () => {
    const result = readRegistry();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.registry).toEqual({ version: 1, rosters: [] });
    }
  });

  test("duplicate name is rejected naming the collision (schema enforces lowercase, so uniqueness is inherently case-insensitive)", () => {
    const rosterA = makeRosterFile();
    const rosterB = makeRosterFile();
    expect(registerRoster("gamma", rosterA)).toEqual({ ok: true });

    const collision = registerRoster("gamma", rosterB);
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.error).toContain("gamma");
    }
  });

  test("unregister keeps the roster file on disk", () => {
    const rosterA = makeRosterFile();
    expect(registerRoster("delta", rosterA)).toEqual({ ok: true });
    expect(unregisterRoster("delta")).toEqual({ ok: true });

    // roster file itself must still exist
    expect(() => statSync(rosterA)).not.toThrow();

    const listed = readRegistry();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(
        listed.registry.rosters.find((r) => r.name === "delta"),
      ).toBeUndefined();
    }
  });

  test("unregistering the default clears the default pointer", () => {
    const rosterA = makeRosterFile();
    expect(registerRoster("epsilon", rosterA)).toEqual({ ok: true });
    expect(setDefaultRoster("epsilon")).toEqual({ ok: true });
    expect(unregisterRoster("epsilon")).toEqual({ ok: true });

    const listed = readRegistry();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.registry.default).toBeUndefined();
    }
  });
});

describe("registry: integration", () => {
  test("register -> set-default -> resolve round-trip; file mode 0600, dir mode 0700", () => {
    const rosterA = realpathSync(makeRosterFile());
    expect(registerRoster("iota", rosterA)).toEqual({ ok: true });
    expect(setDefaultRoster("iota")).toEqual({ ok: true });
    expect(resolveRosterByName("iota")).toEqual({ ok: true, path: rosterA });

    const path = registryPath();
    const fileStat = statSync(path);
    expect(fileStat.mode & 0o777).toBe(0o600);
    const dirStat = statSync(join(path, ".."));
    expect(dirStat.mode & 0o777).toBe(0o700);
  });
});

describe("registry: error cases", () => {
  test("registering a nonexistent roster path fails", () => {
    const missing = join(tmpdir(), "space-bus-does-not-exist", "spacebus.json");
    const result = registerRoster("zeta", missing);
    expect(result.ok).toBe(false);
  });

  test("registering a symlinked roster path is rejected naming the path", () => {
    const rosterA = makeRosterFile();
    const dir = mkdtempSync(join(tmpdir(), "space-bus-symlink-fixture-"));
    const linkPath = join(dir, "spacebus-link.json");
    symlinkSync(rosterA, linkPath);

    const result = registerRoster("eta", linkPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(linkPath);
      expect(result.error).toContain("symlink");
    }
  });

  test("invalid name charset is rejected", () => {
    const rosterA = makeRosterFile();
    const invalidNames = [
      "Uppercase",
      "has space",
      "has/slash",
      "a".repeat(65),
    ];
    for (const name of invalidNames) {
      const result = registerRoster(name, rosterA);
      expect(result.ok).toBe(false);
    }
  });

  test("corrupted registry JSON: readRegistry ok:false actionable; registerRoster does not clobber it", () => {
    const path = registryPath();
    const dir = join(path, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, "{ this is not valid json");

    const read = readRegistry();
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error).toContain("not valid JSON");
    }

    const rosterA = makeRosterFile();
    const register = registerRoster("theta", rosterA);
    expect(register.ok).toBe(false);

    // The corrupt file must not have been clobbered by the failed register.
    const stillCorrupt = readRegistry();
    expect(stillCorrupt.ok).toBe(false);
  });
});
