import { roster } from "../core";
import { formatRoster, formatRosterHeader } from "../format";
import { ensureAndLoadContext, withRosterHeader } from "./shared";
import { type BusTool, defineBusTool } from "./spec";

export const BUS_ROSTER_DESCRIPTION =
  "List the space-bus manifest projects with live session status per project.";

export function makeBusRoster(defaultDirectory?: string): BusTool {
  return defineBusTool({
    name: "bus_roster",
    description: BUS_ROSTER_DESCRIPTION,
    defaultDirectory,
    args: (z) => ({
      roster: z
        .string()
        .optional()
        .describe(
          "Registry roster name to target. Resolution precedence: this param > workspace directory (see bus_registry to list)",
        ),
    }),
    async run(args, directory) {
      let resolved: Awaited<ReturnType<typeof ensureAndLoadContext>>;
      try {
        resolved = await ensureAndLoadContext(directory, args.roster);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const source = { name: resolved.rosterName, path: resolved.rosterPath };
      const r = await roster({ context: resolved.context });
      if (!r.ok) throw new Error(withRosterHeader(source, r.error));
      const header = formatRosterHeader(source);
      return `${header}\n${formatRoster(r.projects)}`;
    },
  });
}
