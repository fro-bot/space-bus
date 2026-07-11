# @fro.bot/space-bus — Plugin Development

This is the source repo for the `@fro.bot/space-bus` OpenCode plugin: five `bus_*` tools that let a control agent task per-project agents over the OpenCode server API, plus a stdio MCP facade for Claude Desktop.

## Project structure

- `src/index.ts` — plugin entry; default-exported factory returning the `tool` map (`bus_roster`, `bus_task`, `bus_status`, `bus_result`, `bus_wait`).
- `src/tools/*.ts` — one file per tool: thin adapter factories (`makeBus*`) plus the shared description constants also consumed by `src/mcp.ts`.
- `src/core.ts` — all bus logic (roster lookups, dispatch, status, result, `snapshot()` composite). Discriminated-union returns, no throwing. Browser-safe: takes an injected `BusContext` (`{ roster, credentials? }`) per call instead of resolving one itself.
- `src/config.ts` — `spacebus.json` roster resolution: `resolveRosterPath`/`getRoster`/`getProjects`, `SPACE_BUS_CONFIG` override, localhost guard. Node-only. `loadContext(directory?)` is the Node-side loader producing a `BusContext` for core.
- `src/contract.ts` — zod schemas + inferred types for the OpenCode API and `BusContext`; zod-only imports, no Node deps. Core imports from contract, never the reverse. Also owns the discovery-file schemas (`discoveryFileSchema`/`managedSpawnConfigSchema`), shared by `discovery.ts` (Node writer) and `attach.ts` (browser-safe reader).
- `src/attach.ts` — browser-safe managed-server resolver: `resolveManagedServer(workspaceDir, seams)` reads the same discovery-file contract as `discovery.ts` through injected filesystem/env/crypto seams, so external attachers (e.g. a Mothership webview) can attach without any node:* imports. The `/attach` subpath export.
- `src/mcp.ts` — stdio MCP facade; also the package `bin` (`space-bus-mcp`) entry. Attach-only by default; spawns for a managed roster only when `SPACE_BUS_MCP_SPAWN` is set.
- `src/discovery.ts` — Node-only: discovery-file read/write/validate, per-roster state-dir resolution, spawn lock primitives, pid identity verification. Imported by both `config.ts` and `server.ts`; must never be imported by core/contract/format.
- `src/server.ts` — Node-only: managed-server lifecycle (`ensureServer`/`serverStatus`/`stopServer`) — spawn, readiness polling, identity-verified stop.
- `src/cli.ts` — Node-only `space-bus` CLI (`serve|status|stop|service`, `--json`); thin wrapper over `server.ts`/`service.ts`. Package `bin` (`space-bus`) entry.
- `src/launchd.ts` — Node-only: launchd plist generation, atomic plist writes, and a thin `launchctl` exec seam (`bootstrap`/`bootout`/`kickstart`/`printJob`). Joins the Node-only lane.
- `src/service.ts` — Node-only: orchestrates the five `space-bus service` verbs (install/uninstall/status/stop/start) on top of `launchd.ts`. Joins the Node-only lane.

## Invariants

- **Two-surface parity:** the plugin's tool map and the MCP registrations must stay byte-identical in descriptions and output — driven from the same factories (`makeBus*`, including `makeBusWait`) and description constants, never duplicated by hand.
- **Never `process.cwd()`:** always use `ctx.directory` (per-call) falling back to `input.directory` (captured at plugin-instance creation). This is what makes directory-routing work on a shared `opencode serve` instance.
- **Stdio discipline:** `src/mcp.ts`'s stdout carries protocol frames only — all diagnostics go to stderr.
- **Localhost guard:** `spacebus.json`'s `server.baseUrl` must resolve to `127.0.0.1`/`::1`/`localhost`; never send bus credentials off-machine.
- **No telemetry, no off-machine calls** from the plugin or MCP facade at runtime.
- **Core never throws across the boundary:** `src/core.ts` functions return discriminated unions (`{ ok: true, ... } | { ok: false, error }`); tool adapters convert `ok:false` to a thrown error (plugin tools) or an `isError` content block (MCP).
- **Browser-safety is CI-enforced:** `src/browser-safety.test.ts` bundles `src/core.ts`, `src/contract.ts`, `src/format.ts`, `src/attach.ts` for a browser target and asserts no `node:*` imports and no path into `src/config.ts` — config stays Node-only by construction. `attach.ts` joins the browser-safe CI-guarded lane (core/contract/format/attach).
- **Context is validated per call:** every exported `core.ts` function validates its injected `BusContext` at a single internal gate on entry (zod parse of a copy, plus the localhost guard) — validate-then-mutate on the caller's object can't bypass it, and errors never carry the context object (credentials stay unprintable).
- **Managed-server lifecycle is Node-only and CI-guarded:** `server.ts`/`discovery.ts`/`cli.ts`/`launchd.ts`/`service.ts` join config's Node-only lane; `browser-safety.test.ts` asserts they're unreachable from the core/contract/format bundle graph, browser-unsafe by construction.
- **Discovery file is locked down:** the discovery file is written 0600 with a freshly generated per-spawn password; never reused across spawns, never in argv, never logged.
- **Localhost guard travels to discovery:** an attached endpoint from the discovery file is re-validated against the loopback guard regardless of source — a tampered discovery file can't bypass it.
- **MCP attach-only by default:** `mcp.ts` never calls `ensureServer` unless `SPACE_BUS_MCP_SPAWN` is set.

## Dev loop

```sh
bun run fixture   # generates gitignored fixtures/dev-workspace/ (opencode.json file-path plugin ref + spacebus.json)
bun run dev        # bun build --watch to dist/
```

Point an OpenCode session at `fixtures/dev-workspace/` to exercise the plugin end-to-end against a live `harness serve`/`opencode serve` instance. `bun run smoke` is a live-server canary (directory-routing isolation) distinct from `bun run test`'s unit tests — the smoke script needs a running server on the roster's `baseUrl` and reads `SPACE_BUS_CONFIG` (defaulting to `fixtures/dev-workspace/spacebus.json`).

`docs/solutions/` — documented solutions to past problems (bugs, integration issues, workflow patterns), organized by category with YAML frontmatter (`module`, `tags`, `problem_type`). Relevant when implementing or debugging in documented areas.
