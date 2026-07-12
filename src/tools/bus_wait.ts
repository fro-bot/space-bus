import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { wait } from "../core";
import { formatRosterHeader, formatWait } from "../format";
import { ensureAndLoadContext } from "./shared";

export const BUS_WAIT_DESCRIPTION =
  "Block until any of the given space-bus sessions needs attention (completes, blocks on a question, fails, or is not found) or a timeout elapses. Returns every watched session's normalized state and which session(s) woke the wait. A bounded, level-triggered long-poll — an already-done session wakes immediately; on timeout it returns the current snapshot, not an error.";

// Hard ceiling on requested timeoutMs so a caller can't ask bus_wait to
// block indefinitely (or long enough to exceed an MCP-facade call ceiling,
// e.g. Claude Desktop). Requests above this are clamped, not rejected — a
// clamp is easier to attach a UI/log for than a hard error, and a timeout
// still returns a normal (not error) snapshot either way.
export const MAX_WAIT_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export function makeBusWait(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_WAIT_DESCRIPTION,
    args: {
      sessionIds: tool.schema
        .array(tool.schema.string())
        .min(1, "bus_wait requires at least one sessionId")
        .max(100, "bus_wait accepts at most 100 sessionIds")
        .describe("Session IDs to watch (returned by bus_task)"),
      timeoutMs: tool.schema
        .number()
        .positive()
        .optional()
        .describe(
          `Max time to wait in milliseconds before returning a timeout snapshot (default 60s, capped at ${MAX_WAIT_TIMEOUT_MS}ms; soft deadline, may overshoot by up to ~30s if a request is slow)`,
        ),
      roster: tool.schema
        .string()
        .optional()
        .describe(
          "Registry roster name to target instead of the ambient/default roster (see bus_registry to list)",
        ),
    },
    async execute(args, ctx) {
      // Explicit runtime guard: schema .min(1) may not be enforced ahead of
      // execute() by every tool-calling surface, and wait([]) would
      // otherwise just block for the full timeout doing nothing useful.
      if (!args.sessionIds || args.sessionIds.length === 0) {
        throw new Error("bus_wait requires at least one sessionId");
      }
      const directory = ctx.directory ?? defaultDirectory;
      let resolved: Awaited<ReturnType<typeof ensureAndLoadContext>>;
      try {
        resolved = await ensureAndLoadContext(directory, args.roster);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const timeoutMs =
        args.timeoutMs !== undefined
          ? Math.min(args.timeoutMs, MAX_WAIT_TIMEOUT_MS)
          : undefined;
      const r = await wait(args.sessionIds, {
        context: resolved.context,
        timeoutMs,
      });
      if (!r.ok) throw new Error(r.error);
      const header = formatRosterHeader({
        name: resolved.rosterName,
        path: resolved.rosterPath,
      });
      return `${header}\n${formatWait(r)}`;
    },
  });
}
