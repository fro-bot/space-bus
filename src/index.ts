import type { Plugin } from "@opencode-ai/plugin";
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
  },
});

export default SpaceBusPlugin;
