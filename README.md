# @fro.bot/space-bus

Workspace agent bus for OpenCode. One control agent (an ordinary OpenCode TUI launched in this directory) sees and tasks dedicated agents in each Fro Bot project, over a single `opencode serve` instance using per-request directory routing. A thin stdio MCP facade exposes the same four tools to Claude Desktop.

**Status:** MVP scaffold — implementation happens per `HANDOFF.md`. Dogfood as a workspace-local tool first; conversion to a distributable OpenCode plugin comes after.

## How it works

```
Claude Desktop ──stdio MCP──▶ src/mcp.ts ──┐
                                           ├──▶ src/core.ts ──HTTP──▶ opencode serve :4096
OpenCode TUI (here) ──.opencode/tools/ ────┘                          │ x-opencode-directory
                                                                      ▼
                                              agent · dashboard · control-plane · infra
```

Four tools, no broker: `bus_roster`, `bus_task`, `bus_status`, `bus_result`. The OpenCode server API is the state store.

## Layout

- `workspace.json` — project manifest (paths assume repos under `~/src/github.com/`; edit to taste)
- `AGENTS.md` — control-agent delegation policy
- `src/core.ts` — manifest parsing + typed OpenCode API calls (all real logic lives here)
- `.opencode/tools/` — OpenCode custom-tool adapters
- `src/mcp.ts` — MCP stdio adapter for Claude Desktop
- `scripts/smoke.ts` — Phase 0 spike, kept as canary
- `docs/brainstorms/` — requirements (systematic ce-brainstorm format)

## Quick start (once built)

```sh
bun install
opencode serve --port 4096   # from anywhere
opencode                     # from this directory → control agent with bus_* tools
```

`@opencode-ai/*` versions are pinned lockstep with the OpenCode CLI (1.17.13). Upgrade both together.

## Claude Desktop

Add `src/mcp.ts` as a stdio MCP server in Claude Desktop's config:

```json
{
  "mcpServers": {
    "space-bus": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/space-bus/src/mcp.ts"]
    }
  }
}
```

The path must be absolute — Claude Desktop launches the server with no cwd context. `opencode serve`/`harness serve` must already be running on `127.0.0.1:4096`.
