import { makeBusRegistry } from "./bus_registry";
import { makeBusResult } from "./bus_result";
import { makeBusRoster } from "./bus_roster";
import { makeBusStatus } from "./bus_status";
import { makeBusTask } from "./bus_task";
import { makeBusWait } from "./bus_wait";
import type { ContextResolver } from "./shared";
import type { BusTool } from "./spec";

/**
 * The five roster-bearing `bus_*` tools. Both surfaces build them here: the
 * plugin adapters with the default directory-first resolver, the MCP facade
 * with its own `resolveContext` (session roster, attach-only). Everything
 * after context resolution — arg validation, error text, header echo, output
 * assembly — is the factories' single implementation.
 */
export function makeBusContextTools(
  defaultDirectory?: string,
  resolveContext?: ContextResolver,
): BusTool[] {
  return [
    makeBusRoster(defaultDirectory, resolveContext),
    makeBusTask(defaultDirectory, resolveContext),
    makeBusStatus(defaultDirectory, resolveContext),
    makeBusResult(defaultDirectory, resolveContext),
    makeBusWait(defaultDirectory, resolveContext),
  ];
}

/**
 * The six `bus_*` tools for a plugin host, bound to the directory that owns
 * the plugin instance (v1: `input.directory`; v2: `ctx.location.directory`).
 *
 * No session seam for `bus_registry`: the plugin surfaces are
 * directory-first (R10), so its `use` action returns an actionable error
 * rather than silently no-op'ing. `use` stays MCP-only (mcp.ts).
 */
export function makeBusTools(defaultDirectory?: string): BusTool[] {
  return [...makeBusContextTools(defaultDirectory), makeBusRegistry()];
}
