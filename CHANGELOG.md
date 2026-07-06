# @fro.bot/space-bus

## 0.7.1

### Patch Changes

- 4b02aae: Fix: managed-server stop now signals the process group so the opencode child spawned by the harness wrapper is torn down too — previously `stop` killed only the wrapper and leaked the child (still holding the port). Readiness-failure and orphan-reap kills cascade to the group as well.

  Hardening: `stopServer` no longer treats an EPERM from the group signal as a successful stop — the server is still alive and its discovery credentials are preserved instead of being discarded. Discovery/lock/provisional pid fields now reject 0/1 (`min(2)`), and `signalGroup` itself refuses to issue a group-form signal for pid<=1, closing off `process.kill(-1, sig)`/`process.kill(-0, sig)` footguns from a tampered or malformed record. The no-identity fallback in `killIdentifiedProcess` (used when identity capture failed) now bare-kills instead of group-signaling, so a recycled pid can't cascade a SIGTERM to an unrelated process's entire subtree.

## 0.7.0

### Minor Changes

- f9f74fa: Add browser-safe managed-server resolver (@fro.bot/space-bus/attach) for external attachers.

## 0.6.1

### Patch Changes

- f338abb: Test isolation: the suite no longer writes managed-server state directories into the real ~/.local/state — tests now run under an isolated XDG_STATE_HOME.

## 0.6.0

### Minor Changes

- c654443: Managed bus server: opt-in `server.managed` roster mode spawns and supervises `harness serve` on first use (generated password, 0600 discovery handshake, persistent daemon, staleness healing). New `space-bus` CLI (serve/status/stop) and `/server` subpath. MCP attach-only unless SPACE_BUS_MCP_SPAWN. Externally-managed `baseUrl` rosters unchanged.

## 0.5.0

### Minor Changes

- 4dfd57c: zod upgraded to v4 (^4.4.3). `/contract` schemas are now zod-4 schemas — consumers on zod 3 must upgrade; passthrough semantics unchanged (`z.looseObject`). MCP raw-shape registration now on the SDK's zod-4 path.

## 0.4.0

### Minor Changes

- 5fda974: bus_task results now carry structured metadata (`{sessionId, project, mode}`) alongside the formatted text — plugin `ToolResult.metadata` / MCP `structuredContent`. Text output unchanged.

## 0.3.0

### Minor Changes

- 83013cd: Library surface: subpath exports `/core`, `/config`, `/contract`, `/format` (experimental — may change in minors). Browser-safe core with injected, boundary-validated context (roster + credentials); `snapshot()` composite for one-call mission-control state. Internal behavior change: config-resolution errors now surface at the adapter boundary before core runs; tool behavior otherwise unchanged.

## 0.2.1

### Patch Changes

- ac6dc8f: Replace the `DispatchArgs` casts in both adapters with a shared `toDispatchArgs` validator, and add an end-to-end test asserting the built `space-bus-mcp` reports the injected package version.

  Observable behavior change: argument-shape errors (missing `project`, empty `sessionId`) now surface before roster/config resolution errors, so a bad-args call on a machine with no roster reports the args problem instead of the config problem.

## 0.2.0

### Minor Changes

- cfe5b46: Tighten `dispatch()` arguments: `DispatchArgs` is now a discriminated union requiring `project` or `sessionId` (bare `{prompt}` is a compile error), with a distinct error for empty-string `sessionId`. The `space-bus-mcp` server reports the real package version, and the generated dev fixture is fully self-contained (placeholder projects, no machine-local paths).

## 0.1.0

### Minor Changes

- 1744b88: Initial distributable release: plugin tool registration, spacebus.json roster discovery, space-bus-mcp bin.
