import { tool } from "@opencode-ai/plugin";
import { status } from "../../src/core";
import { formatStatus } from "../../src/format";

export default tool({
  description:
    "Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args, ctx) {
    const r = await status(args.sessionId, { directory: ctx.directory });
    if (!r.ok) throw new Error(r.error);
    return formatStatus(r);
  },
});
