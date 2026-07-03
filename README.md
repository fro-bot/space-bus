# @fro.bot/space-bus

Workspace agent bus for OpenCode. One control agent (an ordinary OpenCode TUI launched in this directory) sees and tasks dedicated agents in each Fro Bot project, over a single `opencode serve` instance using per-request directory routing. A thin stdio MCP facade exposes the same four tools to Claude Desktop.

**Status:** MVP implemented and verified (Phases 0–2). Dogfood as a workspace-local tool first; conversion to a distributable OpenCode plugin comes after.

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

## Quick start

```sh
bun install
harness serve --port 4096    # or: opencode serve --port 4096
opencode                     # from this directory → control agent with bus_* tools
bun run smoke                # canary: directory-routing isolation against the live server
bun run typecheck
```

`@opencode-ai/*` versions are pinned lockstep with the OpenCode CLI (1.17.13). Upgrade both together. Set `OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`) to enable HTTP Basic auth on every bus request.

## Notes from implementation

- The session store is global across directory headers: `GET /session/{id}` resolves regardless of which project directory is sent. The bus attributes a session to its owning project via the session's own `directory` field, not the probe header. `GET /session` (list) and `/session/status` are directory-scoped.
- Upstream opencode #30127 (v1.16.0) zeroes session-level diff summaries, so `GET /session/{id}/diff` always returns `[]`. Per-turn diffs on user messages (`GET /session/{id}/message`) stay intact and include untracked files, so `bus_status`/`bus_result` aggregate those instead (last turn wins per file, à la upstream PR #33444). `GET /vcs/status` remains a last-ditch repo-wide fallback, labeled *working tree*.
- `/session/status` can report a session idle a beat before its final message is queryable; `scripts/smoke.ts` absorbs this with a bounded retry on the message fetch.
- `.opencode/tools/` resolves `@opencode-ai/plugin` from repo-root `node_modules` — no `.opencode/package.json` needed.

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
