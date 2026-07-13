import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Regression: a tool with an outputSchema must return structuredContent on
// every successful response, or the MCP SDK rejects it with -32602 (see
// server/mcp.js's validateToolOutput) — even though the underlying mutation
// already succeeded. Uses a real Client<->McpServer round-trip over
// InMemoryTransport, not a unit call into the handler.

let configHome: string;
let scratchDir: string;
const ORIGINAL_XDG_CONFIG_HOME = process.env["XDG_CONFIG_HOME"];

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "space-bus-mcp-structured-config-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
  scratchDir = mkdtempSync(join(tmpdir(), "space-bus-mcp-structured-scratch-"));
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  rmSync(scratchDir, { recursive: true, force: true });
  if (ORIGINAL_XDG_CONFIG_HOME === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG_CONFIG_HOME;
  }
});

function rosterPath(): string {
  const path = join(scratchDir, "spacebus.json");
  writeFileSync(
    path,
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [],
    }),
  );
  return path;
}

async function connectedClient(
  server: McpServer,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return {
    client,
    cleanup: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("bus_registry MCP structured-content regression", () => {
  test("register succeeds with structuredContent {}, and a follow-up list reflects the mutation", async () => {
    const { server } = await import("./mcp");
    const { client, cleanup } = await connectedClient(server);
    try {
      const path = rosterPath();
      const registerResult = await client.callTool({
        name: "bus_registry",
        arguments: { action: "register", name: "structured-content-fix", path },
      });
      expect(registerResult.isError).not.toBe(true);
      expect(registerResult.structuredContent).toEqual({});

      const listResult = await client.callTool({
        name: "bus_registry",
        arguments: { action: "list" },
      });
      expect(listResult.isError).not.toBe(true);
      const rosters = (
        listResult.structuredContent as {
          rosters?: Array<{ name: string; path: string }>;
        }
      ).rosters;
      const entry = rosters?.find((r) => r.name === "structured-content-fix");
      expect(entry).toBeDefined();
      expect(entry?.path.endsWith("spacebus.json")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("negative control: omitting structuredContent for a tool with an outputSchema is rejected by the SDK with -32602", async () => {
    const controlServer = new McpServer({
      name: "control-omit",
      version: "0.0.0",
    });
    controlServer.registerTool(
      "control_tool_omit",
      {
        description: "omits structuredContent, mirroring the bug",
        inputSchema: { action: z.string() },
        outputSchema: {
          rosters: z.array(z.object({ name: z.string() })).optional(),
        },
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    const { client, cleanup } = await connectedClient(controlServer);
    try {
      const result = await client.callTool({
        name: "control_tool_omit",
        arguments: { action: "register" },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
      expect(text).toContain("-32602");
    } finally {
      await cleanup();
    }
  });
});
