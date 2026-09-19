import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRegistry } from "../registry";
import { makeBusRegistry, type RegistrySession } from "./bus_registry";

// Same isolation pattern as registry.test.ts/roster-edit.test.ts: every
// test gets its own fresh XDG_CONFIG_HOME (registry writes) on top of
// test/setup.ts's suite-wide preload, plus a scratch dir for roster files.
let perTestConfigHome: string;
let scratchDir: string;

beforeEach(() => {
  perTestConfigHome = mkdtempSync(
    join(tmpdir(), "space-bus-bus-registry-config-"),
  );
  process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
  scratchDir = mkdtempSync(join(tmpdir(), "space-bus-bus-registry-scratch-"));
});

afterEach(() => {
  rmSync(perTestConfigHome, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
});

function rosterPathFor(name: string): string {
  return join(scratchDir, `${name}.json`);
}

function writeRosterFile(name: string): string {
  const path = rosterPathFor(name);
  writeFileSync(
    path,
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [],
    }),
  );
  return path;
}

// Honest fake session seam — a fresh instance per test, no module-level
// state, so tests never leak an "active roster" across each other. This
// is deliberately the same shape mcp.ts wires to its real module-level
// variable (see mcp.ts's `registrySession`), exercised here without
// depending on mcp.ts's process-global state (that variable is untestable
// in isolation — see the "edge" describe block below for why we
// characterize that limitation instead of trying to reset it).
function makeFakeSession(): RegistrySession {
  let active: string | undefined;
  return {
    getActive: () => active,
    setActive: (name: string) => {
      active = name;
    },
    clearActive: () => {
      active = undefined;
    },
  };
}

function outputText(result: unknown): string {
  return typeof result === "string"
    ? result
    : (result as { output: string }).output;
}

describe("bus_registry: list", () => {
  test("happy path: empty registry", async () => {
    const busRegistry = makeBusRegistry();
    const out = outputText(
      await busRegistry.execute(
        { action: "list" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    );
    expect(out).toContain("no rosters registered");
  });

  test("happy path: populated registry lists name/path/default flag", async () => {
    const path = writeRosterFile("alpha");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "alpha", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "set-default", name: "alpha" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    const out = outputText(
      await busRegistry.execute(
        { action: "list" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    );
    expect(out).toContain("alpha");
    expect(out).toContain(path);
    expect(out).toContain("default");
  });

  test("happy path: list shows session-active roster when a session seam is wired", async () => {
    const path = writeRosterFile("alpha");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "alpha", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "use", roster: "alpha" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    const out = outputText(
      await busRegistry.execute(
        { action: "list" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    );
    expect(out).toContain("active");
  });
});

describe("bus_registry: create", () => {
  test("happy path: creates file + registers it", async () => {
    const path = rosterPathFor("created");
    const busRegistry = makeBusRegistry();
    const out = (await busRegistry.execute(
      { action: "create", name: "created", path },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(out).toContain("created");
    const read = readRegistry();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.registry.rosters.some((r) => r.name === "created")).toBe(
        true,
      );
    }
  });
});

describe("bus_registry: create with server field (plugin-facing flat args)", () => {
  test("happy path: create with a server:{baseUrl} block through the flat args shape writes the file + registers it", async () => {
    const path = rosterPathFor("created-with-server");
    const busRegistry = makeBusRegistry();
    const out = outputText(
      await busRegistry.execute(
        {
          action: "create",
          name: "created-with-server",
          path,
          server: { baseUrl: "http://127.0.0.1:4096" },
        },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    );
    expect(out).toContain("created-with-server");

    const written = JSON.parse(readFileSync(path, "utf-8"));
    expect(written.server).toEqual({ baseUrl: "http://127.0.0.1:4096" });

    const read = readRegistry();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(
        read.registry.rosters.some((r) => r.name === "created-with-server"),
      ).toBe(true);
    }
  });
});

describe("bus_registry: register/unregister/set-default round-trip", () => {
  test("happy path", async () => {
    const path = writeRosterFile("beta");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "beta", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    let read = readRegistry();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.registry.rosters.map((r) => r.name)).toContain("beta");
    }

    await busRegistry.execute(
      { action: "set-default", name: "beta" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    read = readRegistry();
    if (read.ok) expect(read.registry.default).toBe("beta");

    await busRegistry.execute(
      { action: "unregister", name: "beta" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    read = readRegistry();
    if (read.ok) {
      expect(read.registry.rosters.map((r) => r.name)).not.toContain("beta");
    }
  });
});

describe("bus_registry: project management through registry names", () => {
  async function setup(): Promise<{
    busRegistry: ReturnType<typeof makeBusRegistry>;
  }> {
    const path = writeRosterFile("gamma");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "gamma", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    return { busRegistry };
  }

  test("happy path: add-project, update-project, remove-project", async () => {
    const { busRegistry } = await setup();

    const addOut = (await busRegistry.execute(
      {
        action: "add-project",
        roster: "gamma",
        project: { name: "svc", path: scratchDir, description: "svc desc" },
      },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(addOut).toContain("svc");

    const updateOut = (await busRegistry.execute(
      {
        action: "update-project",
        roster: "gamma",
        projectName: "svc",
        patch: { description: "updated desc" },
      },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(updateOut).toContain("svc");

    const removeOut = (await busRegistry.execute(
      { action: "remove-project", roster: "gamma", projectName: "svc" },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(removeOut).toContain("svc");
  });

  test("error: add-project to unregistered roster name lists known names", async () => {
    await setup(); // registers "gamma" so the error can list a known name
    const busRegistry = makeBusRegistry();
    await expect(
      busRegistry.execute(
        {
          action: "add-project",
          roster: "unknown-roster",
          project: { name: "x", path: scratchDir, description: "d" },
        },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/gamma/);
  });
});

describe("bus_registry: use", () => {
  test("happy path: use sets session active roster, subsequent getActive reflects it", async () => {
    const path = writeRosterFile("delta");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "delta", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    expect(session.getActive()).toBeUndefined();
    await busRegistry.execute(
      { action: "use", roster: "delta" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    expect(session.getActive()).toBe("delta");
  });

  test("error: use without a session seam (plugin surface) is an actionable error", async () => {
    const busRegistry = makeBusRegistry(); // no session — mirrors src/index.ts wiring
    await expect(
      busRegistry.execute(
        { action: "use", roster: "anything" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/connector-session concept/);
  });

  test("error: use with unknown name lists known names", async () => {
    const path = writeRosterFile("epsilon");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "epsilon", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await expect(
      busRegistry.execute(
        { action: "use", roster: "nonexistent" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/epsilon/);
  });
});

describe("bus_registry: edge — session state is ephemeral per factory instance", () => {
  // Documents the limit of testing module-level state directly: mcp.ts
  // wires bus_registry to a single module-level `activeRoster` variable
  // (one per stdio process/connection), which this test file does not
  // (and should not) import or mutate — importing mcp.ts would start the
  // stdio server. Instead, this test proves the underlying contract a
  // fresh RegistrySession/factory pairing has no active roster by
  // construction, which is what makes mcp.ts's module-level variable safe
  // (a fresh process/module load always starts undefined).
  test("a fresh session object has no active roster until use() is called", () => {
    const session = makeFakeSession();
    expect(session.getActive()).toBeUndefined();
  });

  test("two independent factory instances with separate sessions never share state", async () => {
    const path = writeRosterFile("zeta");
    const sessionA = makeFakeSession();
    const sessionB = makeFakeSession();
    const busRegistryA = makeBusRegistry(sessionA);
    makeBusRegistry(sessionB); // proves construction alone doesn't share state
    await busRegistryA.execute(
      { action: "register", name: "zeta", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistryA.execute(
      { action: "use", roster: "zeta" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    expect(sessionA.getActive()).toBe("zeta");
    expect(sessionB.getActive()).toBeUndefined();
  });
});

describe("bus_registry: unregister clears a matching session-active roster (Fix 5)", () => {
  test("unregistering the active roster clears session state", async () => {
    const path = writeRosterFile("alpha");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "alpha", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "use", roster: "alpha" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    expect(session.getActive()).toBe("alpha");
    const out = (await busRegistry.execute(
      { action: "unregister", name: "alpha" },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(session.getActive()).toBeUndefined();
    expect(out).toContain("session-active roster cleared");
  });

  test("unregistering a NON-active roster leaves the active roster intact", async () => {
    const pathA = writeRosterFile("alpha");
    const pathB = writeRosterFile("beta");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "alpha", path: pathA },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "register", name: "beta", path: pathB },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "use", roster: "alpha" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      { action: "unregister", name: "beta" },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    expect(session.getActive()).toBe("alpha");
  });
});

describe("bus_registry: canonical name on use/echo (Fix 6)", () => {
  test("use with different casing stores/echoes the canonical registered name", async () => {
    const path = writeRosterFile("main");
    const session = makeFakeSession();
    const busRegistry = makeBusRegistry(session);
    await busRegistry.execute(
      { action: "register", name: "main", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    const out = (await busRegistry.execute(
      { action: "use", roster: "MAIN" },
      // biome-ignore lint: minimal stub
      {} as any,
    )) as string;
    expect(session.getActive()).toBe("main");
    expect(out).toContain('"main"');
    const listOut = outputText(
      await busRegistry.execute(
        { action: "list" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    );
    expect(listOut).toContain("active");
  });
});

describe("bus_registry: absolute-path validation + empty-patch rejection (Fix 7)", () => {
  test("create with a relative path is rejected, no file created", async () => {
    const busRegistry = makeBusRegistry();
    const relPath = "relative/roster.json";
    await expect(
      busRegistry.execute(
        { action: "create", name: "relcheck", path: relPath },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/absolute/);
    const read = readRegistry();
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.registry.rosters.some((r) => r.name === "relcheck")).toBe(
        false,
      );
    }
  });

  test("update-project with an empty patch is rejected, roster file byte-identical", async () => {
    const path = writeRosterFile("gammapatch");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "gammapatch", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await busRegistry.execute(
      {
        action: "add-project",
        roster: "gammapatch",
        project: { name: "svc", path: scratchDir, description: "d" },
      },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    const before = readFileSync(path, "utf8");
    await expect(
      busRegistry.execute(
        {
          action: "update-project",
          roster: "gammapatch",
          projectName: "svc",
          patch: {},
        },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow();
    const after = readFileSync(path, "utf8");
    expect(after).toBe(before);
  });
});

describe("bus_registry: strict per-action schemas reject foreign fields (Fix 3)", () => {
  test.each([
    ["list", { action: "list", roster: "x" }, "roster"],
    ["use", { action: "use", roster: "x", path: "/abs" }, "path"],
    [
      "create",
      { action: "create", name: "x", path: "/abs", projectName: "y" },
      "projectName",
    ],
    [
      "register",
      { action: "register", name: "x", path: "/abs", roster: "y" },
      "roster",
    ],
    ["unregister", { action: "unregister", name: "x", path: "/abs" }, "path"],
    [
      "set-default",
      { action: "set-default", name: "x", roster: "y" },
      "roster",
    ],
    [
      "add-project",
      {
        action: "add-project",
        roster: "x",
        project: { name: "a", path: "/b", description: "c" },
        name: "y",
      },
      "name",
    ],
    [
      "remove-project",
      { action: "remove-project", roster: "x", projectName: "y", path: "/z" },
      "path",
    ],
    [
      "update-project",
      {
        action: "update-project",
        roster: "x",
        projectName: "y",
        patch: { description: "d" },
        server: {},
      },
      "server",
    ],
  ] as const)(
    "%s rejects a foreign field naming it",
    async (_action, args, foreignField) => {
      const busRegistry = makeBusRegistry();
      await expect(
        busRegistry.execute(
          args,
          // biome-ignore lint: minimal stub
          {} as any,
        ),
      ).rejects.toThrow(new RegExp(foreignField));
    },
  );
});

describe("bus_registry: per-action invalid-payload errors name the action", () => {
  test("create missing name/path", async () => {
    const busRegistry = makeBusRegistry();
    await expect(
      busRegistry.execute(
        { action: "create" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry create/);
  });

  test("register missing path", async () => {
    const busRegistry = makeBusRegistry();
    await expect(
      busRegistry.execute(
        { action: "register", name: "x" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry register/);
  });

  test("unregister unknown name", async () => {
    const busRegistry = makeBusRegistry();
    await expect(
      busRegistry.execute(
        { action: "unregister", name: "ghost" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry unregister/);
  });

  test("set-default unknown name", async () => {
    const busRegistry = makeBusRegistry();
    await expect(
      busRegistry.execute(
        { action: "set-default", name: "ghost" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry set-default/);
  });

  test("remove-project missing projectName", async () => {
    const path = writeRosterFile("eta");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "eta", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await expect(
      busRegistry.execute(
        { action: "remove-project", roster: "eta" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry remove-project/);
  });

  test("update-project missing patch", async () => {
    const path = writeRosterFile("theta");
    const busRegistry = makeBusRegistry();
    await busRegistry.execute(
      { action: "register", name: "theta", path },
      // biome-ignore lint: minimal stub
      {} as any,
    );
    await expect(
      busRegistry.execute(
        { action: "update-project", roster: "theta", projectName: "svc" },
        // biome-ignore lint: minimal stub
        {} as any,
      ),
    ).rejects.toThrow(/bus_registry update-project/);
  });
});
