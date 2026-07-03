import { tool } from "@opencode-ai/plugin";
import { result } from "../../src/core";
import { formatResult } from "../../src/format";

export default tool({
  description: "Return a completed space-bus session's final assistant message and diff.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args) {
    const r = await result(args.sessionId);
    if (!r.ok) return r.error;
    return formatResult(r);
  },
});
