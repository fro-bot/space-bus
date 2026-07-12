import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  isManagedRoster,
  isManagedRosterAtPath,
  loadContext,
  loadContextForRoster,
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
import { resolveRosterByName } from "./registry";
import { ensureServer } from "./server";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";
import { BUS_WAIT_DESCRIPTION, MAX_WAIT_TIMEOUT_MS } from "./tools/bus_wait";

const ROSTER_PARAM_SCHEMA = z
  .string()
  .optional()
  .describe(
    "Registry roster name to target instead of the ambient/default roster (see bus_registry to list)",
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
 * Resolution precedence (R9/R10, MCP side): an explicit `rosterName` param
 * wins over the ambient SPACE_BUS_CONFIG resolution. MCP session-state
 * (`use`) is Unit 5 — ambient here stays SPACE_BUS_CONFIG-only.
 */
async function mcpLoadContext(rosterName?: string): Promise<McpLoadedContext> {
  if (rosterName !== undefined) {
    const resolved = resolveRosterByName(rosterName);
    if (!resolved.ok) throw new Error(resolved.error);
    const rosterPath = resolved.path;
    if (
      process.env["SPACE_BUS_MCP_SPAWN"] &&
      isManagedRosterAtPath(rosterPath)
    ) {
      await ensureServer(rosterPath);
    }
    const { context } = loadContextForRoster(rosterName);
    return { context, rosterName, rosterPath };
  }
  if (process.env["SPACE_BUS_MCP_SPAWN"] && isManagedRoster()) {
    const rosterPath = resolveRosterPath();
    await ensureServer(rosterPath);
  }
  const rosterPath = resolveRosterPath();
  return { context: loadContext(), rosterPath };
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
    const r = await roster({ context: loaded.context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    const header = formatRosterHeader({
      name: loaded.rosterName,
      path: loaded.rosterPath,
    });
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
    const r = await dispatch(dispatchArgs, { context: loaded.context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    const header = formatRosterHeader({
      name: loaded.rosterName,
      path: loaded.rosterPath,
    });
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
    const r = await status(args.sessionId, { context: loaded.context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    const header = formatRosterHeader({
      name: loaded.rosterName,
      path: loaded.rosterPath,
    });
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
    const r = await result(args.sessionId, { context: loaded.context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    const header = formatRosterHeader({
      name: loaded.rosterName,
      path: loaded.rosterPath,
    });
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
    const r = await wait(args.sessionIds, {
      context: loaded.context,
      timeoutMs,
    });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    const header = formatRosterHeader({
      name: loaded.rosterName,
      path: loaded.rosterPath,
    });
    return {
      content: [{ type: "text", text: `${header}\n${formatWait(r)}` }],
    };
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
