import { dispatch, toDispatchArgs } from "../core";
import {
  dispatchMetadata,
  formatDispatch,
  formatRosterHeader,
} from "../format";
import {
  type ContextResolver,
  ensureAndLoadContext,
  withRosterHeader,
} from "./shared";
import { type BusTool, defineBusTool } from "./spec";

export const BUS_TASK_DESCRIPTION =
  "Dispatch a prompt to an agent in the given space-bus manifest project, or steer an existing session by passing sessionId (answers its pending question, else sends a follow-up prompt). Returns immediately; does not wait for completion.";

export function makeBusTask(
  defaultDirectory?: string,
  resolveContext: ContextResolver = ensureAndLoadContext,
): BusTool {
  return defineBusTool({
    name: "bus_task",
    description: BUS_TASK_DESCRIPTION,
    defaultDirectory,
    args: (z) => ({
      project: z
        .string()
        .optional()
        .describe(
          "Manifest project name, e.g. dashboard, agent, control-plane, infra. Required when starting a new session.",
        ),
      prompt: z.string().describe("The prompt to send to the delegated agent"),
      title: z
        .string()
        .optional()
        .describe(
          "Optional session title (only used when starting a new session)",
        ),
      sessionId: z
        .string()
        .optional()
        .describe(
          "Existing session ID to steer instead of starting a new session",
        ),
      messageId: z
        .string()
        .optional()
        .describe(
          "Optional caller-supplied id to correlate this prompt with the message OpenCode creates for it (msg_ + 12 hex + 14 alphanumeric chars). Omit to dispatch without correlation.",
        ),
      roster: z
        .string()
        .optional()
        .describe(
          "Registry roster name to target. Resolution precedence: this param > workspace directory (see bus_registry to list)",
        ),
    }),
    async run(args, directory) {
      // Fail-fast ordering pin: arg-shape validation runs BEFORE context
      // loading (index.test.ts asserts this).
      const dispatchArgs = toDispatchArgs(args);
      if (!dispatchArgs.ok) throw new Error(dispatchArgs.error);
      let resolved: Awaited<ReturnType<ContextResolver>>;
      try {
        resolved = await resolveContext(directory, args.roster);
      } catch (e) {
        throw new Error((e as Error).message);
      }
      const source = { name: resolved.rosterName, path: resolved.rosterPath };
      const r = await dispatch(dispatchArgs, { context: resolved.context });
      if (!r.ok) throw new Error(withRosterHeader(source, r.error));
      const header = formatRosterHeader(source);
      return {
        output: `${header}\n${formatDispatch(r)}`,
        metadata: dispatchMetadata(r),
      };
    },
  });
}
