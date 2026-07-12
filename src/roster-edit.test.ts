import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestSchema } from "./config";
import { captureIdentity, removeDiscovery, writeDiscovery } from "./discovery";
import { readRegistry } from "./registry";
import {
  addProject,
  createRoster,
  editServer,
  removeProject,
  updateProject,
} from "./roster-edit";

// Each test gets its own fresh XDG_CONFIG_HOME (registry writes) in addition
// to test/setup.ts's suite-wide preload, plus its own scratch dir for
// roster files — same isolation pattern as registry.test.ts.
let perTestConfigHome: string;
let scratchDir: string;

beforeEach(() => {
  perTestConfigHome = mkdtempSync(
    join(tmpdir(), "space-bus-roster-edit-config-"),
  );
  process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
  scratchDir = mkdtempSync(join(tmpdir(), "space-bus-roster-edit-scratch-"));
});

afterEach(() => {
  rmSync(perTestConfigHome, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

function rosterPathFor(): string {
  return join(scratchDir, "spacebus.json");
}

describe("roster-edit: createRoster", () => {
  test("happy path: writes a valid managed-mode file and registers it", () => {
    const path = rosterPathFor();
    const result = createRoster({ name: "alpha", rosterPath: path });
    expect(result).toEqual({ ok: true });

    const raw = readFileSync(path, "utf8");
    const parsed = manifestSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.server.managed).toEqual({});
      expect(parsed.data.projects).toEqual([]);
    }

    const registry = readRegistry();
    expect(registry.ok).toBe(true);
    if (registry.ok) {
      expect(
        registry.registry.rosters.find((r) => r.name === "alpha"),
      ).toBeDefined();
    }
  });

  test("refuses to overwrite an existing file", () => {
    const path = rosterPathFor();
    writeFileSync(
      path,
      JSON.stringify({ server: { managed: {} }, projects: [] }),
    );
    const result = createRoster({ name: "beta", rosterPath: path });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("overwrite");
    }
  });

  test("registration collision (name already registered): preflight rejects BEFORE any write — no file created", () => {
    const firstPath = rosterPathFor();
    expect(createRoster({ name: "gamma", rosterPath: firstPath })).toEqual({
      ok: true,
    });

    const secondPath = join(scratchDir, "second-spacebus.json");
    const result = createRoster({ name: "gamma", rosterPath: secondPath });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("gamma");
    }
    // Preflight collision check runs before any write — the file must NOT
    // exist on disk.
    expect(existsSync(secondPath)).toBe(false);
  });
});

describe("roster-edit: createRoster mode + concurrency", () => {
  test("created file is mode 0644", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "modetest", rosterPath: path })).toEqual({
      ok: true,
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  test("concurrent createRoster at the same path: exactly one wins, the other fails, file is valid", async () => {
    const path = rosterPathFor();
    const [a, b] = await Promise.all([
      Promise.resolve().then(() =>
        createRoster({ name: "race-a", rosterPath: path }),
      ),
      Promise.resolve().then(() =>
        createRoster({ name: "race-b", rosterPath: path }),
      ),
    ]);
    const results = [a, b];
    const oks = results.filter((r) => r.ok);
    const fails = results.filter((r) => !r.ok);
    expect(oks.length).toBe(1);
    expect(fails.length).toBe(1);

    const parsed = manifestSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(parsed.success).toBe(true);
  });
});

describe("roster-edit: symlinked roster edit refusal", () => {
  test("editing a symlinked roster file is rejected, link and target left byte-identical", () => {
    const targetPath = rosterPathFor();
    expect(createRoster({ name: "symtarget", rosterPath: targetPath })).toEqual(
      { ok: true },
    );
    const linkPath = join(scratchDir, "spacebus-link.json");
    symlinkSync(targetPath, linkPath);

    const beforeTarget = readFileSync(targetPath);
    const beforeLinkResolved = readFileSync(linkPath); // via symlink, same bytes

    const result = addProject(linkPath, {
      name: "svc-a",
      path: "~/a",
      description: "A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("symlink");
    }

    const afterTarget = readFileSync(targetPath);
    const afterLinkResolved = readFileSync(linkPath);
    expect(Buffer.compare(beforeTarget, afterTarget)).toBe(0);
    expect(Buffer.compare(beforeLinkResolved, afterLinkResolved)).toBe(0);
  });
});

describe("roster-edit: mode preservation on edit", () => {
  test("editing a 0600 roster file preserves 0600", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "modepreserve", rosterPath: path })).toEqual({
      ok: true,
    });
    chmodSync(path, 0o600);

    expect(
      addProject(path, { name: "svc-a", path: "~/a", description: "A" }),
    ).toEqual({ ok: true });

    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("roster-edit: updateProject rename collision", () => {
  test("renaming a project to an already-existing name is rejected", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "renametest", rosterPath: path })).toEqual({
      ok: true,
    });
    expect(
      addProject(path, { name: "svc-a", path: "~/a", description: "A" }),
    ).toEqual({ ok: true });
    expect(
      addProject(path, { name: "svc-b", path: "~/b", description: "B" }),
    ).toEqual({ ok: true });

    const result = updateProject(path, "svc-a", { name: "svc-b" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("svc-b");
    }
  });

  test("hand-authored roster with duplicate project names is rejected by mutation validation", () => {
    const path = rosterPathFor();
    writeFileSync(
      path,
      JSON.stringify({
        server: { managed: {} },
        projects: [
          { name: "dup", path: "~/a", description: "A" },
          { name: "dup", path: "~/b", description: "B" },
        ],
      }),
    );
    const result = updateProject(path, "dup", { description: "changed" });
    expect(result.ok).toBe(false);
  });
});

describe("roster-edit: editServer live-daemon guard", () => {
  test("editServer is rejected when a live discovery record exists for the roster", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "livedaemon", rosterPath: path })).toEqual({
      ok: true,
    });

    const identity = captureIdentity(process.pid) ?? "";
    writeDiscovery(path, {
      port: 4096,
      pid: process.pid,
      identity,
      password: "test-password",
      spawnConfig: {},
      baseUrl: "http://127.0.0.1:4096",
      rosterPath: path,
    });

    const result = editServer(path, { baseUrl: "http://127.0.0.1:5000" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("stop");
    }

    removeDiscovery(path);
  });
});

describe("roster-edit: project round-trip", () => {
  test("addProject / updateProject / removeProject round-trip", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "delta", rosterPath: path })).toEqual({
      ok: true,
    });

    expect(
      addProject(path, {
        name: "svc-a",
        path: "~/code/svc-a",
        description: "Service A",
      }),
    ).toEqual({ ok: true });

    let manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.projects).toEqual([
      { name: "svc-a", path: "~/code/svc-a", description: "Service A" },
    ]);

    expect(
      updateProject(path, "svc-a", { description: "Service A, updated" }),
    ).toEqual({ ok: true });
    manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.projects[0]?.description).toBe("Service A, updated");

    expect(removeProject(path, "svc-a")).toEqual({ ok: true });
    manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.projects).toEqual([]);
  });

  test("addProject duplicate name is rejected", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "epsilon", rosterPath: path })).toEqual({
      ok: true,
    });
    expect(
      addProject(path, { name: "svc-a", path: "~/a", description: "A" }),
    ).toEqual({ ok: true });

    const dup = addProject(path, {
      name: "svc-a",
      path: "~/b",
      description: "B",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("svc-a");
  });

  test("removeProject unknown name lists known projects", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "zeta", rosterPath: path })).toEqual({
      ok: true,
    });
    expect(
      addProject(path, { name: "svc-a", path: "~/a", description: "A" }),
    ).toEqual({ ok: true });

    const result = removeProject(path, "svc-nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("svc-nonexistent");
      expect(result.error).toContain("svc-a");
    }
  });

  test("updateProject unknown name lists known projects", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "eta", rosterPath: path })).toEqual({
      ok: true,
    });
    const result = updateProject(path, "svc-nonexistent", {
      description: "x",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("svc-nonexistent");
    }
  });

  test("removeProject leaving zero projects still produces a valid roster", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "theta", rosterPath: path })).toEqual({
      ok: true,
    });
    expect(
      addProject(path, { name: "only", path: "~/only", description: "Only" }),
    ).toEqual({ ok: true });
    expect(removeProject(path, "only")).toEqual({ ok: true });

    const manifest = manifestSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(manifest.success).toBe(true);
    if (manifest.success) expect(manifest.data.projects).toEqual([]);
  });
});

describe("roster-edit: editServer", () => {
  test("managed -> baseUrl(loopback) -> managed round-trip", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "iota", rosterPath: path })).toEqual({
      ok: true,
    });

    expect(editServer(path, { baseUrl: "http://127.0.0.1:4096" })).toEqual({
      ok: true,
    });
    let manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.server.baseUrl).toBe("http://127.0.0.1:4096");
    expect(manifest.server.managed).toBeUndefined();

    expect(editServer(path, { managed: {} })).toEqual({ ok: true });
    manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(manifest.server.managed).toEqual({});
    expect(manifest.server.baseUrl).toBeUndefined();
  });

  test("non-loopback baseUrl is rejected AND the file is left byte-identical", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "kappa", rosterPath: path })).toEqual({
      ok: true,
    });
    const before = readFileSync(path);

    const result = editServer(path, {
      baseUrl: "http://evil.example:4096",
    });
    expect(result.ok).toBe(false);

    const after = readFileSync(path);
    expect(Buffer.compare(before, after)).toBe(0);
  });
});

describe("roster-edit: error cases on the file itself", () => {
  test("edit on a missing roster file is ok:false with an actionable message", () => {
    const path = join(scratchDir, "does-not-exist.json");
    const result = addProject(path, {
      name: "svc-a",
      path: "~/a",
      description: "A",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain(path);
    }
  });

  test("edit on a schema-invalid roster file is ok:false and the file is untouched", () => {
    const path = rosterPathFor();
    const invalidContent = JSON.stringify({ nonsense: true });
    writeFileSync(path, invalidContent);

    const result = addProject(path, {
      name: "svc-a",
      path: "~/a",
      description: "A",
    });
    expect(result.ok).toBe(false);

    const after = readFileSync(path, "utf8");
    expect(after).toBe(invalidContent);
  });
});

describe("roster-edit: integration (F2 flow)", () => {
  test("createRoster + addProject twice + readRegistry + parse through manifestSchema", () => {
    const path = rosterPathFor();
    expect(createRoster({ name: "lambda", rosterPath: path })).toEqual({
      ok: true,
    });
    expect(
      addProject(path, { name: "svc-a", path: "~/a", description: "A" }),
    ).toEqual({ ok: true });
    expect(
      addProject(path, { name: "svc-b", path: "~/b", description: "B" }),
    ).toEqual({ ok: true });

    const registry = readRegistry();
    expect(registry.ok).toBe(true);
    if (registry.ok) {
      const entry = registry.registry.rosters.find((r) => r.name === "lambda");
      expect(entry).toBeDefined();
    }

    const parsed = manifestSchema.safeParse(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.projects.map((p) => p.name).sort()).toEqual([
        "svc-a",
        "svc-b",
      ]);
    }
  });
});
