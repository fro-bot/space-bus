import { tool } from "@opencode-ai/plugin";
import { result } from "../../src/core";
import { formatResult } from "../../src/format";

export default tool({
  description:
    "Return a completed space-bus session's final assistant message and diff. Errors if the session is still running — use bus_status to check first.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args, ctx) {
    const r = await result(args.sessionId, { directory: ctx.directory });
    if (!r.ok) throw new Error(r.error);
    return formatResult(r);
  },
});
