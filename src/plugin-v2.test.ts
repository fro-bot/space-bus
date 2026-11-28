import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import plugin from "./index";
import { setupV2, type V2SetupContext } from "./plugin-v2";
import { registerRoster } from "./registry";
import { BUS_REGISTRY_DESCRIPTION } from "./tools/bus_registry";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";
import { BUS_WAIT_DESCRIPTION } from "./tools/bus_wait";

// The v2 adapter is exercised against a recording fake of the host's setup
// context: it captures the synchronous transform callback exactly as the real
// host would replay it, so these tests drive the same registration + execute
// path the loader does (the loader itself is covered by the U1 host matrix).

type RecordedTool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute: (
    input: unknown,
    context: unknown,
  ) => Promise<{ content: string; metadata?: Record<string, unknown> }>;
};

function makeFakeContext(directory: string) {
  const callbacks: Array<(editor: { add(tool: RecordedTool): void }) => void> =
    [];
  let setupCalls = 0;
  const ctx = {
    location: { directory },
    tool: {
      async transform(cb: (editor: { add(tool: RecordedTool): void }) => void) {
        setupCalls += 1;
        callbacks.push(cb);
        return { dispose: async () => {} };
      },
    },
  } as unknown as V2SetupContext;
  /** Replays every registered transform onto a fresh editor, like the host. */
  function replay(): Map<string, RecordedTool> {
    const tools = new Map<string, RecordedTool>();
    for (const cb of callbacks) cb({ add: (t) => tools.set(t.name, t) });
    return tools;
  }
  return { ctx, replay, transformCount: () => setupCalls };
}

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];
let dirs: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function writeRoster(dir: string, projectPath: string, name = "alpha"): void {
  writeFileSync(
    join(dir, "spacebus.json"),
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [{ name, path: projectPath, description: `${name} project` }],
    }),
  );
}

function mockFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("http://127.0.0.1:4096", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const handler = routes[`${method} ${path}`] ?? routes[path];
    return handler
      ? handler()
      : new Response(JSON.stringify([]), { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  delete process.env["SPACE_BUS_CONFIG"];
});

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV === undefined) delete process.env["SPACE_BUS_CONFIG"];
  else process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
});

describe("v2 setup: registration", () => {
  test("registers the six bus tools with the shared descriptions", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-registration");
    await setupV2(ctx);
    const tools = replay();
    expect([...tools.keys()].sort()).toEqual([
      "bus_registry",
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
      "bus_wait",
    ]);
    const expected: Record<string, string> = {
      bus_roster: BUS_ROSTER_DESCRIPTION,
      bus_task: BUS_TASK_DESCRIPTION,
      bus_status: BUS_STATUS_DESCRIPTION,
      bus_result: BUS_RESULT_DESCRIPTION,
      bus_wait: BUS_WAIT_DESCRIPTION,
      bus_registry: BUS_REGISTRY_DESCRIPTION,
    };
    for (const [name, tool] of tools) {
      expect(tool.description).toBe(expected[name] as string);
      expect(typeof tool.execute).toBe("function");
    }
  });

  test("setup does its work once; the transform callback is repeatable and side-effect free", async () => {
    const { ctx, replay, transformCount } = makeFakeContext(
      "/tmp/space-bus-v2-repeat",
    );
    await setupV2(ctx);
    expect(transformCount()).toBe(1);
    const first = replay();
    const second = replay();
    const third = replay();
    expect([...second.keys()].sort()).toEqual([...first.keys()].sort());
    expect([...third.keys()].sort()).toEqual([...first.keys()].sort());
    for (const [name, tool] of first) {
      expect(second.get(name)?.input).toEqual(tool.input);
      expect(second.get(name)?.description).toBe(tool.description);
    }
    // Replaying never re-ran setup work.
    expect(transformCount()).toBe(1);
  });

  test("input schemas are JSON Schema objects with field descriptions and required/optional preserved", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-schema");
    await setupV2(ctx);
    const tools = replay();

    const task = tools.get("bus_task")?.input as {
      type: string;
      required?: string[];
      properties: Record<string, { type?: string; description?: string }>;
    };
    expect(task.type).toBe("object");
    expect(task.required).toEqual(["prompt"]);
    expect(Object.keys(task.properties).sort()).toEqual([
      "messageId",
      "project",
      "prompt",
      "roster",
      "sessionId",
      "title",
    ]);
    // Descriptions only survive when converted by the schema-owning zod copy.
    expect(task.properties["prompt"]?.description).toBe(
      "The prompt to send to the delegated agent",
    );
    expect(task.properties["roster"]?.description).toContain(
      "Registry roster name to target",
    );

    const wait = tools.get("bus_wait")?.input as {
      required?: string[];
      properties: Record<
        string,
        {
          minItems?: number;
          maxItems?: number;
          exclusiveMinimum?: number;
          description?: string;
        }
      >;
    };
    expect(wait.required).toEqual(["sessionIds"]);
    expect(wait.properties["sessionIds"]?.minItems).toBe(1);
    expect(wait.properties["sessionIds"]?.maxItems).toBe(100);
    expect(wait.properties["timeoutMs"]?.exclusiveMinimum).toBe(0);

    const registry = tools.get("bus_registry")?.input as {
      required?: string[];
      properties: Record<string, unknown>;
    };
    expect(registry.required).toEqual(["action"]);
    expect(Object.keys(registry.properties).sort()).toEqual([
      "action",
      "name",
      "patch",
      "path",
      "project",
      "projectName",
      "roster",
      "server",
    ]);

    for (const name of ["bus_status", "bus_result"]) {
      const input = tools.get(name)?.input as { required?: string[] };
      expect(input.required).toEqual(["sessionId"]);
    }
    const roster = tools.get("bus_roster")?.input as { required?: string[] };
    expect(roster.required ?? []).toEqual([]);
  });
});

describe("v2 execute: delegation to a v1 target", () => {
  test("bus_task dispatches to the v1 target and returns content + structured metadata", async () => {
    const location = tmp("space-bus-v2-location-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(location, project);
    globalThis.fetch = mockFetch({
      "POST /session": () =>
        new Response(JSON.stringify({ id: "ses_v2_1" }), { status: 200 }),
      "POST /session/ses_v2_1/prompt_async": () =>
        new Response(null, { status: 204 }),
    });
    const { ctx, replay } = makeFakeContext(location);
    await setupV2(ctx);
    const result = await replay()
      .get("bus_task")
      ?.execute({ project: "alpha", prompt: "hello" }, {});
    expect(result?.content).toContain("ses_v2_1");
    expect(result?.content.startsWith("roster: ")).toBe(true);
    expect(result?.metadata).toEqual({
      sessionId: "ses_v2_1",
      project: "alpha",
      mode: "new",
    });
  });

  test("string-valued tools return content without metadata", async () => {
    const location = tmp("space-bus-v2-location-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(location, project);
    globalThis.fetch = mockFetch({
      "/session/status": () =>
        new Response(JSON.stringify({}), { status: 200 }),
      "/session?limit=101": () =>
        new Response(JSON.stringify([]), { status: 200 }),
      "/question": () => new Response(JSON.stringify([]), { status: 200 }),
    });
    const { ctx, replay } = makeFakeContext(location);
    await setupV2(ctx);
    const result = await replay().get("bus_roster")?.execute({}, {});
    expect(result?.content).toContain("alpha");
    expect(result?.metadata).toBeUndefined();
  });

  test("resolves the roster from the setup location, not process cwd or a sibling location", async () => {
    const locationA = tmp("space-bus-v2-loc-a-");
    const locationB = tmp("space-bus-v2-loc-b-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(locationA, project, "from-a");
    writeRoster(locationB, project, "from-b");
    globalThis.fetch = mockFetch({
      "/session/status": () =>
        new Response(JSON.stringify({}), { status: 200 }),
      "/session?limit=101": () =>
        new Response(JSON.stringify([]), { status: 200 }),
      "/question": () => new Response(JSON.stringify([]), { status: 200 }),
    });
    const a = makeFakeContext(locationA);
    const b = makeFakeContext(locationB);
    await setupV2(a.ctx);
    await setupV2(b.ctx);
    const outA = await a.replay().get("bus_roster")?.execute({}, {});
    const outB = await b.replay().get("bus_roster")?.execute({}, {});
    expect(outA?.content).toContain("from-a");
    expect(outA?.content).not.toContain("from-b");
    expect(outB?.content).toContain("from-b");
    expect(outB?.content).not.toContain("from-a");
  });

  test("a v1-style per-call directory in the tool context is not consulted", async () => {
    const location = tmp("space-bus-v2-loc-");
    const other = tmp("space-bus-v2-other-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(location, project, "owning");
    writeRoster(other, project, "elsewhere");
    globalThis.fetch = mockFetch({
      "/session/status": () =>
        new Response(JSON.stringify({}), { status: 200 }),
      "/session?limit=101": () =>
        new Response(JSON.stringify([]), { status: 200 }),
      "/question": () => new Response(JSON.stringify([]), { status: 200 }),
    });
    const { ctx, replay } = makeFakeContext(location);
    await setupV2(ctx);
    const out = await replay()
      .get("bus_roster")
      ?.execute({}, { directory: other, sessionID: "ses_caller" });
    expect(out?.content).toContain("owning");
    expect(out?.content).not.toContain("elsewhere");
  });

  test("core ok:false errors throw with the roster header and no credentials", async () => {
    const location = tmp("space-bus-v2-location-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(location, project);
    globalThis.fetch = (async () =>
      new Response("[]", { status: 404 })) as unknown as typeof fetch;
    const { ctx, replay } = makeFakeContext(location);
    await setupV2(ctx);
    const err = await replay()
      .get("bus_status")
      ?.execute({ sessionId: "ses_missing" }, {})
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message.startsWith("roster: ")).toBe(true);
  });

  test("bus_task fail-fast shape error precedes any config resolution", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(
      replay().get("bus_task")?.execute({ prompt: "x" }, {}),
    ).rejects.toThrow(
      "space-bus: project is required when starting a new session",
    );
  });
});

describe("v2 execute: selection and v1/v2 behavioral parity", () => {
  test("an explicit roster name overrides the ambient location roster and is echoed in the header", async () => {
    const ambient = tmp("space-bus-v2-ambient-");
    const explicit = tmp("space-bus-v2-explicit-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(ambient, project, "ambient-project");
    writeRoster(explicit, project, "explicit-project");
    const configHome = tmp("space-bus-v2-xdg-");
    const originalXdg = process.env["XDG_CONFIG_HOME"];
    process.env["XDG_CONFIG_HOME"] = configHome;
    try {
      expect(
        registerRoster("chosen", realpathSync(join(explicit, "spacebus.json"))),
      ).toEqual({ ok: true });
      globalThis.fetch = mockFetch({});
      const { ctx, replay } = makeFakeContext(ambient);
      await setupV2(ctx);
      const out = await replay()
        .get("bus_roster")
        ?.execute({ roster: "chosen" }, {});
      expect(out?.content.startsWith("roster: chosen\n")).toBe(true);
      expect(out?.content).toContain("explicit-project");
      expect(out?.content).not.toContain("ambient-project");
    } finally {
      if (originalXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = originalXdg;
    }
  });

  test("v1 and v2 adapters return the same text, metadata and error messages for the same call", async () => {
    const location = tmp("space-bus-v2-parity-");
    const project = tmp("space-bus-v2-project-");
    writeRoster(location, project);
    globalThis.fetch = mockFetch({
      "POST /session": () =>
        new Response(JSON.stringify({ id: "ses_parity" }), { status: 200 }),
      "POST /session/ses_parity/prompt_async": () =>
        new Response(null, { status: 204 }),
    });
    const v1 = (await plugin.server({ directory: location })).tool;
    const { ctx, replay } = makeFakeContext(location);
    await setupV2(ctx);
    const v2 = replay();
    // biome-ignore lint: minimal stub, only `directory` is consumed
    const v1Ctx = { directory: location } as any;

    const v1Task = (await v1["bus_task"]?.execute(
      { project: "alpha", prompt: "go" },
      v1Ctx,
    )) as { output: string; metadata: Record<string, unknown> };
    const v2Task = await v2
      .get("bus_task")
      ?.execute({ project: "alpha", prompt: "go" }, {});
    expect(v2Task?.content).toBe(v1Task.output);
    expect(v2Task?.metadata).toEqual(v1Task.metadata);

    const message = async (run: () => Promise<unknown> | undefined) =>
      run()?.then(
        () => "no error",
        (e: Error) => e.message,
      );
    for (const [name, input] of [
      ["bus_status", { sessionId: "ses_unknown" }],
      ["bus_result", { sessionId: "ses_unknown" }],
      ["bus_task", { prompt: "x" }],
      ["bus_roster", { roster: "not-registered" }],
    ] as const) {
      const fromV1 = await message(() => v1[name]?.execute(input, v1Ctx));
      const fromV2 = await message(() => v2.get(name)?.execute(input, {}));
      expect(fromV1).not.toBe("no error");
      expect(fromV2).toBe(fromV1);
    }
  });
});

describe("v2 execute: runtime validation the JSON Schema cannot express", () => {
  test("bus_wait rejects an empty sessionIds array before touching config or network", async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      return new Response("[]");
    }) as unknown as typeof fetch;
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(
      replay().get("bus_wait")?.execute({ sessionIds: [] }, {}),
    ).rejects.toThrow(/at least one sessionId/);
    expect(fetched).toBe(false);
  });

  test("bus_wait rejects more than 100 sessionIds", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(
      replay()
        .get("bus_wait")
        ?.execute(
          { sessionIds: Array.from({ length: 101 }, (_, i) => `s${i}`) },
          {},
        ),
    ).rejects.toThrow(/at most 100/);
  });

  test("missing required argument is rejected with an actionable message", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(replay().get("bus_status")?.execute({}, {})).rejects.toThrow(
      /sessionId/,
    );
  });

  test("bus_registry server block must name exactly one of baseUrl / managed", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    const scratch = tmp("space-bus-v2-registry-");
    process.env["XDG_CONFIG_HOME"] = scratch;
    await expect(
      replay()
        .get("bus_registry")
        ?.execute(
          {
            action: "create",
            name: "both",
            path: join(scratch, "both.json"),
            server: { baseUrl: "http://127.0.0.1:4096", managed: {} },
          },
          {},
        ),
    ).rejects.toThrow(/exactly one of `baseUrl` or `managed`/);
  });

  test("bus_registry update-project rejects an empty patch", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(
      replay().get("bus_registry")?.execute(
        {
          action: "update-project",
          roster: "x",
          projectName: "svc",
          patch: {},
        },
        {},
      ),
    ).rejects.toThrow(/at least one field/);
  });

  test("bus_registry use is MCP-only: the v2 surface returns the actionable error", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-no-roster");
    await setupV2(ctx);
    await expect(
      replay().get("bus_registry")?.execute({ action: "use", roster: "x" }, {}),
    ).rejects.toThrow(/connector-session concept/);
  });
});

describe("default export", () => {
  test("setup on the default object registers the same tools", async () => {
    const { ctx, replay } = makeFakeContext("/tmp/space-bus-v2-default");
    await plugin.setup(ctx);
    expect(replay().size).toBe(6);
  });
});

describe("neither entry point resolves the v1 peer", () => {
  // A real subprocess with a resolver that throws on any `@opencode-ai/plugin`
  // specifier: it proves an install with no v1 peer can load the default
  // entry and run BOTH `setup` (v2) and `server` (v1) plus tool executes. The
  // v1 adapter is SDK-free, so `server` must not trip the blocker either; the
  // negative control shows the blocker is live by resolving the peer directly.
  const script = `
    import { plugin as bunPlugin } from "bun";
    bunPlugin({
      name: "block-v1-peer",
      setup(build) {
        // A virtual module that throws on load stands in for "peer absent".
        build.module("@opencode-ai/plugin", () => {
          throw new Error("V1_PEER_RESOLVED");
        });
      },
    });
    const { default: entry } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
    const added = [];
    await entry.setup({
      location: { directory: "/tmp" },
      tool: {
        async transform(cb) { cb({ add: (t) => added.push(t) }); return { dispose: async () => {} }; },
      },
    });
    const task = added.find((t) => t.name === "bus_task");
    let failFast = "";
    try { await task.execute({ prompt: "x" }, {}); } catch (e) { failFast = e.message; }
    let serverError = "";
    let serverNames = [];
    try { serverNames = Object.keys((await entry.server({ directory: "/tmp" })).tool).sort(); } catch (e) { serverError = e.message; }
    let controlError = "";
    try { await import("@opencode-ai/plugin"); } catch (e) { controlError = e.message; }
    console.log(JSON.stringify({ names: added.map((t) => t.name).sort(), failFast, serverError, serverNames, controlError }));
  `;

  test("setup, server and execute all work with the v1 peer unresolvable; the blocker itself is live", () => {
    const proc = Bun.spawnSync(["bun", "-e", script], {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.stderr.toString()).toBe("");
    expect(proc.exitCode).toBe(0);
    const out = JSON.parse(proc.stdout.toString()) as {
      names: string[];
      failFast: string;
      serverError: string;
      serverNames: string[];
      controlError: string;
    };
    expect(out.names).toHaveLength(6);
    expect(out.failFast).toBe(
      "space-bus: project is required when starting a new session",
    );
    // The v1 `server` entry loads and returns the same six tools without
    // ever touching the (blocked) peer ...
    expect(out.serverError).toBe("");
    expect(out.serverNames).toEqual(out.names);
    // ... and the blocker is demonstrably live: resolving the peer directly
    // from the same process fails.
    expect(out.controlError).toContain("V1_PEER_RESOLVED");
  });
});
