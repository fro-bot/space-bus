import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  isManagedRoster,
  isManagedRosterAtPath,
  loadContext,
  loadContextForRosterPath,
  resolveRosterPath,
} from "./config";
import { readRegistry, resolveRosterByName } from "./registry";
import { ensureServer } from "./server";
import { makeBusContextTools } from "./tools";
import {
  ACTION_SCHEMA,
  BUS_REGISTRY_DESCRIPTION,
  type BusRegistryArgs,
  runBusRegistryAction,
} from "./tools/bus_registry";
import type { ResolvedContext } from "./tools/shared";

// Ephemeral, connector-session-scoped active-roster default (R10): one
// stdio process = one connector connection, so a single module-level
// variable is an adequate "session" for this process — it resets to
// undefined on every process restart, matching the KTD "MCP session state
// is ephemeral" decision. NOT persisted, NOT shared across processes.
let activeRoster: string | undefined;

const registrySession = {
  getActive: () => activeRoster,
  setActive: (name: string) => {
    activeRoster = name;
  },
  clearActive: () => {
    activeRoster = undefined;
  },
};

const ROSTER_PARAM_SCHEMA = z
  .string()
  .optional()
  .describe(
    "Registry roster name to target. Resolution precedence: this param > " +
      "connector-session active roster (bus_registry use) > " +
      "SPACE_BUS_CONFIG > registry default (bus_registry set-default) " +
      "(see bus_registry to list)",
  );

/**
 * MCP is attach-only by default (never spawns) — set SPACE_BUS_MCP_SPAWN
 * (any truthy value) to opt in to ensure-on-demand, matching the plugin
 * tools' behavior. MCP is single-directory-per-process: ambient directory
 * resolution rides SPACE_BUS_CONFIG alone (no process.cwd() threading).
 *
 * Resolution precedence (R9/R10, MCP side), full chain:
 *   1. explicit `rosterName` param
 *   2. connector-session active roster (`bus_registry` `use`)
 *   3. SPACE_BUS_CONFIG (ambient directory resolution)
 *   4. registry default (`bus_registry set-default`) — only consulted
 *      when SPACE_BUS_CONFIG is unset (Fix 8 / R10)
 *   5. error listing the available options
 */
async function resolveByName(
  name: string,
  ensure: (rosterPath: string) => Promise<unknown>,
): Promise<ResolvedContext> {
  // Resolve the name to a path ONCE — the managed check, ensureServer, and
  // context load all use this same resolved path, never re-resolving the
  // (mutable) registry name a second time (Fix 2 — closes a TOCTOU window
  // where the name could be re-registered to a different path in between).
  const resolved = resolveRosterByName(name);
  if (!resolved.ok) throw new Error(resolved.error);
  const rosterPath = resolved.path;
  if (process.env["SPACE_BUS_MCP_SPAWN"] && isManagedRosterAtPath(rosterPath)) {
    await ensure(rosterPath);
  }
  const context = loadContextForRosterPath(rosterPath);
  return { context, rosterName: resolved.name, rosterPath };
}

async function mcpLoadContext(
  rosterName?: string,
  ensure: (rosterPath: string) => Promise<unknown> = ensureServer,
): Promise<ResolvedContext> {
  const effectiveRosterName = rosterName ?? activeRoster;
  if (effectiveRosterName !== undefined) {
    return resolveByName(effectiveRosterName, ensure);
  }
  // No explicit roster and no session-active roster: try ambient
  // SPACE_BUS_CONFIG resolution first.
  let ambientError: Error | undefined;
  try {
    const rosterPath = resolveRosterPath();
    if (process.env["SPACE_BUS_MCP_SPAWN"] && isManagedRoster()) {
      await ensure(rosterPath);
    }
    return { context: loadContext(), rosterPath };
  } catch (e) {
    ambientError = e as Error;
  }
  // SPACE_BUS_CONFIG is unset (or ambient resolution otherwise failed) —
  // fall back to the registry default (Fix 8 / R10), resolved as if it
  // were the session-active name (same path-based load, same header echo
  // with the canonical name).
  const read = readRegistry();
  if (read.ok && read.registry.default !== undefined) {
    return resolveByName(read.registry.default, ensure);
  }
  // Nothing to fall back to — surface the original ambient-resolution
  // error naming SPACE_BUS_CONFIG / spacebus.json.
  throw ambientError;
}

// Injected at build time via build.ts's Bun.build `define` (reads
// package.json's version). Falls back to "dev" when running directly from
// source (bun run src/mcp.ts, tests) where the define substitution never
// happens.
declare const __SPACE_BUS_VERSION__: string;
const version =
  typeof __SPACE_BUS_VERSION__ !== "undefined" ? __SPACE_BUS_VERSION__ : "dev";

const server = new McpServer({
  name: "space-bus",
  version,
});

// bus_task is the only roster-bearing tool with structured output: its
// shared-factory `metadata` is MCP's `structuredContent`.
const BUS_TASK_OUTPUT_SCHEMA = {
  sessionId: z.string().describe("The dispatched or steered session ID"),
  project: z.string().describe("Manifest project name that owns the session"),
  mode: z
    .enum(["new", "question-reply", "follow-up"])
    .describe("How the prompt was delivered"),
  messageId: z
    .string()
    .optional()
    .describe(
      "Echoes the supplied messageId for new/follow-up dispatches; omitted otherwise",
    ),
};

function mcpError(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

// The five roster-bearing tools come from the SAME factories as the plugin
// adapters (tools/index.ts), so validation, error text, header echo and
// output assembly have one implementation. MCP supplies only its own context
// resolver (session roster > SPACE_BUS_CONFIG > registry default,
// attach-only) and the protocol wrapping below. MCP is single-directory-per-
// process: no per-call directory exists, so the directory argument is
// ignored — ambient resolution rides SPACE_BUS_CONFIG alone. Do not thread
// process.cwd() in.
for (const tool of makeBusContextTools(undefined, (_directory, rosterName) =>
  mcpLoadContext(rosterName),
)) {
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      // Same field set as the plugin tool; only the roster param's
      // description differs, to document the connector-session step.
      inputSchema: { ...tool.args(z), roster: ROSTER_PARAM_SCHEMA },
      ...(tool.name === "bus_task"
        ? { outputSchema: BUS_TASK_OUTPUT_SCHEMA }
        : {}),
    },
    async (args: Record<string, unknown>) => {
      try {
        const out = await tool.execute(args);
        if (typeof out === "string") {
          return { content: [{ type: "text" as const, text: out }] };
        }
        return {
          content: [{ type: "text" as const, text: out.output }],
          ...(out.metadata ? { structuredContent: out.metadata } : {}),
        };
      } catch (e) {
        return mcpError((e as Error).message);
      }
    },
  );
}

server.registerTool(
  "bus_registry",
  {
    description: BUS_REGISTRY_DESCRIPTION,
    // MCP-only: the full discriminated-union schema (not a raw shape) so
    // connectors discover per-action required fields (Fix 4). The plugin
    // surface (tools/bus_registry.ts's makeBusRegistry) keeps the flat
    // BUS_REGISTRY_ARGS raw shape — tool.args requires a ZodRawShape.
    inputSchema: ACTION_SCHEMA,
    outputSchema: {
      rosters: z
        .array(
          z.object({
            name: z.string(),
            path: z.string(),
            default: z.boolean(),
            active: z.boolean(),
          }),
        )
        .optional()
        .describe("Populated for the `list` action only"),
    },
  },
  async (args) => {
    try {
      const { text, listMetadata } = await runBusRegistryAction(
        args as BusRegistryArgs,
        registrySession,
      );
      // outputSchema requires structuredContent on every success; rosters
      // is populated for `list` only.
      return {
        content: [{ type: "text", text }],
        structuredContent: listMetadata ? { rosters: listMetadata } : {},
      };
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Test seam: lets regression tests connect over an in-memory transport
// without starting the stdio transport below.
export { server };

if (import.meta.main) {
  main().catch((err) => {
    console.error("space-bus mcp: fatal startup error:", err);
    process.exit(1);
  });
}
