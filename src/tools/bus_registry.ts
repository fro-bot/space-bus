/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * The sixth bus tool: roster registry management (list/use/create/register/
 * unregister/set-default/add-project/remove-project/update-project) behind
 * ONE action-discriminated tool, mirroring the other five tools' shared
 * factory/description-constant parity pattern. Node-only (imports
 * registry.ts + roster-edit.ts), same lane as config.ts/server.ts.
 *
 * `use` is an MCP-only concept (R10): the plugin surface resolves ambient
 * roster from `ctx.directory`, so there is no session to select a default
 * for. The factory takes an optional `session` seam — when absent (the
 * plugin surface), `use` returns an actionable error explaining why;
 * when present (MCP, wired to an in-memory module-level variable — see
 * mcp.ts), `use` mutates it after revalidating the name resolves.
 */

import { isAbsolute } from "node:path";
import { type ToolDefinition, tool } from "@opencode-ai/plugin";
import { z } from "zod";

import { type ServerConfig, serverConfigSchema } from "../config";
import { formatRosterHeader } from "../format";
import {
  readRegistry,
  registerRoster,
  resolveRosterByName,
  setDefaultRoster,
  unregisterRoster,
} from "../registry";
import {
  addProject,
  createRoster,
  type ProjectPatch,
  type RosterProjectInput,
  removeProject,
  updateProject,
} from "../roster-edit";

export const BUS_REGISTRY_DESCRIPTION =
  "Manage the roster registry: list registered rosters, create/register/unregister rosters, set the default, select an active roster for this connector session (MCP only), and add/remove/update projects on a registered roster.";

/** Session seam (R10): ephemeral, connector-side "active roster" state.
 * Only the MCP surface wires this (mcp.ts's module-level `activeRoster`
 * variable) — the plugin surface omits it, so `use` fails actionably. */
export interface RegistrySession {
  getActive(): string | undefined;
  setActive(name: string): void;
  clearActive(): void;
}

const projectInputSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  description: z.string(),
});

const projectPatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    description: z.string().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message:
      "patch must include at least one field (name, path, or description)",
  });

// Flat, top-level argument shape for the PLUGIN surface only — `tool()`'s
// args requires a ZodRawShape (flat key/value map), not a nested
// discriminated union. The MCP surface instead registers ACTION_SCHEMA
// (below) directly as its inputSchema, so MCP connectors can discover the
// precise per-action required-field combinations; the plugin surface
// re-validates every call against ACTION_SCHEMA internally
// (runBusRegistryAction) regardless of which raw shape it was called
// with, so both surfaces get the same actionable, action-named errors.
export const BUS_REGISTRY_ARGS = {
  action: z.enum([
    "list",
    "use",
    "create",
    "register",
    "unregister",
    "set-default",
    "add-project",
    "remove-project",
    "update-project",
  ]),
  roster: z
    .string()
    .optional()
    .describe(
      "Registry roster name — required by use/add-project/remove-project/update-project",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Roster name to create/register/unregister/set-default — required by those actions",
    ),
  path: z
    .string()
    .optional()
    .describe("Absolute path to a spacebus.json — required by create/register"),
  server: serverConfigSchema
    .optional()
    .describe(
      "Server block for create (baseUrl XOR managed; defaults to managed {})",
    ),
  project: projectInputSchema
    .optional()
    .describe("{name, path, description} — required by add-project"),
  projectName: z
    .string()
    .optional()
    .describe(
      "Existing project name — required by remove-project/update-project",
    ),
  patch: projectPatchSchema
    .optional()
    .describe("Partial project fields to apply — required by update-project"),
};

export type BusRegistryAction =
  | "list"
  | "use"
  | "create"
  | "register"
  | "unregister"
  | "set-default"
  | "add-project"
  | "remove-project"
  | "update-project";

export type BusRegistryArgs = {
  action: BusRegistryAction;
  roster?: string;
  name?: string;
  path?: string;
  server?: ServerConfig;
  project?: RosterProjectInput;
  projectName?: string;
  patch?: ProjectPatch;
};

// Precise per-action shape validation, discriminated on `action`. Used two
// ways: (1) internally by runBusRegistryAction to re-parse the flat args
// object and produce an actionable, action-named error when a required
// combination is missing or an irrelevant field is present (every branch
// is a `z.strictObject`, so e.g. passing `path` to `unregister` is
// rejected rather than silently stripped); (2) directly as the MCP
// surface's `inputSchema` (mcp.ts), since MCP's registerTool accepts a
// full zod schema (not only a raw shape) — connectors get precise
// per-action required-field discovery. The PLUGIN surface still uses the
// flat BUS_REGISTRY_ARGS raw shape (tool.args requires ZodRawShape).
export const ACTION_SCHEMA = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({ action: z.literal("use"), roster: z.string().min(1) }),
  z.strictObject({
    action: z.literal("create"),
    name: z.string().min(1),
    path: z.string().min(1).refine(isAbsolute, {
      message: "path must be an absolute filesystem path",
    }),
    server: serverConfigSchema.optional(),
  }),
  z.strictObject({
    action: z.literal("register"),
    name: z.string().min(1),
    path: z.string().min(1).refine(isAbsolute, {
      message: "path must be an absolute filesystem path",
    }),
  }),
  z.strictObject({ action: z.literal("unregister"), name: z.string().min(1) }),
  z.strictObject({ action: z.literal("set-default"), name: z.string().min(1) }),
  z.strictObject({
    action: z.literal("add-project"),
    roster: z.string().min(1),
    project: projectInputSchema,
  }),
  z.strictObject({
    action: z.literal("remove-project"),
    roster: z.string().min(1),
    projectName: z.string().min(1),
  }),
  z.strictObject({
    action: z.literal("update-project"),
    roster: z.string().min(1),
    projectName: z.string().min(1),
    patch: projectPatchSchema,
  }),
]);

export type RegistryListEntry = {
  name: string;
  path: string;
  default: boolean;
  active: boolean;
};

/** Machine-readable list metadata, shared verbatim by both surfaces
 * (plugin ToolResult.metadata and MCP structuredContent), same pattern as
 * bus_task's dispatchMetadata. Only `list` gets structured output — every
 * other action is a one-line mutation confirmation, not worth a shape. */
export function registryListMetadata(
  session?: RegistrySession,
): { ok: true; rosters: RegistryListEntry[] } | { ok: false; error: string } {
  const read = readRegistry();
  if (!read.ok) return { ok: false, error: read.error };
  const active = session?.getActive();
  return {
    ok: true,
    rosters: read.registry.rosters.map((r) => ({
      name: r.name,
      path: r.path,
      default: read.registry.default === r.name,
      active: active === r.name,
    })),
  };
}

function formatList(rosters: RegistryListEntry[]): string {
  if (rosters.length === 0) return "no rosters registered";
  return rosters
    .map((r) => {
      const flags = [
        r.default ? "default" : null,
        r.active ? "active" : null,
      ].filter((f): f is string => f !== null);
      const suffix = flags.length > 0 ? ` (${flags.join(", ")})` : "";
      return `${r.name}: ${r.path}${suffix}`;
    })
    .join("\n");
}

type ActionArgs = z.infer<typeof ACTION_SCHEMA>;
type ActionResult = { text: string; listMetadata?: RegistryListEntry[] };

function runList(session: RegistrySession | undefined): ActionResult {
  const listed = registryListMetadata(session);
  if (!listed.ok) throw new Error(`bus_registry list: ${listed.error}`);
  return { text: formatList(listed.rosters), listMetadata: listed.rosters };
}

function runUse(
  args: Extract<ActionArgs, { action: "use" }>,
  session: RegistrySession | undefined,
): ActionResult {
  if (!session) {
    throw new Error(
      "bus_registry use: roster selection is a connector-session concept — plugin calls resolve by workspace directory; pass roster per call instead",
    );
  }
  const resolved = resolveRosterByName(args.roster);
  if (!resolved.ok) throw new Error(`bus_registry use: ${resolved.error}`);
  session.setActive(resolved.name);
  return {
    text: `bus_registry use: active roster set to "${resolved.name}" (${resolved.path})`,
  };
}

function runCreate(
  args: Extract<ActionArgs, { action: "create" }>,
): ActionResult {
  const result = createRoster({
    name: args.name,
    rosterPath: args.path,
    server: args.server,
  });
  if (!result.ok) throw new Error(`bus_registry create: ${result.error}`);
  return {
    text: `bus_registry create: ${formatRosterHeader({ name: args.name, path: args.path })} created and registered`,
  };
}

function runRegister(
  args: Extract<ActionArgs, { action: "register" }>,
): ActionResult {
  const result = registerRoster(args.name, args.path);
  if (!result.ok) throw new Error(`bus_registry register: ${result.error}`);
  return {
    text: `bus_registry register: ${formatRosterHeader({ name: args.name, path: args.path })} registered`,
  };
}

function runUnregister(
  args: Extract<ActionArgs, { action: "unregister" }>,
  session: RegistrySession | undefined,
): ActionResult {
  const result = unregisterRoster(args.name);
  if (!result.ok) throw new Error(`bus_registry unregister: ${result.error}`);
  const active = session?.getActive();
  if (
    active !== undefined &&
    active.toLowerCase() === args.name.toLowerCase()
  ) {
    session?.clearActive();
    return {
      text: `bus_registry unregister: "${args.name}" unregistered — session-active roster cleared — omitted-roster calls fall back to ambient`,
    };
  }
  return { text: `bus_registry unregister: "${args.name}" unregistered` };
}

function runSetDefault(
  args: Extract<ActionArgs, { action: "set-default" }>,
): ActionResult {
  const result = setDefaultRoster(args.name);
  if (!result.ok) throw new Error(`bus_registry set-default: ${result.error}`);
  return {
    text: `bus_registry set-default: "${args.name}" is now the default roster`,
  };
}

function runAddProject(
  args: Extract<ActionArgs, { action: "add-project" }>,
): ActionResult {
  const resolved = resolveRosterByName(args.roster);
  if (!resolved.ok)
    throw new Error(`bus_registry add-project: ${resolved.error}`);
  const result = addProject(resolved.path, args.project);
  if (!result.ok) throw new Error(`bus_registry add-project: ${result.error}`);
  return {
    text: `bus_registry add-project: added "${args.project.name}" to ${formatRosterHeader({ name: args.roster, path: resolved.path })}`,
  };
}

function runRemoveProject(
  args: Extract<ActionArgs, { action: "remove-project" }>,
): ActionResult {
  const resolved = resolveRosterByName(args.roster);
  if (!resolved.ok)
    throw new Error(`bus_registry remove-project: ${resolved.error}`);
  const result = removeProject(resolved.path, args.projectName);
  if (!result.ok)
    throw new Error(`bus_registry remove-project: ${result.error}`);
  return {
    text: `bus_registry remove-project: removed "${args.projectName}" from ${formatRosterHeader({ name: args.roster, path: resolved.path })}`,
  };
}

function runUpdateProject(
  args: Extract<ActionArgs, { action: "update-project" }>,
): ActionResult {
  const resolved = resolveRosterByName(args.roster);
  if (!resolved.ok)
    throw new Error(`bus_registry update-project: ${resolved.error}`);
  const result = updateProject(resolved.path, args.projectName, args.patch);
  if (!result.ok)
    throw new Error(`bus_registry update-project: ${result.error}`);
  return {
    text: `bus_registry update-project: updated "${args.projectName}" on ${formatRosterHeader({ name: args.roster, path: resolved.path })}`,
  };
}

/**
 * Runs one bus_registry action and returns its formatted text result.
 * Throws on any invalid input or `ok:false` underneath — every message
 * names the action, per the plan's per-action-error contract. Shared by
 * both the plugin tool's execute() and mcp.ts's registerTool handler so
 * the two surfaces can't drift. Dispatch is a thin switch over
 * per-action helper functions (kept small individually to stay under the
 * lint complexity ceiling).
 */
export async function runBusRegistryAction(
  rawArgs: BusRegistryArgs,
  session?: RegistrySession,
): Promise<ActionResult> {
  const parsed = ACTION_SCHEMA.safeParse(rawArgs);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue
      ? `${issue.path.length > 0 ? `${issue.path.join(".")}: ` : ""}${issue.message}`
      : parsed.error.message;
    throw new Error(
      `bus_registry ${rawArgs.action}: invalid input — ${detail}`,
    );
  }
  const args = parsed.data;

  switch (args.action) {
    case "list":
      return runList(session);
    case "use":
      return runUse(args, session);
    case "create":
      return runCreate(args);
    case "register":
      return runRegister(args);
    case "unregister":
      return runUnregister(args, session);
    case "set-default":
      return runSetDefault(args);
    case "add-project":
      return runAddProject(args);
    case "remove-project":
      return runRemoveProject(args);
    case "update-project":
      return runUpdateProject(args);
  }
}

export function makeBusRegistry(session?: RegistrySession): ToolDefinition {
  return tool({
    description: BUS_REGISTRY_DESCRIPTION,
    args: BUS_REGISTRY_ARGS,
    async execute(args) {
      const { text, listMetadata } = await runBusRegistryAction(
        args as BusRegistryArgs,
        session,
      );
      if (listMetadata)
        return { output: text, metadata: { rosters: listMetadata } };
      return text;
    },
  });
}
