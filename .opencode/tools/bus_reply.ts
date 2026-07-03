import { tool } from "@opencode-ai/plugin";
import { reply } from "../../src/core";
import { formatReply } from "../../src/format";

export default tool({
  description:
    "Answer a delegated session's pending question, or send it a follow-up prompt. Steers an existing space-bus session without creating a new one.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
    message: tool.schema.string().describe("The answer or follow-up message to send"),
  },
  async execute(args) {
    const r = await reply(args.sessionId, args.message);
    if (!r.ok) return r.error;
    return formatReply(r);
  },
});
