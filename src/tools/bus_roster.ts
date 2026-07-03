import { tool, type ToolDefinition } from "@opencode-ai/plugin";
import { roster } from "../core";
import { formatRoster } from "../format";

export const BUS_ROSTER_DESCRIPTION = "List the space-bus manifest projects with live session status per project.";

export function makeBusRoster(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_ROSTER_DESCRIPTION,
    args: {},
    async execute(_args, ctx) {
      const r = await roster({ directory: ctx.directory ?? defaultDirectory });
      if (!r.ok) throw new Error(r.error);
      return formatRoster(r.projects);
    },
  });
}
