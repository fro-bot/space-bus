import { tool } from "@opencode-ai/plugin";
import { status } from "../../src/core";
import { formatStatus } from "../../src/format";

export default tool({
  description: "Report a space-bus session's status plus a summary of its latest todo and diff.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args) {
    const r = await status(args.sessionId);
    if (!r.ok) return r.error;
    return formatStatus(r);
  },
});
