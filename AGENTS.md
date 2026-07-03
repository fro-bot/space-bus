# @fro.bot/space-bus — Plugin Development

This is the source repo for the `@fro.bot/space-bus` OpenCode plugin: four `bus_*` tools that let a control agent task per-project agents over the OpenCode server API, plus a stdio MCP facade for Claude Desktop.

## Project structure

- `src/index.ts` — plugin entry; default-exported factory returning the `tool` map (`bus_roster`, `bus_task`, `bus_status`, `bus_result`).
- `src/tools/*.ts` — one file per tool: thin adapter factories (`makeBus*`) plus the shared description constants also consumed by `src/mcp.ts`.
- `src/core.ts` — all bus logic (roster lookups, dispatch, status, result). Discriminated-union returns, no throwing.
- `src/config.ts` — `spacebus.json` roster resolution: `resolveRosterPath`/`getRoster`/`getProjects`, `SPACE_BUS_CONFIG` override, localhost guard.
- `src/mcp.ts` — stdio MCP facade; also the package `bin` (`space-bus-mcp`) entry.

## Invariants

- **Two-surface parity:** the plugin's tool map and the MCP registrations must stay byte-identical in descriptions and output — driven from the same factories (`makeBus*`) and description constants, never duplicated by hand.
- **Never `process.cwd()`:** always use `ctx.directory` (per-call) falling back to `input.directory` (captured at plugin-instance creation). This is what makes directory-routing work on a shared `opencode serve` instance.
- **Stdio discipline:** `src/mcp.ts`'s stdout carries protocol frames only — all diagnostics go to stderr.
- **Localhost guard:** `spacebus.json`'s `server.baseUrl` must resolve to `127.0.0.1`/`::1`/`localhost`; never send bus credentials off-machine.
- **No telemetry, no off-machine calls** from the plugin or MCP facade at runtime.
- **Core never throws across the boundary:** `src/core.ts` functions return discriminated unions (`{ ok: true, ... } | { ok: false, error }`); tool adapters convert `ok:false` to a thrown error (plugin tools) or an `isError` content block (MCP).

## Dev loop

```sh
bun run fixture   # generates gitignored fixtures/dev-workspace/ (opencode.json file-path plugin ref + spacebus.json)
bun run dev        # bun build --watch to dist/
```

Point an OpenCode session at `fixtures/dev-workspace/` to exercise the plugin end-to-end against a live `harness serve`/`opencode serve` instance. `bun run smoke` is a live-server canary (directory-routing isolation) distinct from `bun run test`'s unit tests — the smoke script needs a running server on the roster's `baseUrl` and reads `SPACE_BUS_CONFIG` (defaulting to `fixtures/dev-workspace/spacebus.json`).

`docs/solutions/` — documented solutions to past problems (bugs, integration issues, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
