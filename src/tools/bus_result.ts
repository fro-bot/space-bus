import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { result } from "../core";
import { formatResult } from "../format";

export const BUS_RESULT_DESCRIPTION =
  "Return a completed space-bus session's final assistant message and diff. Errors if the session is still running — use bus_status to check first.";

export function makeBusResult(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_RESULT_DESCRIPTION,
    args: {
      sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
    },
    async execute(args, ctx) {
      const r = await result(args.sessionId, { directory: ctx.directory ?? defaultDirectory });
      if (!r.ok) throw new Error(r.error);
      return formatResult(r);
    },
  });
}
