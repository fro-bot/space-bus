import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import SpaceBusPlugin from "./index";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";

const DESCRIPTIONS: Record<string, string> = {
  bus_roster: BUS_ROSTER_DESCRIPTION,
  bus_task: BUS_TASK_DESCRIPTION,
  bus_status: BUS_STATUS_DESCRIPTION,
  bus_result: BUS_RESULT_DESCRIPTION,
};

describe("plugin factory <-> description constant parity", () => {
  test("factory produces exactly the four tools, each matching its description constant", async () => {
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
  });

  test("registers exactly four server.registerTool( calls, one per bus tool", () => {
    const matches = mcpSource.match(/server\.registerTool\(\s*\n?\s*"(\w+)"/g);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(4);
    const names = (matches ?? []).map((m) => {
      const nameMatch = m.match(/"(\w+)"/);
      return nameMatch?.[1];
    });
    expect(names.sort()).toEqual([
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
    ]);
  });
});
