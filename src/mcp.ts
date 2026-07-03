import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dispatch, result, roster, status } from "./core";
import {
  formatDispatch,
  formatResult,
  formatRoster,
  formatStatus,
} from "./format";
import { BUS_RESULT_DESCRIPTION } from "./tools/bus_result";
import { BUS_ROSTER_DESCRIPTION } from "./tools/bus_roster";
import { BUS_STATUS_DESCRIPTION } from "./tools/bus_status";
import { BUS_TASK_DESCRIPTION } from "./tools/bus_task";

// transitional: removed at Unit 6 cutover — the MCP facade currently has no
// tool-provided workspace directory (unlike the plugin/adapter tool contexts),
// so when SPACE_BUS_CONFIG isn't set we fall back to the repo-root
// spacebus.json relative to this module's own location. Once the package
// ships as a real bin (Unit 6), callers must set SPACE_BUS_CONFIG.
function fallbackDirectory(): string | undefined {
  if (process.env["SPACE_BUS_CONFIG"]) return undefined;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..");
}

const server = new McpServer({
  name: "space-bus",
  version: "0.0.0",
});

server.registerTool(
  "bus_roster",
  {
    description: BUS_ROSTER_DESCRIPTION,
    inputSchema: {},
  },
  async () => {
    const r = await roster({ directory: fallbackDirectory() });
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
  },
  async (args) => {
    const r = await dispatch({ ...args, directory: fallbackDirectory() });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatDispatch(r) }] };
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
    const r = await status(args.sessionId, { directory: fallbackDirectory() });
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
    const r = await result(args.sessionId, { directory: fallbackDirectory() });
    if (!r.ok)
      return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatResult(r) }] };
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
