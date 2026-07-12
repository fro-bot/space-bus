import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { status } from "../core";
import { formatRosterHeader, formatStatus } from "../format";
import { ensureAndLoadContext, withRosterHeader } from "./shared";

export const BUS_STATUS_DESCRIPTION =
  "Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.";

export function makeBusStatus(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_STATUS_DESCRIPTION,
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
      const r = await status(args.sessionId, { context: resolved.context });
      if (!r.ok) throw new Error(withRosterHeader(source, r.error));
      const header = formatRosterHeader(source);
      return `${header}\n${formatStatus(r)}`;
    },
  });
}
