import { tool } from "@opencode-ai/plugin";
import { z } from "zod";
import { dispatch } from "../../src/core";

export default tool({
  description:
    "Dispatch a prompt to an agent in the given space-bus manifest project. Returns immediately with a session ID; does not wait for completion.",
  args: {
    project: tool.schema.string().describe("Manifest project name, e.g. dashboard, agent, control-plane, infra"),
    prompt: tool.schema.string().describe("The prompt to send to the delegated agent"),
    title: tool.schema.string().optional().describe("Optional session title"),
  },
  async execute(args) {
    const r = await dispatch(args.project, args.prompt, args.title);
    if (!r.ok) return r.error;
    return `Dispatched. Session ${r.sessionId} in ${r.project} — report this ID.`;
  },
});
