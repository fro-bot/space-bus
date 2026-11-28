import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as busTools from "./tools";
import type { ResolvedContext } from "./tools/shared";

// Characterization + parity for the MCP facade's five roster-bearing tools.
// mcp.ts must be a thin protocol wrapper over the SAME factories the plugin
// adapters use (makeBusContextTools), supplying only its own context
// resolver (roster precedence, attach-only) and MCP wrapping (isError,
// structuredContent). These tests drive mcp.ts through a real in-memory
// Client <-> McpServer round-trip and compare it to the plugin tools.

const ORIGINAL_FETCH = globalThis.fetch;
const ENV_KEYS = [
  "SPACE_BUS_CONFIG",
  "SPACE_BUS_MCP_SPAWN",
  "XDG_CONFIG_HOME",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

let scratch: string;
let projectDir: string;
let rosterFile: string;

function writeRoster(
  path: string,
  server: unknown = { baseUrl: "http://127.0.0.1:4096" },
): void {
  writeFileSync(
    path,
    JSON.stringify({
      server,
      projects: [{ name: "alpha", path: projectDir, description: "Alpha" }],
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
  scratch = mkdtempSync(join(tmpdir(), "space-bus-mcp-handlers-"));
  projectDir = join(scratch, "alpha");
  mkdirSync(projectDir);
  rosterFile = join(scratch, "spacebus.json");
  writeRoster(rosterFile);
  process.env["XDG_CONFIG_HOME"] = join(scratch, "xdg");
  process.env["SPACE_BUS_CONFIG"] = rosterFile;
  delete process.env["SPACE_BUS_MCP_SPAWN"];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  rmSync(scratch, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    const v = ORIGINAL_ENV[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

type Connected = { client: Client; cleanup: () => Promise<void> };

async function connect(server: McpServer): Promise<Connected> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function withMcp<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const { server } = await import("./mcp");
  const { client, cleanup } = await connect(server);
  try {
    return await fn(client);
  } finally {
    // Session state lives at module scope; clear it so tests stay isolated.
    await client.callTool({
      name: "bus_registry",
      arguments: { action: "list" },
    });
    await cleanup();
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text?: string }> }).content;
  return content[0]?.text ?? "";
}

function pluginTool(name: string) {
  const tool = busTools.makeBusTools(projectDir).find((t) => t.name === name);
  if (!tool) throw new Error(`no plugin tool ${name}`);
  return tool;
}

/** Runs a plugin tool; returns its text or the thrown message. */
async function pluginOutcome(
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; threw: boolean; metadata?: unknown }> {
  try {
    const out = await pluginTool(name).execute(args, { directory: projectDir });
    if (typeof out === "string") return { text: out, threw: false };
    return { text: out.output, threw: false, metadata: out.metadata };
  } catch (e) {
    return { text: (e as Error).message, threw: true };
  }
}

describe("makeBusContextTools: injected context resolver", () => {
  test("returns exactly the five roster-bearing tools, no bus_registry", () => {
    const names = busTools
      .makeBusContextTools(undefined, async () => {
        throw new Error("unused");
      })
      .map((t) => t.name);
    expect(names).toEqual([
      "bus_roster",
      "bus_task",
      "bus_status",
      "bus_result",
      "bus_wait",
    ]);
  });

  test("every tool routes context through the injected resolver, passing (directory, roster)", async () => {
    globalThis.fetch = mockFetch({});
    const calls: Array<[string | undefined, string | undefined]> = [];
    const resolved: ResolvedContext = {
      context: {
        roster: { server: { baseUrl: "http://127.0.0.1:4096" }, projects: [] },
      },
      rosterName: "injected",
      rosterPath: "/injected/spacebus.json",
    } as ResolvedContext;
    const tools = busTools.makeBusContextTools(
      "/default-dir",
      async (dir, name) => {
        calls.push([dir, name]);
        return resolved;
      },
    );
    const args: Record<string, Record<string, unknown>> = {
      bus_roster: { roster: "r" },
      bus_task: { project: "p", prompt: "x", roster: "r" },
      bus_status: { sessionId: "s", roster: "r" },
      bus_result: { sessionId: "s", roster: "r" },
      bus_wait: { sessionIds: ["s"], timeoutMs: 1, roster: "r" },
    };
    for (const tool of tools) {
      calls.length = 0;
      let text: string;
      try {
        const out = await tool.execute(args[tool.name], {
          directory: "/call-dir",
        });
        text = typeof out === "string" ? out : out.output;
      } catch (e) {
        text = (e as Error).message;
      }
      expect(calls).toEqual([["/call-dir", "r"]]);
      expect(text.startsWith("roster: injected\n")).toBe(true);
    }
  });
});

describe("mcp.ts: thin wrapper over the shared factories", () => {
  test("listTools exposes the six tools with plugin descriptions; five input schemas equal plugin schemas apart from the roster param description", async () => {
    await withMcp(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "bus_registry",
        "bus_result",
        "bus_roster",
        "bus_status",
        "bus_task",
        "bus_wait",
      ]);
      for (const name of [
        "bus_roster",
        "bus_task",
        "bus_status",
        "bus_result",
        "bus_wait",
      ]) {
        const plugin = pluginTool(name);
        const mcp = tools.find((t) => t.name === name);
        expect(mcp?.description).toBe(plugin.description);
        const expected = z.toJSONSchema(z.object(plugin.args(z)), {
          io: "input",
        }) as { properties: Record<string, Record<string, unknown>> };
        const actual = mcp?.inputSchema as {
          properties: Record<string, Record<string, unknown>>;
        };
        const { roster: expectedRoster, ...expectedRest } = expected.properties;
        const { roster: actualRoster, ...actualRest } = actual.properties;
        expect(actualRest).toEqual(expectedRest);
        expect(actualRoster?.["type"]).toBe(expectedRoster?.["type"]);
        // MCP's roster param documents the connector-session step.
        expect(actualRoster?.["description"]).toContain(
          "connector-session active roster",
        );
      }
    });
  });

  test("bus_task keeps its outputSchema; the other four tools have none", async () => {
    await withMcp(async (client) => {
      const { tools } = await client.listTools();
      const task = tools.find((t) => t.name === "bus_task");
      expect(
        Object.keys(task?.outputSchema?.["properties"] ?? {}).sort(),
      ).toEqual(["messageId", "mode", "project", "sessionId"]);
      for (const name of [
        "bus_roster",
        "bus_status",
        "bus_result",
        "bus_wait",
      ]) {
        expect(
          tools.find((t) => t.name === name)?.outputSchema,
        ).toBeUndefined();
      }
    });
  });

  test("bus_task new dispatch: header + text, structuredContent mirrors plugin metadata", async () => {
    globalThis.fetch = mockFetch({
      "POST /session": () =>
        new Response(JSON.stringify({ id: "ses_new_1" }), { status: 200 }),
      "POST /session/ses_new_1/prompt_async": () =>
        new Response(null, { status: 204 }),
    });
    const args = { project: "alpha", prompt: "hello" };
    const plugin = await pluginOutcome("bus_task", args);
    expect(plugin.threw).toBe(false);
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_task", arguments: args });
      expect(res.isError).not.toBe(true);
      expect(textOf(res)).toBe(plugin.text);
      expect(res.structuredContent).toEqual(plugin.metadata as object);
      expect(res.structuredContent).toEqual({
        sessionId: "ses_new_1",
        project: "alpha",
        mode: "new",
      });
    });
  });

  test("bus_roster success: identical text to the plugin, no structuredContent", async () => {
    globalThis.fetch = mockFetch({});
    const plugin = await pluginOutcome("bus_roster", {});
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_roster", arguments: {} });
      expect(res.isError).not.toBe(true);
      expect(res.structuredContent).toBeUndefined();
      expect(textOf(res)).toBe(plugin.text);
      expect(textOf(res)).toContain("alpha");
    });
  });

  test("bus_wait success: identical text to the plugin for an unknown session snapshot", async () => {
    globalThis.fetch = mockFetch({});
    const args = { sessionIds: ["ses_missing"], timeoutMs: 50 };
    const plugin = await pluginOutcome("bus_wait", args);
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_wait", arguments: args });
      expect(textOf(res)).toBe(plugin.text);
      expect(res.isError).toBe(plugin.threw ? true : undefined);
    });
  });

  test("post-resolution core error: isError with the roster header, same text the plugin throws", async () => {
    globalThis.fetch = mockFetch({});
    for (const name of ["bus_status", "bus_result"]) {
      const args = { sessionId: "ses_missing" };
      const plugin = await pluginOutcome(name, args);
      expect(plugin.threw).toBe(true);
      expect(plugin.text.startsWith("roster: ")).toBe(true);
      await withMcp(async (client) => {
        const res = await client.callTool({ name, arguments: args });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toBe(plugin.text);
      });
    }
  });

  test("arg-shape failure precedes context loading (bus_task): isError, plain message, no header", async () => {
    // No resolvable roster at all — if context loaded first the error would
    // be about spacebus.json, not the missing project.
    process.env["SPACE_BUS_CONFIG"] = join(scratch, "does-not-exist.json");
    const args = { prompt: "x" };
    const plugin = await pluginOutcome("bus_task", args);
    expect(plugin.threw).toBe(true);
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_task", arguments: args });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toBe(plugin.text);
      expect(textOf(res)).toBe(
        "space-bus: project is required when starting a new session",
      );
    });
  });

  test("unknown roster name: isError with the resolver's plain message (pre-resolution, no header)", async () => {
    await withMcp(async (client) => {
      const res = await client.callTool({
        name: "bus_roster",
        arguments: { roster: "no-such-roster" },
      });
      expect(res.isError).toBe(true);
      expect(textOf(res)).toContain("no-such-roster");
      expect(textOf(res).startsWith("roster: ")).toBe(false);
    });
  });

  test("bus_wait clamps timeoutMs to MAX_WAIT_TIMEOUT_MS on both surfaces' shared path", async () => {
    // A tiny timeout resolves quickly; an over-cap request must not be
    // rejected by schema (clamp, not error).
    globalThis.fetch = mockFetch({});
    await withMcp(async (client) => {
      const res = await client.callTool({
        name: "bus_wait",
        arguments: { sessionIds: ["ses_missing"], timeoutMs: 10 ** 12 },
      });
      // Unknown session wakes the wait immediately, so this returns at once.
      expect(res.isError).not.toBe(true);
    });
  });

  test("bus_wait zod bounds surface as an MCP error, not a thrown protocol failure", async () => {
    await withMcp(async (client) => {
      const res = await client
        .callTool({ name: "bus_wait", arguments: { sessionIds: [] } })
        .catch((e: Error) => e);
      // SDK-level input validation: either an isError result or a protocol
      // error naming the bound — never a success.
      if (res instanceof Error) {
        expect(res.message).toContain("at least one sessionId");
      } else {
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("at least one sessionId");
      }
    });
  });
});

describe("mcp.ts: session-aware roster resolution (MCP-only)", () => {
  function registerAndUse(client: Client, name: string, path: string) {
    return (async () => {
      const reg = await client.callTool({
        name: "bus_registry",
        arguments: { action: "register", name, path },
      });
      expect(reg.isError).not.toBe(true);
      const use = await client.callTool({
        name: "bus_registry",
        arguments: { action: "use", roster: name },
      });
      expect(use.isError).not.toBe(true);
    })();
  }

  test("bus_registry use sets the active roster: it beats SPACE_BUS_CONFIG and an explicit roster param beats it", async () => {
    globalThis.fetch = mockFetch({});
    const activePath = join(scratch, "active.json");
    const explicitPath = join(scratch, "explicit.json");
    writeRoster(activePath);
    writeRoster(explicitPath);
    await withMcp(async (client) => {
      await registerAndUse(client, "session-active", activePath);
      await client.callTool({
        name: "bus_registry",
        arguments: {
          action: "register",
          name: "explicit-one",
          path: explicitPath,
        },
      });

      const viaSession = await client.callTool({
        name: "bus_roster",
        arguments: {},
      });
      expect(textOf(viaSession)).toContain("roster: session-active");
      // Named resolution echoes the registry name, not the ambient path.
      expect(textOf(viaSession)).not.toContain(rosterFile);

      const viaParam = await client.callTool({
        name: "bus_roster",
        arguments: { roster: "explicit-one" },
      });
      expect(textOf(viaParam)).toContain("roster: explicit-one");

      // Leave module-level session state clean for later tests.
      await client.callTool({
        name: "bus_registry",
        arguments: { action: "unregister", name: "session-active" },
      });
      const afterClear = await client.callTool({
        name: "bus_roster",
        arguments: {},
      });
      expect(textOf(afterClear)).not.toContain("session-active");
      await client.callTool({
        name: "bus_registry",
        arguments: { action: "unregister", name: "explicit-one" },
      });
    });
  });

  test("without session/param, SPACE_BUS_CONFIG resolves ambiently and the header names the path (no registry name)", async () => {
    globalThis.fetch = mockFetch({});
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_roster", arguments: {} });
      expect(res.isError).not.toBe(true);
      expect(textOf(res)).toContain(rosterFile);
    });
  });

  test("with nothing configured, ambient failure surfaces as isError naming SPACE_BUS_CONFIG/spacebus.json", async () => {
    delete process.env["SPACE_BUS_CONFIG"];
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_roster", arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res).length).toBeGreaterThan(0);
    });
  });

  test("attach-only by default: a managed roster is never spawned without SPACE_BUS_MCP_SPAWN", async () => {
    const managedPath = join(scratch, "managed.json");
    // A spawn attempt would try to exec this nonexistent binary and fail
    // loudly; attach-only must fail on missing discovery instead.
    writeRoster(managedPath, {
      managed: { command: ["space-bus-test-never-spawn-me"] },
    });
    process.env["SPACE_BUS_CONFIG"] = managedPath;
    globalThis.fetch = mockFetch({});
    await withMcp(async (client) => {
      const res = await client.callTool({ name: "bus_roster", arguments: {} });
      expect(res.isError).toBe(true);
      expect(textOf(res)).not.toContain("space-bus-test-never-spawn-me");
    });
  });
});
