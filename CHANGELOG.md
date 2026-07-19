# @fro.bot/space-bus

## 0.15.0

### Minor Changes

- fe0cc42: `@fro.bot/space-bus/core` gains a browser-safe message-correlation primitive for dispatched prompts, plus typed partial-failure handles for dispatch:

  - `createDispatchMessageId()` — generates an OpenCode-compatible ascending user message id (`msg_` + a 12-character lowercase-hex timestamp/counter prefix + 14 random base62 characters), using only `Date.now()` and Web Crypto's `crypto.getRandomValues` — no Node builtins, no dependency. IDs generated in the same millisecond sort ascending by an internal per-millisecond counter, matching OpenCode's own id ordering.
  - `dispatch()`/`toDispatchArgs()` accept an optional `messageId` on `DispatchArgs`. `toDispatchArgs` validates a caller-supplied id against the exact `msg_` + 12-hex + 14-alphanumeric shape and rejects anything else — including oversized or injection-like input — with a single stable, generic `Result` error that never echoes the rejected value. `dispatch()` re-validates independently as defense in depth for callers that construct `DispatchArgs` directly.
  - When `messageId` is supplied, `new` and `follow-up` dispatch modes include it as the OpenCode `messageID` field alongside the prompt's `parts` and echo it back as `messageId` on the result. The key is omitted entirely — not sent as `null` — whenever no `messageId` is given, and `blocked`/`question-reply` results never carry a `messageId` since no ordinary prompt message is sent on those branches.
  - New `DispatchFailure` type and optional `dispatchFailure` field on dispatch's `Result` error branch give callers a typed handle for partial failures: `phase: "not_sent"` for failures verified to precede any mutation (e.g. pending-question verification failing under the `blocked` policy), and `phase: "indeterminate"` for failures where a mutating request (session create, prompt send, question reply) may already have reached OpenCode despite an error response. Known-safe fields (`project`, and `sessionId`/`messageId` when known) are included; unknown fields are omitted rather than sent as `undefined`. Every other core function's `Result` error shape is unchanged.
  - `dispatchMetadata()` (shared by the MCP and plugin tool surfaces) and the `bus_task` MCP tool's `outputSchema` gain the same optional `messageId`, included for `new`/`follow-up` when supplied and omitted otherwise. `bus_task`'s plugin and MCP `messageId` input parameter is optional and validated the same way as `dispatch()`. Human-readable dispatch text output is unchanged.

  All additions preserve the existing `Result<T>`/`DispatchResult` contract and the browser-safe `/core` import lane.

## 0.14.0

### Minor Changes

- 8802338: Add browser-safe session-content primitives to `@fro.bot/space-bus/core` so consumers (e.g. Mothership's `ide_*` MCP surface) don't need to duplicate OpenCode message/question HTTP behavior:

  - `messages(sessionId, { context, limit? })` — bounded full-message read. Resolves session ownership from the roster (never a caller-supplied directory) and returns `{ sessionId, project, messages: [{ id?, role, createdAt?, parts }] }` — stable message identity/ordering metadata plus parsed parts, no unknown envelope fields. `limit` defaults to 20 and is capped at a hard maximum of 200; `0`, negative, fractional, `NaN`, and `Infinity` values are rejected before any fetch.
  - `questions(target, { context })` — complete project- or session-scoped pending-question read (`target: { project } | { sessionId }`, exactly one — both-present or neither-present is rejected before any fetch). Returns one entry per pending request with its **full nested subquestion list** (`requestId`, `sessionId`, `questions: [{ header?, question, multiple, custom, options: [{ label, description? }] }]`) — a single request can carry more than one subquestion, and every subquestion's header/question/multiple/custom/options round-trips.
  - `answerQuestion({ sessionId, requestId, answers }, { context })` — explicit question answer. Runtime-validates `answers` is a non-empty `string[][]` before any fetch, verifies `requestId` belongs to a pending question on `sessionId` (a `requestId` for a different session is refused with no mutation), and verifies `answers.length` matches that request's subquestion count before sending (mismatched cardinality is refused with no mutation).
  - `dispatch()` gains an optional, backward-compatible `args.onPendingQuestion: "question-reply" | "blocked"`, validated and preserved by `toDispatchArgs` (invalid values are rejected). The default preserves 0.13.1's fail-open question-reply behavior for existing callers, including its behavior when `/question` is unreadable. `"blocked"` is fail-closed: it returns a typed `{ mode: "blocked", requestId }` result with no reply and no follow-up prompt when a question is pending, and returns a stable `Result` error — instead of guessing — when pending-question state can't be verified (a non-2xx or unparseable `GET /question` response), for callers that must never silently reinterpret a follow-up prompt as a question answer or dispatch under ambiguous state.

  All additions preserve the existing `Result<T>`/`BusContext` contract, the per-call context validation gate, the localhost guard, internal session-to-directory resolution, and the browser-safe `/core` import lane (no Node builtins, no ambient env reads).

### Patch Changes

- f599505: Fix the CLI's `--config` flag leaking into `process.env.SPACE_BUS_CONFIG`. `resolveRoster()` in `src/cli.ts` previously mutated the process environment as a side effect of resolving an explicit `--config` path, which persisted for the remainder of the process and could cause later ambient (env-based) roster resolution in the same process to resolve a stale/deleted path. `resolveRosterPath()` in `src/config.ts` now accepts an optional explicit override argument, so the CLI can thread `--config` through without touching `process.env`.

## 0.13.1

### Patch Changes

- b35b839: Fix `bus_registry` MCP tool responses: every successful action now returns `structuredContent` (`{ rosters: [...] }` for `list`, `{}` for all other actions), matching the tool's declared output schema. Previously, non-`list` actions (`register`, `create`, `unregister`, `set-default`, `use`, `add-project`, `remove-project`, `update-project`) omitted `structuredContent`, causing MCP clients to reject the response with error -32602 even though the underlying mutation had already succeeded.

## 0.13.0

### Minor Changes

- 7444781: Per-call roster addressing and the `bus_registry` management tool (multi-roster Phase B).

  All five `bus_*` tools accept an optional `roster` parameter (a registry name from `@fro.bot/space-bus/registry`) to target any registered roster instead of the ambient workspace/`SPACE_BUS_CONFIG` resolution — and every tool result now opens with a `roster:` header naming the roster it resolved, on both success AND error results — so cross-roster calls (and cross-roster errors) are always visible. A sixth tool, `bus_registry`, manages the machine's roster registry from both surfaces: list rosters, create a roster in-app, register/unregister/set-default, and add/remove/update roster projects. On the MCP surface, `bus_registry use` selects a session-active roster (ephemeral, per connection) that omitted-`roster` calls resolve to; unregistering the active roster clears the session's selection (falls back to ambient resolution). When `SPACE_BUS_CONFIG` is unset, MCP ambient resolution now also falls back to the registry default (`bus_registry set-default`) before erroring — `set-default` gains a new routing role beyond bookkeeping. Plugin calls remain workspace-directory-first.

  Note: every tool's text output now begins with a `roster:` line — consumers parsing raw tool text must account for the new first line (structured `bus_task` metadata is unchanged).

## 0.12.0

### Minor Changes

- 9897976: Multi-roster substrate: roster registry + mutation library on a new `/registry` subpath.

  - **Roster registry** — a per-user, machine-level registry (`$XDG_CONFIG_HOME/space-bus/rosters.json`, else `~/.config/space-bus/rosters.json`) mapping human-readable names to roster paths: `readRegistry`, `registerRoster`, `unregisterRoster`, `setDefaultRoster`, `resolveRosterByName`. Names are validated (`[a-z0-9-]`, case-insensitive-unique), paths are canonicalized with symlinked entries rejected, and the registry never stores credentials. The registry is additive and optional — `SPACE_BUS_CONFIG` and `<directory>/spacebus.json` resolution are unchanged.
  - **Roster mutation** — programmatic `spacebus.json` editing: `createRoster` (write + register in one op), `addProject`, `removeProject`, `updateProject`, `editServer`. Every edit is read-validate-mutate-validate-write with atomic replacement; an invalid edit (schema violation or non-loopback `baseUrl`) leaves the file byte-identical and returns `ok:false`.
  - **Discovery `rosterPath`** — managed-daemon discovery files now record their roster path at spawn (optional field; pre-field files parse unchanged), enabling future reconciliation to name which roster a running daemon belongs to.

  Node-only surface (`import ... from "@fro.bot/space-bus/registry"`); the browser-safe lanes (`/core`, `/contract`, `/format`, `/attach`) are unchanged. Tool surfaces are unchanged — per-call roster addressing ships in a follow-up release.

## 0.11.0

### Minor Changes

- e1718a5: Add `space-bus service install|uninstall|status|stop|start` — generates a per-user launchd agent wrapping `serve --foreground` so a roster's managed daemon survives reboots and crashes. macOS v1 (fails fast on other platforms); restart-on-abnormal-exit with a 10s throttle; idempotent reinstall; full uninstall reversal.

## 0.10.1

### Patch Changes

- d3b2631: Fix browser-safe subpath artifacts (`./core`, `./contract`, `./format`) shipping a Node-only `createRequire`/`node:module` prelude that broke Vite/browser bundling (e.g. Mothership). These entrypoints are now built with a browser-targeted Bun.build call, matching `./attach`. Added a dist-level browser-safety test asserting the published artifacts contain no `node:` imports, closing the gap where the existing src-level browser-safety test passed while the published dist was broken.

## 0.10.0

### Minor Changes

- 2cb9245: Remap the `./server` subpath to the plugin entry: OpenCode's plugin loader resolves `exports["./server"]` before `main`, so the managed-server lifecycle API published there broke plugin loading with `Plugin export is not a function` (affects 0.6.0–0.9.0 when loaded from npm). The lifecycle API (`ensureServer`, `serverStatus`, `stopServer`, `superviseServer`, …) moves to `@fro.bot/space-bus/managed-server`.

  **Migration:** direct importers of `@fro.bot/space-bus/server` must switch to `@fro.bot/space-bus/managed-server` before upgrading — after this release, `/server` resolves to the plugin factory and the old lifecycle imports fail silently (missing properties), not with an error.

## 0.9.0

### Minor Changes

- 6e57bff: Add asynchronous-delegation foundation: a normalized session-state enum and the `bus_wait` tool.

  - **Normalized state enum** (`running | blocked | complete | failed | not_found`) plus a `resultAvailable` signal, derived once in core (`deriveSessionState`) and emitted identically by `bus_status`, the library `snapshot()`, and `bus_wait` — callers no longer infer state from `busy`/`blocked`. Exported on the `/core` and `/contract` subpaths (`SessionState`, `SessionStateInfo`).
  - **`bus_wait`** (fifth tool, both plugin and MCP surfaces): blocks until any watched session needs attention (completes, blocks on a question, fails, or is not found) or a bounded timeout elapses, then returns each session's normalized state plus which session(s) woke the wait. Level-triggered, stateless (a bounded long-poll within the single call), watches sessions across directories, and never throws across the boundary. Replaces the poll-`bus_status`-in-a-loop pattern with one call that makes progress.

  Fire-and-forget push notification (get notified as tasks complete without holding a call open) is a deferred follow-on — this release delivers the blocking-wait foundation and the shared state contract it builds on.

## 0.8.1

### Patch Changes

- fb5bc47: Fix: `space-bus serve --foreground` now reaps a surviving daemon child on the supervision death path. The managed daemon is a `harness` wrapper plus an `opencode` child in the same process group; when the wrapper died but the child survived, the supervisor exited fail-closed without signaling the group, leaving the child orphaned and holding its port. The death path now group-signals the surviving members before exiting, guarded so it never signals a process that recycled the wrapper pid (it fires only when the leader is dead and its group is still alive, which cannot be a recycled pgid).
- 930d698: Fix: `stopServer` now reaps a surviving orphaned child when the recorded managed wrapper has already died (identity verification fails). Previously this branch cleaned up the discovery record but never reaped the process group, leaking the wrapper's `opencode` child (still holding its port) whenever the wrapper died alone before a stop was requested. This brings the dead-wrapper branch to parity with the existing supervision died-path reap, reusing the same guarded `reapSurvivingGroup` (no-op for a live/recycled leader; no-op if the whole group is already dead). `stopServer`'s return value is unchanged (`stopped: false`) — reaping an orphan is best-effort cleanup, not a verified stop.

## 0.8.0

### Minor Changes

- 869a003: Add active supervision to `space-bus serve --foreground`. The foreground process now polls the managed daemon's liveness (process identity plus an authenticated endpoint probe with a consecutive-failure grace threshold) instead of only waiting for its own signals. On confirmed daemon death — the process is gone, it fails a run of consecutive probes, or it stays unhealthy (unreachable or auth-failing) past an absolute-lifetime budget — the supervisor cleans up the discovery record and exits non-zero so an external process manager (launchd/systemd `Restart=on-failure`) can restart `space-bus serve`. A clean SIGINT/SIGTERM interrupts the poll immediately, stops the daemon, and exits zero. Recovery-by-restart is delegated to the OS process manager; the daemon is never restarted in-process.

### Patch Changes

- d85b7d3: Fix: Node-side resolvers now clean up stale managed-daemon discovery records. When a managed daemon dies by crash or host-process exit (not an explicit `stop`), its `discovery.json` was left pointing at a dead pid, so attachers kept dialing a dead port. Resolvers now remove the stale record on a dead-pid read, via compare-and-delete so a concurrent respawn's fresh record is preserved.

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
