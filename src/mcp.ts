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
import { dispatch, result, roster, status, toDispatchArgs, wait } from "./core";
import {
  dispatchMetadata,
  formatDispatch,
  formatResult,
  formatRoster,
  formatRosterHeader,
  formatStatus,
  formatWait,
} from "./format";
import { readRegistry, resolveRosterByName } from "./registry";
import { ensureServer } from "./server";
import {
  ACTION_SCHEMA,
  BUS_REGISTRY_DESCRIPTION,
  type BusRegistryArgs,
  runBusRegistryAction,
} from "./tools/bus_registry";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";
import { BUS_WAIT_DESCRIPTION, MAX_WAIT_TIMEOUT_MS } from "./tools/bus_wait";
import { withRosterHeader } from "./tools/shared";

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

type McpLoadedContext = {
  context: Awaited<ReturnType<typeof loadContext>>;
  rosterName?: string;
  rosterPath: string;
};

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
): Promise<McpLoadedContext> {
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
): Promise<McpLoadedContext> {
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

server.registerTool(
  "bus_roster",
  {
    description: BUS_ROSTER_DESCRIPTION,
    inputSchema: { roster: ROSTER_PARAM_SCHEMA },
  },
  async (args) => {
    let loaded: McpLoadedContext;
    try {
      // MCP is single-directory-per-process: no per-call directory exists, so
      // ambient resolution rides SPACE_BUS_CONFIG alone. Do not thread
      // process.cwd() in.
      loaded = await mcpLoadContext(args.roster);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const source = { name: loaded.rosterName, path: loaded.rosterPath };
    const r = await roster({ context: loaded.context });
    if (!r.ok)
      return {
        content: [{ type: "text", text: withRosterHeader(source, r.error) }],
        isError: true,
      };
    const header = formatRosterHeader(source);
    return {
      content: [
        { type: "text", text: `${header}\n${formatRoster(r.projects)}` },
      ],
    };
  },
);

server.registerTool(
  "bus_task",
  {
    description: BUS_TASK_DESCRIPTION,
    inputSchema: {
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
      roster: ROSTER_PARAM_SCHEMA,
    },
    outputSchema: {
      sessionId: z.string().describe("The dispatched or steered session ID"),
      project: z
        .string()
        .describe("Manifest project name that owns the session"),
      mode: z
        .enum(["new", "question-reply", "follow-up"])
        .describe("How the prompt was delivered"),
    },
  },
  async (args) => {
    const dispatchArgs = toDispatchArgs(args);
    if (!dispatchArgs.ok)
      return {
        content: [{ type: "text", text: dispatchArgs.error }],
        isError: true,
      };
    let loaded: McpLoadedContext;
    try {
      loaded = await mcpLoadContext(args.roster);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const source = { name: loaded.rosterName, path: loaded.rosterPath };
    const r = await dispatch(dispatchArgs, { context: loaded.context });
    if (!r.ok)
      return {
        content: [{ type: "text", text: withRosterHeader(source, r.error) }],
        isError: true,
      };
    const header = formatRosterHeader(source);
    return {
      content: [{ type: "text", text: `${header}\n${formatDispatch(r)}` }],
      structuredContent: dispatchMetadata(r),
    };
  },
);

server.registerTool(
  "bus_status",
  {
    description: BUS_STATUS_DESCRIPTION,
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
      roster: ROSTER_PARAM_SCHEMA,
    },
  },
  async (args) => {
    let loaded: McpLoadedContext;
    try {
      loaded = await mcpLoadContext(args.roster);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const source = { name: loaded.rosterName, path: loaded.rosterPath };
    const r = await status(args.sessionId, { context: loaded.context });
    if (!r.ok)
      return {
        content: [{ type: "text", text: withRosterHeader(source, r.error) }],
        isError: true,
      };
    const header = formatRosterHeader(source);
    return {
      content: [{ type: "text", text: `${header}\n${formatStatus(r)}` }],
    };
  },
);

server.registerTool(
  "bus_result",
  {
    description: BUS_RESULT_DESCRIPTION,
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
      roster: ROSTER_PARAM_SCHEMA,
    },
  },
  async (args) => {
    let loaded: McpLoadedContext;
    try {
      loaded = await mcpLoadContext(args.roster);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const source = { name: loaded.rosterName, path: loaded.rosterPath };
    const r = await result(args.sessionId, { context: loaded.context });
    if (!r.ok)
      return {
        content: [{ type: "text", text: withRosterHeader(source, r.error) }],
        isError: true,
      };
    const header = formatRosterHeader(source);
    return {
      content: [{ type: "text", text: `${header}\n${formatResult(r)}` }],
    };
  },
);

server.registerTool(
  "bus_wait",
  {
    description: BUS_WAIT_DESCRIPTION,
    inputSchema: {
      sessionIds: z
        .array(z.string())
        .min(1, "bus_wait requires at least one sessionId")
        .max(100, "bus_wait accepts at most 100 sessionIds")
        .describe("Session IDs to watch (returned by bus_task)"),
      timeoutMs: z
        .number()
        .positive()
        .optional()
        .describe(
          `Max time to wait in milliseconds before returning a timeout snapshot (default 60s, capped at ${MAX_WAIT_TIMEOUT_MS}ms; soft deadline, may overshoot by up to ~30s if a request is slow)`,
        ),
      roster: ROSTER_PARAM_SCHEMA,
    },
  },
  async (args) => {
    let loaded: McpLoadedContext;
    try {
      loaded = await mcpLoadContext(args.roster);
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const timeoutMs =
      args.timeoutMs !== undefined
        ? Math.min(args.timeoutMs, MAX_WAIT_TIMEOUT_MS)
        : undefined;
    const source = { name: loaded.rosterName, path: loaded.rosterPath };
    const r = await wait(args.sessionIds, {
      context: loaded.context,
      timeoutMs,
    });
    if (!r.ok)
      return {
        content: [{ type: "text", text: withRosterHeader(source, r.error) }],
        isError: true,
      };
    const header = formatRosterHeader(source);
    return {
      content: [{ type: "text", text: `${header}\n${formatWait(r)}` }],
    };
  },
);

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
      return listMetadata
        ? {
            content: [{ type: "text", text }],
            structuredContent: { rosters: listMetadata },
          }
        : { content: [{ type: "text", text }] };
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

main().catch((err) => {
  console.error("space-bus mcp: fatal startup error:", err);
  process.exit(1);
});
