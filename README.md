# @fro.bot/space-bus

Workspace agent bus for OpenCode. A control agent — an ordinary OpenCode TUI running with this plugin installed — tasks dedicated agents in each project on your roster over a single `opencode serve`/`harness serve` instance, using per-request directory routing. A thin stdio MCP facade exposes the same tools to Claude Desktop.

## Install

```json
{
  "plugin": ["@fro.bot/space-bus"]
}
```

For local development, reference the checkout by file path instead:

```json
{
  "plugin": ["/absolute/path/to/space-bus"]
}
```

## Configure

Space Bus reads a `spacebus.json` roster from the workspace directory (the directory OpenCode was launched in):

```json
{
  "server": {
    "baseUrl": "http://127.0.0.1:4096"
  },
  "projects": [
    {
      "name": "agent",
      "path": "~/src/github.com/fro-bot/agent",
      "description": "Fro Bot agent runtime + gateway + Discord integration"
    }
  ]
}
```

`server.baseUrl` must point to localhost (`127.0.0.1`, `::1`, or `localhost`) — non-local hosts are refused so bus credentials never leave the machine. Project `path` entries support `~` expansion.

Set `SPACE_BUS_CONFIG` to an absolute or `~`-prefixed path to override roster discovery (URLs and bare-relative paths are rejected). The roster is read fresh on every tool call — no caching, so edits apply immediately.

## Tools

- `bus_roster` — List the space-bus manifest projects with live session status per project.
- `bus_task` — Dispatch a prompt to an agent in the given space-bus manifest project, or steer an existing session by passing `sessionId` (answers its pending question, else sends a follow-up prompt). Returns immediately; does not wait for completion.
- `bus_status` — Report a space-bus session's status plus a summary of its latest todo and diff. Also reports when the session is blocked on an interactive question awaiting a reply.
- `bus_result` — Return a completed space-bus session's final assistant message and diff. Errors if the session is still running — use `bus_status` to check first.

## Claude Desktop

```json
{
  "mcpServers": {
    "space-bus": {
      "command": "bunx",
      "args": ["--package=@fro.bot/space-bus", "space-bus-mcp"],
      "env": {
        "SPACE_BUS_CONFIG": "/absolute/path/to/spacebus.json"
      }
    }
  }
}
```

Requires `opencode serve`/`harness serve` already running on the roster's `baseUrl`.

## Development

```sh
bun install
bun run fixture       # generates gitignored fixtures/dev-workspace/ (opencode.json + spacebus.json)
harness serve --port 4096 &    # or: opencode serve --port 4096
opencode --dir fixtures/dev-workspace   # or open that directory directly
bun run smoke          # canary: directory-routing isolation against the live server
bun run test
bun run typecheck
bun run lint
bun run dev             # watch build to dist/
```

`@opencode-ai/*` versions are pinned lockstep with the OpenCode CLI (1.17.13). Upgrade both together. Set `OPENCODE_SERVER_PASSWORD` (and optionally `OPENCODE_SERVER_USERNAME`) to enable HTTP Basic auth on every bus request.

## Notes from implementation

- The session store is global across directory headers: `GET /session/{id}` resolves regardless of which project directory is sent. The bus attributes a session to its owning project via the session's own `directory` field, not the probe header. `GET /session` (list) and `/session/status` are directory-scoped.
- Upstream opencode #30127 (v1.16.0) zeroes session-level diff summaries, so `GET /session/{id}/diff` always returns `[]`. Per-turn diffs on user messages (`GET /session/{id}/message`) stay intact and include untracked files, so `bus_status`/`bus_result` aggregate those instead (last turn wins per file, à la upstream PR #33444). Harness builds ≥`1.17.13+harness.ee55e157` carry #33444 directly, so `GET /session/{id}`'s `summary.diffs` field is populated and serves diffs without per-turn aggregation (still labeled `diffSource: "session"`); stock binaries leave it empty and fall through to per-turn aggregation. `GET /vcs/status` remains a last-ditch repo-wide fallback, labeled *working tree*.
- `/session/status` can report a session idle a beat before its final message is queryable; `scripts/smoke.ts` absorbs this with a bounded retry on the message fetch.
- Dogfooding surfaced a need for a steering path that isn't raw API — delegates block on interactive questions. That steering path ended up as an optional `sessionId` on `bus_task` rather than a fifth tool: passing it answers a pending question or sends a follow-up prompt on an existing session. `bus_status` also surfaces pending interactive questions (`pendingQuestion` / a `blocked:` line) so a blocked delegate isn't mistaken for one actively working.

## Releasing

PRs land a changeset via `bunx changeset`. On merge to `main`, CI opens a version PR; merging that PR publishes to npm through trusted publishing (OIDC) — no `NPM_TOKEN` involved.
