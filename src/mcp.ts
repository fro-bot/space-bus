import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { isManagedRoster, loadContext, resolveRosterPath } from "./config";
import { dispatch, result, roster, status, toDispatchArgs, wait } from "./core";
import {
  dispatchMetadata,
  formatDispatch,
  formatResult,
  formatRoster,
  formatStatus,
  formatWait,
} from "./format";
import { ensureServer } from "./server";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";
import { BUS_WAIT_DESCRIPTION, MAX_WAIT_TIMEOUT_MS } from "./tools/bus_wait";

/**
 * MCP is attach-only by default (never spawns) — set SPACE_BUS_MCP_SPAWN
 * (any truthy value) to opt in to ensure-on-demand, matching the plugin
 * tools' behavior. MCP is single-directory-per-process: directory
 * resolution rides SPACE_BUS_CONFIG alone (no process.cwd() threading).
 */
async function mcpLoadContext(): Promise<ReturnType<typeof loadContext>> {
  if (process.env["SPACE_BUS_MCP_SPAWN"] && isManagedRoster()) {
    const rosterPath = resolveRosterPath();
    await ensureServer(rosterPath);
  }
  return loadContext();
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
    inputSchema: {},
  },
  async () => {
    let context: Awaited<ReturnType<typeof mcpLoadContext>>;
    try {
      // MCP is single-directory-per-process: no per-call directory exists, so
      // resolution rides SPACE_BUS_CONFIG alone. Do not thread process.cwd() in.
      context = await mcpLoadContext();
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const r = await roster({ context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatRoster(r.projects) }] };
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
    let context: Awaited<ReturnType<typeof mcpLoadContext>>;
    try {
      context = await mcpLoadContext();
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const r = await dispatch(dispatchArgs, { context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return {
      content: [{ type: "text", text: formatDispatch(r) }],
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
    },
  },
  async (args) => {
    let context: Awaited<ReturnType<typeof mcpLoadContext>>;
    try {
      context = await mcpLoadContext();
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const r = await status(args.sessionId, { context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatStatus(r) }] };
  },
);

server.registerTool(
  "bus_result",
  {
    description: BUS_RESULT_DESCRIPTION,
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
    },
  },
  async (args) => {
    let context: Awaited<ReturnType<typeof mcpLoadContext>>;
    try {
      context = await mcpLoadContext();
    } catch (e) {
      return {
        content: [{ type: "text", text: (e as Error).message }],
        isError: true,
      };
    }
    const r = await result(args.sessionId, { context });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatResult(r) }] };
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
    },
  },
  async (args) => {
    let context: Awaited<ReturnType<typeof mcpLoadContext>>;
    try {
      context = await mcpLoadContext();
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
    const r = await wait(args.sessionIds, { context, timeoutMs });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatWait(r) }] };
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
