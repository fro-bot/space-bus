import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dispatch, result, roster, status } from "./core";
import { formatDispatch, formatResult, formatRoster, formatStatus } from "./format";

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
    description: "List the space-bus manifest projects with live session status per project.",
    inputSchema: {},
  },
  async () => {
    const r = await roster({ directory: fallbackDirectory() });
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatRoster(r.projects) }] };
  },
);

server.registerTool(
  "bus_task",
  {
    description:
      "Dispatch a prompt to an agent in the given space-bus manifest project, or steer an existing session by passing sessionId (answers its pending question, else sends a follow-up prompt). Returns immediately; does not wait for completion.",
    inputSchema: {
      project: z
        .string()
        .optional()
        .describe("Manifest project name, e.g. dashboard, agent, control-plane, infra. Required when starting a new session."),
      prompt: z.string().describe("The prompt to send to the delegated agent"),
      title: z.string().optional().describe("Optional session title (only used when starting a new session)"),
      sessionId: z.string().optional().describe("Existing session ID to steer instead of starting a new session"),
    },
  },
  async (args) => {
    const r = await dispatch({ ...args, directory: fallbackDirectory() });
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatDispatch(r) }] };
  },
);

server.registerTool(
  "bus_status",
  {
    description:
      "Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.",
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
    },
  },
  async (args) => {
    const r = await status(args.sessionId, { directory: fallbackDirectory() });
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatStatus(r) }] };
  },
);

server.registerTool(
  "bus_result",
  {
    description:
      "Return a completed space-bus session's final assistant message and diff. Errors if the session is still running — use bus_status to check first.",
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
    },
  },
  async (args) => {
    const r = await result(args.sessionId, { directory: fallbackDirectory() });
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
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
