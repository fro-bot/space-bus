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
