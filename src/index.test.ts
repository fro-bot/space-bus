import { describe, expect, test } from "bun:test";
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
});
