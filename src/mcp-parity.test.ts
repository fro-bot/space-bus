import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import SpaceBusPlugin from "./index";
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
  test("mcp.ts declares a ROSTER_PARAM_SCHEMA reused across all five inputSchemas", () => {
    const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");
    expect(mcpSource).toContain("ROSTER_PARAM_SCHEMA");
    const usages = mcpSource.match(/roster: ROSTER_PARAM_SCHEMA/g);
    expect(usages).toHaveLength(5);
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
  test("both surfaces derive dispatch metadata via the shared dispatchMetadata helper", () => {
    const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");
    const busTaskSource = readFileSync(
      join(__dirname, "tools", "bus_task.ts"),
      "utf8",
    );
    expect(mcpSource).toContain("dispatchMetadata(r)");
    expect(busTaskSource).toContain("dispatchMetadata(r)");
  });
});

describe("mcp.ts source-text parity guard", () => {
  const mcpSource = readFileSync(join(__dirname, "mcp.ts"), "utf8");

  test("references each BUS_*_DESCRIPTION identifier", () => {
    expect(mcpSource).toContain("BUS_ROSTER_DESCRIPTION");
    expect(mcpSource).toContain("BUS_TASK_DESCRIPTION");
    expect(mcpSource).toContain("BUS_STATUS_DESCRIPTION");
    expect(mcpSource).toContain("BUS_RESULT_DESCRIPTION");
    expect(mcpSource).toContain("BUS_WAIT_DESCRIPTION");
    expect(mcpSource).toContain("BUS_REGISTRY_DESCRIPTION");
  });

  test("registers exactly six server.registerTool( calls, one per bus tool", () => {
    const matches = mcpSource.match(/server\.registerTool\(\s*\n?\s*"(\w+)"/g);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(6);
    const names = (matches ?? []).map((m) => {
      const nameMatch = m.match(/"(\w+)"/);
      return nameMatch?.[1];
    });
    expect(names.sort()).toEqual([
      "bus_registry",
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
      "bus_wait",
    ]);
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

  test("all five roster-bearing handlers route through the shared mcpLoadContext helper, not loadContext() directly", () => {
    // Every registerTool handler that resolves a roster (bus_roster,
    // bus_task, bus_status, bus_result, bus_wait — bus_registry manages
    // the registry itself and has no roster context to resolve) must call
    // mcpLoadContext(), not loadContext() bare — otherwise the
    // SPACE_BUS_MCP_SPAWN gate would be bypassed for that handler.
    const bareLoadContextCalls = mcpSource.match(/[^.\w]loadContext\(\)/g);
    expect(bareLoadContextCalls).not.toBeNull();
    // Only the one call inside mcpLoadContext() itself should invoke the
    // bare loadContext().
    expect(bareLoadContextCalls).toHaveLength(1);
    const mcpLoadContextCalls = mcpSource.match(/mcpLoadContext\(/g);
    expect(mcpLoadContextCalls?.length).toBeGreaterThanOrEqual(5);
  });
});
