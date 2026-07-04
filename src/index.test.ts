import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import SpaceBusPlugin from "./index";

describe("SpaceBusPlugin", () => {
  test("registers exactly the four bus tools with description/args/execute", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp/space-bus-index-test" } as any,
    );
    const tools = hooks.tool;
    expect(tools).toBeDefined();
    expect(Object.keys(tools ?? {}).sort()).toEqual([
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
    ]);

    for (const [name, def] of Object.entries(tools ?? {})) {
      expect(typeof def.description).toBe("string");
      expect((def.description as string).length).toBeGreaterThan(0);
      expect(def.args).toBeDefined();
      expect(typeof def.execute).toBe("function");
      void name;
    }
  });

  test("bus_task execute throws fail-fast on missing project/sessionId before touching config", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp/space-bus-index-test" } as any,
    );
    const busTask = hooks.tool?.bus_task;
    expect(busTask).toBeDefined();
    // No SPACE_BUS_CONFIG/roster is set up here — if toDispatchArgs didn't
    // fail first, this would instead throw a roster/config resolution error.
    await expect(
      busTask?.execute(
        { prompt: "x" },
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: "/tmp" } as any,
      ),
    ).rejects.toThrow(
      "space-bus: project is required when starting a new session",
    );
  });
});

describe("bus_task structured metadata", () => {
  const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];
  const ORIGINAL_FETCH = globalThis.fetch;
  let dir: string;
  let configDir: string;

  function writeRoster(): void {
    const rosterPath = join(configDir, "spacebus.json");
    writeFileSync(
      rosterPath,
      JSON.stringify({
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [{ name: "alpha", path: dir, description: "Alpha" }],
      }),
    );
    process.env["SPACE_BUS_CONFIG"] = rosterPath;
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

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "space-bus-index-alpha-"));
    configDir = mkdtempSync(join(tmpdir(), "space-bus-index-config-"));
    writeRoster();
  }

  function teardown(): void {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ENV === undefined) {
      delete process.env["SPACE_BUS_CONFIG"];
    } else {
      process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
    }
  }

  test("plugin bus_task success returns {output, metadata} for a new dispatch", async () => {
    setup();
    try {
      globalThis.fetch = mockFetch({
        "POST /session": () =>
          new Response(JSON.stringify({ id: "ses_new_1" }), { status: 200 }),
        "POST /session/ses_new_1/prompt_async": () =>
          new Response(null, { status: 204 }),
      });
      const hooks = await SpaceBusPlugin(
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: dir } as any,
      );
      const busTask = hooks.tool?.bus_task;
      const res = (await busTask?.execute(
        { project: "alpha", prompt: "hello" },
        // biome-ignore lint: minimal stub
        { directory: dir } as any,
      )) as { output: string; metadata: Record<string, unknown> };
      expect(typeof res.output).toBe("string");
      expect(res.output).toContain("ses_new_1");
      expect(res.metadata).toEqual({
        sessionId: "ses_new_1",
        project: "alpha",
        mode: "new",
      });
    } finally {
      teardown();
    }
  });

  test("plugin bus_task steering (follow-up) carries mode follow-up", async () => {
    setup();
    try {
      globalThis.fetch = mockFetch({
        "GET /session/ses_steer": () =>
          new Response(JSON.stringify({ id: "ses_steer", directory: dir }), {
            status: 200,
          }),
        "GET /question": () =>
          new Response(JSON.stringify([]), { status: 200 }),
        "POST /session/ses_steer/prompt_async": () =>
          new Response(null, { status: 204 }),
      });
      const hooks = await SpaceBusPlugin(
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: dir } as any,
      );
      const busTask = hooks.tool?.bus_task;
      const res = (await busTask?.execute(
        { sessionId: "ses_steer", prompt: "more" },
        // biome-ignore lint: minimal stub
        { directory: dir } as any,
      )) as { output: string; metadata: Record<string, unknown> };
      expect(res.metadata).toEqual({
        sessionId: "ses_steer",
        project: "alpha",
        mode: "follow-up",
      });
    } finally {
      teardown();
    }
  });

  test("plugin bus_task steering (question-reply) carries mode question-reply", async () => {
    setup();
    try {
      globalThis.fetch = mockFetch({
        "GET /session/ses_steer": () =>
          new Response(JSON.stringify({ id: "ses_steer", directory: dir }), {
            status: 200,
          }),
        "GET /question": () =>
          new Response(
            JSON.stringify([{ id: "q_1", sessionID: "ses_steer" }]),
            { status: 200 },
          ),
        "POST /question/q_1/reply": () =>
          new Response(JSON.stringify({}), { status: 200 }),
      });
      const hooks = await SpaceBusPlugin(
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: dir } as any,
      );
      const busTask = hooks.tool?.bus_task;
      const res = (await busTask?.execute(
        { sessionId: "ses_steer", prompt: "yes" },
        // biome-ignore lint: minimal stub
        { directory: dir } as any,
      )) as { output: string; metadata: Record<string, unknown> };
      expect(res.metadata).toEqual({
        sessionId: "ses_steer",
        project: "alpha",
        mode: "question-reply",
      });
    } finally {
      teardown();
    }
  });
});
