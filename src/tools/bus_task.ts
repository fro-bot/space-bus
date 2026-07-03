import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { type DispatchArgs, dispatch } from "../core";
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
        .describe(
          "Manifest project name, e.g. dashboard, agent, control-plane, infra. Required when starting a new session.",
        ),
      prompt: tool.schema
        .string()
        .describe("The prompt to send to the delegated agent"),
      title: tool.schema
        .string()
        .optional()
        .describe(
          "Optional session title (only used when starting a new session)",
        ),
      sessionId: tool.schema
        .string()
        .optional()
        .describe(
          "Existing session ID to steer instead of starting a new session",
        ),
    },
    async execute(args, ctx) {
      // Tool args schema is runtime-validated but loosely typed (all
      // optional fields); the discriminated-union exclusivity in
      // DispatchArgs is enforced by dispatch()'s runtime guard, not by
      // this cast.
      const r = await dispatch({
        ...args,
        directory: ctx.directory ?? defaultDirectory,
      } as DispatchArgs);
      if (!r.ok) throw new Error(r.error);
      return formatDispatch(r);
    },
  });
}
