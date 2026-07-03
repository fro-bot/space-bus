import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { status } from "../core";
import { formatStatus } from "../format";

export const BUS_STATUS_DESCRIPTION =
  "Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.";

export function makeBusStatus(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_STATUS_DESCRIPTION,
    args: {
      sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
    },
    async execute(args, ctx) {
      const r = await status(args.sessionId, { directory: ctx.directory ?? defaultDirectory });
      if (!r.ok) throw new Error(r.error);
      return formatStatus(r);
    },
  });
}
