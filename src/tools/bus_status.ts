import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { loadContext } from "../config";
import { status } from "../core";
import { formatStatus } from "../format";

export const BUS_STATUS_DESCRIPTION =
  "Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.";

export function makeBusStatus(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_STATUS_DESCRIPTION,
    args: {
      sessionId: tool.schema
        .string()
        .describe("Session ID returned by bus_task"),
    },
    async execute(args, ctx) {
      const directory = ctx.directory ?? defaultDirectory;
      let context: ReturnType<typeof loadContext>;
      try {
        context = loadContext(directory);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const r = await status(args.sessionId, { context });
      if (!r.ok) throw new Error(r.error);
      return formatStatus(r);
    },
  });
}
