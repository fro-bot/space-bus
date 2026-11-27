import { makeBusRegistry } from "./bus_registry";
import { makeBusResult } from "./bus_result";
import { makeBusRoster } from "./bus_roster";
import { makeBusStatus } from "./bus_status";
import { makeBusTask } from "./bus_task";
import { makeBusWait } from "./bus_wait";
import type { BusTool } from "./spec";

/**
 * The six `bus_*` tools for a plugin host, bound to the directory that owns
 * the plugin instance (v1: `input.directory`; v2: `ctx.location.directory`).
 *
 * No session seam for `bus_registry`: the plugin surfaces are
 * directory-first (R10), so its `use` action returns an actionable error
 * rather than silently no-op'ing. `use` stays MCP-only (mcp.ts).
 */
export function makeBusTools(defaultDirectory?: string): BusTool[] {
  return [
    makeBusRoster(defaultDirectory),
    makeBusTask(defaultDirectory),
    makeBusStatus(defaultDirectory),
    makeBusResult(defaultDirectory),
    makeBusWait(defaultDirectory),
    makeBusRegistry(),
  ];
}
