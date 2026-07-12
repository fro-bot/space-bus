import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { result } from "../core";
import { formatResult, formatRosterHeader } from "../format";
import { ensureAndLoadContext, withRosterHeader } from "./shared";

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
          "Registry roster name to target. Resolution precedence: this param > workspace directory (see bus_registry to list)",
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
      const source = { name: resolved.rosterName, path: resolved.rosterPath };
      const r = await result(args.sessionId, { context: resolved.context });
      if (!r.ok) throw new Error(withRosterHeader(source, r.error));
      const header = formatRosterHeader(source);
      return `${header}\n${formatResult(r)}`;
    },
  });
}
