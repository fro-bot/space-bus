import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { roster } from "../core";
import { formatRoster, formatRosterHeader } from "../format";
import { ensureAndLoadContext } from "./shared";

export const BUS_ROSTER_DESCRIPTION =
  "List the space-bus manifest projects with live session status per project.";

export function makeBusRoster(defaultDirectory?: string): ToolDefinition {
  return tool({
    description: BUS_ROSTER_DESCRIPTION,
    args: {
      roster: tool.schema
        .string()
        .optional()
        .describe(
          "Registry roster name to target instead of the ambient/default roster (see bus_registry to list)",
        ),
    },
    async execute(args, ctx) {
      const directory = ctx.directory ?? defaultDirectory;
      let resolved: Awaited<ReturnType<typeof ensureAndLoadContext>>;
      try {
        resolved = await ensureAndLoadContext(directory, args.roster);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const r = await roster({ context: resolved.context });
      if (!r.ok) throw new Error(r.error);
      const header = formatRosterHeader({
        name: resolved.rosterName,
        path: resolved.rosterPath,
      });
      return `${header}\n${formatRoster(r.projects)}`;
    },
  });
}
