import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dispatch, reply, result, roster, status } from "./core";
import { formatDispatch, formatReply, formatResult, formatRoster, formatStatus } from "./format";

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
    const r = await roster();
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatRoster(r.projects) }] };
  },
);

server.registerTool(
  "bus_task",
  {
    description:
      "Dispatch a prompt to an agent in the given space-bus manifest project. Returns immediately with a session ID; does not wait for completion.",
    inputSchema: {
      project: z.string().describe("Manifest project name, e.g. dashboard, agent, control-plane, infra"),
      prompt: z.string().describe("The prompt to send to the delegated agent"),
      title: z.string().optional().describe("Optional session title"),
    },
  },
  async (args) => {
    const r = await dispatch(args.project, args.prompt, args.title);
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatDispatch(r.sessionId, r.project) }] };
  },
);

server.registerTool(
  "bus_status",
  {
    description: "Report a space-bus session's status plus a summary of its latest todo and diff.",
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
    },
  },
  async (args) => {
    const r = await status(args.sessionId);
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatStatus(r) }] };
  },
);

server.registerTool(
  "bus_result",
  {
    description: "Return a completed space-bus session's final assistant message and diff.",
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
    },
  },
  async (args) => {
    const r = await result(args.sessionId);
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatResult(r) }] };
  },
);

server.registerTool(
  "bus_reply",
  {
    description:
      "Answer a delegated session's pending question, or send it a follow-up prompt. Steers an existing space-bus session without creating a new one.",
    inputSchema: {
      sessionId: z.string().describe("Session ID returned by bus_task"),
      message: z.string().describe("The answer or follow-up message to send"),
    },
  },
  async (args) => {
    const r = await reply(args.sessionId, args.message);
    if (!r.ok) return { content: [{ type: "text", text: r.error }], isError: true };
    return { content: [{ type: "text", text: formatReply(r) }] };
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
