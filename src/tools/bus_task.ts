import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { dispatch } from "../core";
import { formatDispatch } from "../format";

export const BUS_TASK_DESCRIPTION =
  "Dispatch a prompt to an agent in the given space-bus manifest project, or steer an existing session by passing sessionId (answers its pending question, else sends a follow-up prompt). Returns immediately; does not wait for completion.";

export function makeBusTask(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_TASK_DESCRIPTION,
    args: {
      project: tool.schema
        .string()
        .optional()
        .describe("Manifest project name, e.g. dashboard, agent, control-plane, infra. Required when starting a new session."),
      prompt: tool.schema.string().describe("The prompt to send to the delegated agent"),
      title: tool.schema.string().optional().describe("Optional session title (only used when starting a new session)"),
      sessionId: tool.schema
        .string()
        .optional()
        .describe("Existing session ID to steer instead of starting a new session"),
    },
    async execute(args, ctx) {
      const r = await dispatch({ ...args, directory: ctx.directory ?? defaultDirectory });
      if (!r.ok) throw new Error(r.error);
      return formatDispatch(r);
    },
  });
}
