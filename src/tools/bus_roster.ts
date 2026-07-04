import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { roster } from "../core";
import { formatRoster } from "../format";
import { ensureAndLoadContext } from "./shared";

export const BUS_ROSTER_DESCRIPTION =
  "List the space-bus manifest projects with live session status per project.";

export function makeBusRoster(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_ROSTER_DESCRIPTION,
    args: {},
    async execute(_args, ctx) {
      const directory = ctx.directory ?? defaultDirectory;
      let context: Awaited<ReturnType<typeof ensureAndLoadContext>>;
      try {
        context = await ensureAndLoadContext(directory);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const r = await roster({ context });
      if (!r.ok) throw new Error(r.error);
      return formatRoster(r.projects);
    },
  });
}
