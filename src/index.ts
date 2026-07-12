import type { Plugin } from "@opencode-ai/plugin";
import { makeBusRegistry } from "./tools/bus_registry";
import { makeBusResult } from "./tools/bus_result";
import { makeBusRoster } from "./tools/bus_roster";
import { makeBusStatus } from "./tools/bus_status";
import { makeBusTask } from "./tools/bus_task";
import { makeBusWait } from "./tools/bus_wait";

const SpaceBusPlugin: Plugin = async (input) => ({
  tool: {
    bus_roster: makeBusRoster(input.directory),
    bus_task: makeBusTask(input.directory),
    bus_status: makeBusStatus(input.directory),
    bus_result: makeBusResult(input.directory),
    bus_wait: makeBusWait(input.directory),
    // No session seam: the plugin surface is directory-first (R10), so
    // `use` returns an actionable error rather than silently no-op'ing.
    bus_registry: makeBusRegistry(),
  },
});

export default SpaceBusPlugin;
