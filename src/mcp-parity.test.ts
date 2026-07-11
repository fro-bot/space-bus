import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import SpaceBusPlugin from "./index";
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
};

describe("plugin factory <-> description constant parity", () => {
  test("factory produces exactly the five tools, each matching its description constant", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const tools = hooks.tool ?? {};
    expect(Object.keys(tools).sort()).toEqual([
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

  test("bus_task args: prompt required; project, title, sessionId optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_task?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual([
      "project",
      "prompt",
      "sessionId",
      "title",
    ]);
    // zod schemas: prompt should NOT be optional; the rest should be.
    expect(isOptionalZod(args["prompt"])).toBe(false);
    expect(isOptionalZod(args["project"])).toBe(true);
    expect(isOptionalZod(args["title"])).toBe(true);
    expect(isOptionalZod(args["sessionId"])).toBe(true);
  });

  test("bus_status args: sessionId required, only key", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_status?.args as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["sessionId"]);
    expect(isOptionalZod(args["sessionId"])).toBe(false);
  });

  test("bus_result args: sessionId required, only key", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_result?.args as Record<string, unknown>;
    expect(Object.keys(args)).toEqual(["sessionId"]);
    expect(isOptionalZod(args["sessionId"])).toBe(false);
  });

  test("bus_wait args: sessionIds required, timeoutMs optional", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_wait?.args as Record<string, unknown>;
    expect(Object.keys(args).sort()).toEqual(["sessionIds", "timeoutMs"]);
    expect(isOptionalZod(args["sessionIds"])).toBe(false);
    expect(isOptionalZod(args["timeoutMs"])).toBe(true);
  });

  test("bus_roster args: no args", async () => {
    const hooks = await SpaceBusPlugin(
      // biome-ignore lint: minimal stub, only `directory` is consumed
      { directory: "/tmp" } as any,
    );
    const args = hooks.tool?.bus_roster?.args as Record<string, unknown>;
    expect(Object.keys(args)).toEqual([]);
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
  });

  test("registers exactly five server.registerTool( calls, one per bus tool", () => {
    const matches = mcpSource.match(/server\.registerTool\(\s*\n?\s*"(\w+)"/g);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(5);
    const names = (matches ?? []).map((m) => {
      const nameMatch = m.match(/"(\w+)"/);
      return nameMatch?.[1];
    });
    expect(names.sort()).toEqual([
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
      "bus_wait",
    ]);
  });

  test("ensureServer is gated on SPACE_BUS_MCP_SPAWN — never called unconditionally", () => {
    // Attach-only-by-default posture: mcp.ts must only call ensureServer()
    // inside a conditional that checks SPACE_BUS_MCP_SPAWN.
    expect(mcpSource).toContain("SPACE_BUS_MCP_SPAWN");
    const fnMatch = mcpSource.match(
      /async function mcpLoadContext[\s\S]*?\n\}/,
    );
    expect(fnMatch).not.toBeNull();
    const fnBody = fnMatch?.[0] ?? "";
    const gateMatch = fnBody.match(
      /if\s*\(\s*process\.env\["SPACE_BUS_MCP_SPAWN"\][\s\S]*?\)\s*\{[\s\S]*?ensureServer[\s\S]*?\}/,
    );
    expect(gateMatch).not.toBeNull();
    // ensureServer must not appear anywhere outside mcpLoadContext.
    const outsideFn = mcpSource.replace(fnBody, "");
    expect(outsideFn).not.toContain("ensureServer(");
  });

  test("all four handlers route through the shared mcpLoadContext helper, not loadContext() directly", () => {
    // Every registerTool handler must call mcpLoadContext(), not
    // loadContext() bare — otherwise the SPACE_BUS_MCP_SPAWN gate would be
    // bypassed for that handler.
    const bareLoadContextCalls = mcpSource.match(/[^.\w]loadContext\(\)/g);
    expect(bareLoadContextCalls).not.toBeNull();
    // Only the one call inside mcpLoadContext() itself should invoke the
    // bare loadContext().
    expect(bareLoadContextCalls).toHaveLength(1);
    const mcpLoadContextCalls = mcpSource.match(/mcpLoadContext\(\)/g);
    expect(mcpLoadContextCalls?.length).toBeGreaterThanOrEqual(5);
  });
});
