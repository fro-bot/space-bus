import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tool } from "@opencode-ai/plugin";
import plugin from "./index";
import { setupV2, type V2SetupContext } from "./plugin-v2";
import { BUS_REGISTRY_DESCRIPTION } from "./tools/bus_registry";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";
import { BUS_WAIT_DESCRIPTION } from "./tools/bus_wait";

const DESCRIPTIONS: Record<string, string> = {
  bus_roster: BUS_ROSTER_DESCRIPTION,
  bus_task: BUS_TASK_DESCRIPTION,
  bus_status: BUS_STATUS_DESCRIPTION,
  bus_result: BUS_RESULT_DESCRIPTION,
  bus_wait: BUS_WAIT_DESCRIPTION,
  bus_registry: BUS_REGISTRY_DESCRIPTION,
};

const SpaceBusPlugin = plugin.server;

describe("v1 <-> v2 registration parity", () => {
  type V2Tool = { name: string; description: string; input: unknown };

  async function v2Tools(): Promise<Map<string, V2Tool>> {
    const callbacks: Array<(editor: { add(t: V2Tool): void }) => void> = [];
    const ctx = {
      location: { directory: "/tmp" },
      tool: {
        async transform(cb: (editor: { add(t: V2Tool): void }) => void) {
          callbacks.push(cb);
          return { dispose: async () => {} };
        },
      },
    } as unknown as V2SetupContext;
    await setupV2(ctx);
    const tools = new Map<string, V2Tool>();
    for (const cb of callbacks) cb({ add: (t) => tools.set(t.name, t) });
    return tools;
  }

  test("both adapters expose the same names, descriptions and JSON Schema (incl. field descriptions)", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const v1 = hooks.tool ?? {};
    const v2 = await v2Tools();
    expect([...v2.keys()].sort()).toEqual(Object.keys(v1).sort());
    // Convert v1 args the way a v1 host does: with ITS zod (tool.schema, the
    // copy bundled in the host SDK). The adapter's args are built by this
    // package's newer zod, so a precise result relies on the per-field JSON
    // Schema hook the adapter installs (plugin-v1.test.ts covers it in depth);
    // equality with the v2 conversion proves nothing is dropped.
    const z = tool.schema;
    for (const [name, def] of Object.entries(v1)) {
      const expected = z.toJSONSchema(z.object(def.args), { io: "input" });
      expect(v2.get(name)?.description).toBe(def.description);
      expect(v2.get(name)?.input).toEqual(expected);
    }
  });
});

describe("plugin factory <-> description constant parity", () => {
  test("factory produces exactly the six tools, each matching its description constant", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const tools = hooks.tool ?? {};
    expect(Object.keys(tools).sort()).toEqual([
      "bus_registry",
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
      "bus_wait",
    ]);
    for (const [name, def] of Object.entries(tools)) {
      const expected = DESCRIPTIONS[name];
      expect(expected).toBeDefined();
      expect(def.description).toBe(expected as string);
    }
  });

  test("bus_task args: prompt required; project, title, sessionId, messageId, roster optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_task?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "messageId",
      "project",
      "prompt",
      "roster",
      "sessionId",
      "title",
    ]);
    // zod schemas: prompt should NOT be optional; the rest should be.
    expect(isOptionalZod(args["prompt"])).toBe(false);
    expect(isOptionalZod(args["project"])).toBe(true);
    expect(isOptionalZod(args["title"])).toBe(true);
    expect(isOptionalZod(args["sessionId"])).toBe(true);
    expect(isOptionalZod(args["messageId"])).toBe(true);
    expect(isOptionalZod(args["roster"])).toBe(true);
  });

  test("bus_status args: sessionId required, roster optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_status?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["roster", "sessionId"]);
    expect(isOptionalZod(args["sessionId"])).toBe(false);
    expect(isOptionalZod(args["roster"])).toBe(true);
  });

  test("bus_result args: sessionId required, roster optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_result?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["roster", "sessionId"]);
    expect(isOptionalZod(args["sessionId"])).toBe(false);
    expect(isOptionalZod(args["roster"])).toBe(true);
  });

  test("bus_wait args: sessionIds required, timeoutMs and roster optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_wait?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "roster",
      "sessionIds",
      "timeoutMs",
    ]);
    expect(isOptionalZod(args["sessionIds"])).toBe(false);
    expect(isOptionalZod(args["timeoutMs"])).toBe(true);
    expect(isOptionalZod(args["roster"])).toBe(true);
  });

  test("bus_roster args: roster optional, only key", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_roster?.args as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["roster"]);
    expect(isOptionalZod(args["roster"])).toBe(true);
  });

  test("bus_registry args: action required, everything else optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_registry?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "action",
      "name",
      "patch",
      "path",
      "project",
      "projectName",
      "roster",
      "server",
    ]);
    expect(isOptionalZod(args["action"])).toBe(false);
    expect(isOptionalZod(args["roster"])).toBe(true);
    expect(isOptionalZod(args["name"])).toBe(true);
    expect(isOptionalZod(args["path"])).toBe(true);
  });
});

describe("roster param + MCP inputSchema parity (Unit 4)", () => {
  test("mcp.ts declares one ROSTER_PARAM_SCHEMA, applied to every factory-built inputSchema", () => {
    const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");
    expect(mcpSource).toContain("ROSTER_PARAM_SCHEMA");
    // One registration loop over makeBusContextTools, not five hand-written
    // inputSchemas (src/mcp-handlers.test.ts asserts the resulting schemas).
    const usages = mcpSource.match(/roster: ROSTER_PARAM_SCHEMA/g);
    expect(usages).toHaveLength(1);
  });
});

// zod v3/v4 schemas expose isOptional() on ZodType; tool.schema wraps zod so
// the underlying object should still satisfy this shape.
function isOptionalZod(schema: unknown): boolean {
  const s = schema as { isOptional?: () => boolean; safeParse?: unknown };
  if (typeof s?.isOptional === "function") return s.isOptional();
  // Fallback: try parsing undefined — optional schemas accept it.
  const parseable = schema as {
    safeParse: (v: unknown) => { success: boolean };
  };
  return parseable.safeParse(undefined).success;
}

describe("bus_task metadata parity", () => {
  test("dispatchMetadata is derived once, in the shared bus_task factory; mcp.ts forwards it as structuredContent", () => {
    const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");
    const busTaskSource = readFileSync(
      join(__dirname, "tools", "bus_task.ts"),
      "utf8",
    );
    expect(busTaskSource).toContain("dispatchMetadata(r)");
    expect(mcpSource).not.toContain("dispatchMetadata");
    expect(mcpSource).toContain("structuredContent");
  });
});

describe("mcp.ts source-text parity guard", () => {
  const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");

  test("five roster-bearing tools come from the shared factories; mcp.ts does not reimplement core calls or output formatting", () => {
    expect(mcpSource).toContain("makeBusContextTools(");
    // Execution + output assembly live in tools/bus_*.ts. If mcp.ts imports
    // core or the formatters again, the two surfaces can drift.
    expect(mcpSource).not.toMatch(/from "\.\/core"/);
    expect(mcpSource).not.toMatch(/from "\.\/format"/);
    for (const description of [
      "BUS_ROSTER_DESCRIPTION",
      "BUS_TASK_DESCRIPTION",
      "BUS_STATUS_DESCRIPTION",
      "BUS_RESULT_DESCRIPTION",
      "BUS_WAIT_DESCRIPTION",
    ]) {
      expect(mcpSource).not.toContain(description);
    }
  });

  test("bus_registry stays MCP-registered with its own schema and the shared description", () => {
    expect(mcpSource).toContain("BUS_REGISTRY_DESCRIPTION");
    expect(mcpSource).toContain("inputSchema: ACTION_SCHEMA");
    expect(mcpSource).toContain("runBusRegistryAction(");
  });

  test("ensureServer is gated on SPACE_BUS_MCP_SPAWN — never called unconditionally", () => {
    // Attach-only-by-default posture: mcp.ts must only call ensureServer()
    // inside a conditional that checks SPACE_BUS_MCP_SPAWN. ensureServer is
    // called from two helpers: resolveByName (the explicit-name / registry-
    // default paths) and mcpLoadContext (the ambient SPACE_BUS_CONFIG
    // path) — both must gate the call, and nothing outside either helper
    // may call ensureServer.
    expect(mcpSource).toContain("SPACE_BUS_MCP_SPAWN");
    const resolveByNameMatch = mcpSource.match(
      /async function resolveByName[\s\S]*?\n\}/,
    );
    const mcpLoadContextMatch = mcpSource.match(
      /async function mcpLoadContext[\s\S]*?throw ambientError;\n\}/,
    );
    expect(resolveByNameMatch).not.toBeNull();
    expect(mcpLoadContextMatch).not.toBeNull();
    const resolveByNameBody = resolveByNameMatch?.[0] ?? "";
    const mcpLoadContextBody = mcpLoadContextMatch?.[0] ?? "";
    // Both helpers call the injected `ensure` (default: ensureServer, see
    // mcpLoadContext's parameter default), gated behind SPACE_BUS_MCP_SPAWN.
    const gatePattern =
      /if\s*\(\s*process\.env\["SPACE_BUS_MCP_SPAWN"\][\s\S]*?\)\s*\{[\s\S]*?await ensure\([\s\S]*?\}/;
    expect(resolveByNameBody).toMatch(gatePattern);
    expect(mcpLoadContextBody).toMatch(gatePattern);
    // The literal ensureServer identifier must not appear anywhere outside
    // mcpLoadContext's own parameter default (its one legitimate reference).
    const outside = mcpSource.replace(
      "ensure: (rosterPath: string) => Promise<unknown> = ensureServer,",
      "",
    );
    expect(outside).not.toContain("ensureServer(");
  });

  test("the factories' context resolver is mcpLoadContext, never a bare loadContext()", () => {
    // Every roster-bearing tool must resolve through mcpLoadContext, or the
    // SPACE_BUS_MCP_SPAWN gate would be bypassed for that tool.
    const bareLoadContextCalls = mcpSource.match(/[^.\w]loadContext\(\)/g);
    expect(bareLoadContextCalls).not.toBeNull();
    // Only the one call inside mcpLoadContext() itself.
    expect(bareLoadContextCalls).toHaveLength(1);
    expect(mcpSource).toMatch(/mcpLoadContext\(rosterName\)/);
  });
});
