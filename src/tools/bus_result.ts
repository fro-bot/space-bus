import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { result } from "../core";
import { formatResult, formatRosterHeader } from "../format";
import { ensureAndLoadContext } from "./shared";

export const BUS_RESULT_DESCRIPTION =
  "Return a completed space-bus session's final assistant message and diff. Errors if the session is still running — use bus_status to check first.";

export function makeBusResult(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_RESULT_DESCRIPTION,
    args: {
      sessionId: tool.schema
        .string()
        .describe("Session ID returned by bus_task"),
      roster: tool.schema
        .string()
        .optional()
        .describe(
          "Registry roster name to target instead of the ambient/default roster (see bus_registry to list)",
        ),
    },
    async execute(args, ctx) {
      const directory = ctx.directory ?? defaultDirectory;
      let resolved: Awaited<ReturnType<typeof ensureAndLoadContext>>;
      try {
        resolved = await ensureAndLoadContext(directory, args.roster);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const r = await result(args.sessionId, { context: resolved.context });
      if (!r.ok) throw new Error(r.error);
      const header = formatRosterHeader({
        name: resolved.rosterName,
        path: resolved.rosterPath,
      });
      return `${header}\n${formatResult(r)}`;
    },
  });
}
