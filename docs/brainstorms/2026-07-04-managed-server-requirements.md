---
date: 2026-07-04
topic: managed-server
---

# Managed Bus Server

## Summary

Move `harness serve` lifecycle management into the plugin: for managed rosters, the first caller spawns the server with a generated secret recorded in a 0600 discovery file, and every other consumer attaches through that file. Rosters pinning a fixed `baseUrl` stay externally-managed — attach-only, exactly today's behavior. Exposed as a `/server` library subpath plus a thin `space-bus` CLI, modeled on opencode-copilot-delegate's runtime layer.

---

## Problem Frame

The bus server is a manual prerequisite the operator owns: `harness serve` must be started by hand, from the right directory, with `OPENCODE_SERVER_PASSWORD` exported — none of which is enforced or discoverable. When it isn't running, every consumer fails with a bare connection error; when it's started wrong (wrong cwd, no password — both observed in this session), the failure is silent and worse: an **unsecured server on a well-known port that any local process can drive** by guessing :4096. Mothership is about to become a second machine-facing consumer, multiplying both the "who starts it" confusion and the exposure window.

---

## Actors

- A1. Operator (Marcus): starts OpenCode sessions, expects the bus to be there; explicitly stops it when needed.
- A2. Bus tools (plugin + MCP facade): today fail when the server is down.
- A3. Mothership (Rust sidecar / Node side): needs programmatic ensure/attach/status.
- A4. Scripts and shells (smoke, launchd, debugging): need a human-usable entry point.
- A5. Rogue local processes: the adversary the handshake secret excludes.

---

## Key Flows

- F1. First use spawns
  - **Trigger:** Any consumer needs the bus (tool call, `ensureServer()`, CLI `serve`).
  - **Actors:** A1–A4
  - **Steps:** read discovery file → absent or stale (dead pid) → acquire single-owner spawn lock → generate random password → spawn the configured server command from the workspace directory with the secret in its env → wait for readiness → write discovery file `{port, pid, password, ...}` (0600, temp-file swap) → release lock → proceed with the original call.
  - **Outcome:** a secured server is running; the caller's original operation completes.
  - **Covered by:** R1, R2, R4, R5, R6

- F2. Subsequent callers attach
  - **Trigger:** Any consumer needs the bus while the discovery file names a live server.
  - **Actors:** A2–A4
  - **Steps:** read discovery file → verify liveness (pid + health probe) → use `{port, password}` for the call.
  - **Outcome:** no second server; all consumers share one bus.
  - **Covered by:** R2, R3

- F3. Staleness heals
  - **Trigger:** Discovery file names a dead pid (crash, SIGKILL, reboot).
  - **Actors:** A2–A4
  - **Steps:** liveness check fails → clean up stale file → F1 spawn path.
  - **Outcome:** next caller gets a fresh server; no manual repair.
  - **Covered by:** R4, R7

- F4. Explicit stop
  - **Trigger:** Operator runs `space-bus stop` (or a consumer calls `stop()`).
  - **Actors:** A1, A3
  - **Steps:** read discovery file → signal the server process → remove the discovery file.
  - **Outcome:** the bus is down deliberately; nothing respawns it until the next ensure.
  - **Covered by:** R7, R8

---

## Requirements

**Lifecycle**

- R1. The managed layer spawns the server lazily on first need (ensure-on-demand); nothing spawns at plugin load.
- R2. Ensure is race-safe: concurrent first callers resolve to exactly one spawn (single-owner lock; losers wait and attach). The lock itself has bounded staleness recovery — a spawner that dies mid-spawn cannot wedge ensure for subsequent callers (mechanism to planning; the bound is a requirement).
- R3. The managed server is a persistent shared daemon: it outlives the consumer that spawned it and is never torn down implicitly.
- R4. Liveness is verified on every attach (consumers re-read the discovery file per attach; no caching of discovered endpoints across attaches); a stale discovery file is cleaned up and triggers a respawn on the next ensure. No crash supervision — the next caller heals.
- R4b. Process identity, not bare pid: the discovery file records identity beyond pid (e.g. process start time); staleness checks and any signal sent verify identity first — a recycled pid is never killed.
- R5. Spawn is configured by an optional `server.managed` roster block: command (default `harness serve`), cwd (default: the roster file's own directory), port (default: ephemeral — `serve --port` defaults to 0 natively). Schema change: `server.baseUrl` becomes optional; exactly one of `baseUrl` (externally-managed: attach-only, ensure is a pass-through, never spawns) or `managed` (discovery file is the source of truth) must be present. Existing rosters parse unchanged.
- R5b. Roster edits take effect on the next spawn: a running managed server wins until explicitly stopped or reaped; `status` surfaces config drift between the discovery file's recorded spawn config and the current roster.
- R5c. Readiness is a bounded wait (probe until the readiness signal, hard timeout budget); on timeout the spawn is killed, the lock released, and the caller gets an actionable error — no indefinite hangs inside a tool call.

**Security**

- R6. Every managed spawn generates a fresh random password, passed to the child via env — never argv, never written to any log; any surfaced log tail is redacted against the live secret. The discovery file `{port, pid, identity, password, spawnConfig}` is 0600 (0700 dir, temp-file-swap writes) under the user's state directory. Consumers authenticate every call with the discovered secret.
- R6b. Discovered endpoints pass the same loopback guard as roster endpoints before any credential is sent — a tampered discovery file pointing off-machine is refused (the guard travels here too).
- R7. Discovery-file hygiene: stale files are removed, never trusted; the file is the only handshake — no fallback to unauthenticated attach. Managed servers always run with the password enforced; the layer refuses to write a discovery file for an unsecured spawn.
- R7b. Stop authorization is OS-level: `stop()` signals the verified pid (same-user permission), not an API call — possession of the password grants bus API access, not lifecycle control beyond what the OS already grants.

**Surfaces**

- R8. A `/server` library subpath (Node-only, joining config's lane) exports the lifecycle: ensure/attach/status/stop and credential access for direct-API consumers.
- R9. A `space-bus` CLI bin wraps the same functions, thin: `serve` (ensure, foreground option), `status`, `stop` — `--json` for programs, terse text for humans. Credential access stays library-only.
- R10. The plugin tools route through ensure: a tool call against a down managed bus starts it instead of failing. The MCP facade defaults to attach-only (a desktop assistant must not spawn long-lived children implicitly); spawn via the facade is explicit env opt-in. Failure to spawn returns an actionable error naming the command, cwd, and log location.
- R11. All existing consumers keep working: a roster pinning `baseUrl` (externally-managed) behaves exactly as today, credentials from env.

**Observability**

- R12. The managed server's stdout/stderr land in a log file discoverable via `status`; spawn failures surface a redacted log tail in the error (this serves R10's actionability — no rotation/retention machinery).

**Testability**

- R13. The managed lifecycle is testable without the harness binary: spawn/lock/staleness/identity tests run against a stub server command; the smoke fixture stays externally-managed (fixed `baseUrl`), unchanged in CI.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R10.** Given no server and two consumers calling bus tools concurrently, when both ensure, exactly one server spawns and both calls complete against it.
- AE2. **Covers R4.** Given a discovery file whose pid is dead, when any consumer ensures, the stale file is removed, a fresh server spawns, and the file is rewritten.
- AE3. **Covers R6.** Given a managed server, when a process without the discovery file's password calls the port, the server rejects it (401); with the discovered password, calls succeed.
- AE4. **Covers R5, R11.** Given a roster with a fixed `baseUrl` and no managed block, when tools run, no spawn is ever attempted and behavior matches today's (env credentials).
- AE5. **Covers R8, R9.** Given the published package, when Mothership imports `/server` and a shell runs `space-bus status --json`, both see the same `{running, port, pid}` truth from the same discovery state.
- AE6. **Covers R3, R7.** Given the operator's OpenCode session exits after its tool call spawned the bus, when a second consumer attaches later, the server is still running and `space-bus stop` is what ends it.

---

## Success Criteria

- The operator never manually starts `harness serve` again: opening any consumer cold and delegating just works.
- The port-guessing hole is closed: every managed server requires the generated secret; an unsecured bus can no longer exist by accident.
- Mothership's sidecar manages bus availability through published package APIs, zero process code of its own.
- A downstream planner can produce the implementation plan from this doc without inventing lifecycle, security, or surface behavior.

---

## Scope Boundaries

- No crash supervision or auto-restart; no refcounted teardown (tracked for post-stable revisit alongside the lazy-vs-eager and password-vs-socket trade-offs).
- No upstream changes to opencode/harness (unix sockets, serve-side ACLs).
- Same-user compromise is out of scope: the boundary is the OS session (matches opencode-copilot-delegate's trust model).
- No multi-server/multi-workspace routing beyond what the roster already defines; one discovery handshake per roster.
- No Windows support commitment beyond what the current package already claims.

---

## Key Decisions

- First-caller-spawns over CLI-only daemon or eager plugin-init: best DX (cold start just works), no idle servers, no init races (Marcus, 2026-07-04).
- Generated per-spawn password + 0600 discovery file over ambient env secret: closes the rogue-process hole without upstream changes; pattern proven in opencode-copilot-delegate's RPC layer (port file + bearer token).
- Persistent daemon + staleness reaper over refcounted teardown: the bus is shared infrastructure carrying delegate sessions across operator sessions; explicit stop is the only kill.
- Library + thin CLI over either alone: Mothership imports, humans and launchd get `space-bus <cmd>`.
- Ephemeral port by default: discovery file supersedes the roster's `baseUrl` as source of truth for managed servers; fixed `baseUrl` remains the externally-managed escape hatch.

---

## Dependencies / Assumptions

- `harness serve` behavior — verified live (2026-07-04): `--port` exists with default 0 (native ephemeral), binds `127.0.0.1` by default, prints `opencode server listening on http://127.0.0.1:<port>` on stdout at readiness, and with `OPENCODE_SERVER_PASSWORD` set enforces Basic auth (probe: 401 unauthenticated, 401 wrong password, 200 correct).
- opencode-copilot-delegate's runtime layer (`src/runtime/rpc-server.ts`, `pid-file.ts`, `orphan-reaper.ts`, `plugin-singleton.ts`) is the reference implementation for handshake-file hygiene, singleton init, and reaping.
- The existing `/config` loadContext path composes with discovery-sourced credentials (managed mode feeds `{baseUrl, credentials}` from the handshake instead of roster/env).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Technical] Lock mechanism for spawn races (lockfile with O_EXCL vs mkdir vs flock) and the specific stale-lock recovery mechanism satisfying R2's bound.
- [Affects R5c][Technical] Spawn-timeout budget value and whether readiness probing uses the stdout line, an authed request, or both.
- [Affects R6][Technical] Discovery file location convention (XDG state dir keyed by roster path hash?) so multiple rosters don't collide.
- [Affects R9][Technical] CLI packaging: second bin beside `space-bus-mcp` vs subcommand consolidation.

---

## Sources / Research

- opencode-copilot-delegate runtime layer study (this session): authenticated localhost server with random bearer token + 0600 port file (`src/runtime/rpc-server.ts:366-433`), one-init-per-process singleton, PID-file orphan reaper, best-effort SIGTERM cleanup; known weaknesses noted (no restart supervision, memory-only task state).
- Observed failure modes (this session): server down → bare connection errors from all tools; manual start with wrong cwd and missing password → unsecured server.
- docs/brainstorms/2026-07-04-library-surface-requirements.md — the `/config`/context lane this feature's credential flow joins.
