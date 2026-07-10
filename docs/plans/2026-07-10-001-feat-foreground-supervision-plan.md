---
title: "feat: Active --foreground supervision with fail-closed exit"
type: feat
status: active
date: 2026-07-10
origin: docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md
---

# feat: Active --foreground supervision with fail-closed exit

## Overview

`space-bus serve --foreground` currently spawns the managed daemon, prints its endpoint, then blocks waiting only for its own `SIGINT`/`SIGTERM`. It never checks whether the child daemon is still alive. If the daemon crashes or the host exits without signalling the CLI, the daemon is gone, its `discovery.json` persists, and attachers keep dialing a dead port. This plan (Layer B of #49) makes the foreground process a real supervisor: it polls the daemon's liveness (pid-identity + authenticated HTTP probe with a grace threshold), and on confirmed death stops the daemon, removes the record, and exits non-zero so an external process manager (launchd/systemd) restarts `space-bus serve`. It does **not** restart the daemon in-process — that was the fail-closed-only scope chosen during the brainstorm.

## Problem Frame

`runServe`'s foreground branch (`src/cli.ts:113-123`) is a passive signal-waiter. Layer A (#57, merged) makes resolvers clean up a stale record when they *happen* to read one — but nothing proactively notices a foreground-supervised daemon dying, so a long-running attacher with no intervening Node-side resolve still sees the dead endpoint until something reads the record. Active supervision closes that gap for the `--foreground` case: the supervisor is the one process guaranteed to be watching, and it fails closed (cleanup + non-zero exit) so the OS-level manager can recover. (See origin: docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md.)

## Requirements Trace

- R4. `--foreground` periodically checks the managed child's liveness (process identity, and reachability of the authenticated endpoint), with a failure threshold/grace period so a briefly-slow-but-alive daemon is not declared dead (origin R4).
- R5. On confirmed child death, the supervisor removes `discovery.json` (compare-and-delete, reusing Layer A's `removeDiscoveryIfMatches` via `stopServer`) and exits non-zero, so an external process manager can restart `space-bus serve` (origin R5).
- R6. On a clean shutdown signal (SIGINT/SIGTERM) the supervisor stops the managed daemon and removes the record (already true via `stopServer`); a supervisor crash leaves state such that the next resolver fails closed and removes it (Layer A). Any lock/provisional artifact left by a killed supervisor is reclaimed or ignored by the next spawn (already true via `reapOrphanedProvisional`) (origin R6).
- R7. Covered by tests using an isolated `XDG_STATE_HOME`/state dir and a fake/test daemon: killed child → supervisor detects death, cleans up, and resolves with a non-zero outcome; a briefly-unreachable-but-alive daemon → grace threshold prevents a false death (origin R7, Layer-B slice).

## Scope Boundaries

- No in-process restart of the daemon — recovery-by-restart is delegated to the external process manager. The supervisor monitors and fails closed; it never respawns the child.
- No supervision of a fully detached `serve` (no `--foreground`) — that path relies on Layer A's read-time cleanup.
- No new long-lived supervisor daemon beyond the existing `--foreground` process.
- No change to spawn, readiness, discovery-write, or `stopServer` semantics — this composes them.
- The browser `/attach` resolver (`src/attach.ts`) is untouched.

### Deferred to Separate Tasks

- Any future crash-supervision/auto-restart posture (explicitly rejected for this layer; would be a separate brainstorm if revisited).

## Context & Research

### Relevant Code and Patterns

- `src/cli.ts:96` `runServe` — the foreground branch (lines 113-123) is the insertion point; it currently resolves only on signal.
- `src/server.ts:279` `probe(baseUrl, password)` — authenticated `GET /session?limit=1`, returns `"ready" | "auth-failure" | "retry"`, already `AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS)`. Module-private today; the supervisor needs it (export it, or expose a thin `probeLive` wrapper).
- `src/server.ts:642` `serverStatus(rosterPath)` — pid+identity liveness (+ Layer A cleanup); the process-identity half of the liveness check.
- `src/server.ts:687` `stopServer(rosterPath)` — SIGTERM→SIGKILL group stop + compare-and-delete cleanup; reused for the kill-and-fail-closed path on death.
- `src/server.ts:44,50,52` constants — `POLL_INTERVAL_MS=50` (spawn cadence, too fast for supervision), `PROBE_FETCH_TIMEOUT_MS=2000`, `STOP_GRACE_MS=2000`. Supervision needs its own interval + failure-threshold constants.
- `src/server.ts:76` `sleep(ms)` — the interval primitive.

### Institutional Learnings

- `docs/solutions/best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md` — lifecycle ownership + pid-identity discipline.
- `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md` — the wrapper/child process-group model `stopServer` relies on; the supervisor must call `stopServer` (group-aware), never a bare pid kill, to actually take down a hung daemon.
- `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md` — supervision tests isolate `XDG_STATE_HOME` (wired via `test/setup.ts`).

## Key Technical Decisions

- **Supervision lives in an exported `superviseServer` in `server.ts`, driven by `runServe`.** Keeping the loop in `server.ts` (not inline in `cli.ts`) makes it unit-testable with injected seams (fake clock/probe/stop) and keeps `cli.ts` a thin wrapper. `runServe`'s foreground branch awaits it.
- **Liveness = pid-identity AND authenticated HTTP probe, with a consecutive-failure threshold.** pid death (`serverStatus.running === false`) is immediate death (no grace — the process is gone). An alive pid whose endpoint fails the probe is only declared dead after N consecutive probe failures (default: probe every `SUPERVISE_INTERVAL_MS = 5000`, declare death after `SUPERVISE_FAILURE_THRESHOLD = 3` consecutive failures ≈ 15s of unreachability), so a briefly-slow/loaded daemon is not killed. A single successful probe resets the counter.
- **Hung-but-alive → kill-and-fail-closed.** When the threshold is crossed with the pid still alive (hung), the supervisor calls `stopServer` (group SIGTERM→SIGKILL, which frees the port and cleans the record) then exits non-zero — predictable over leaving a wedged daemon holding the port.
- **Exit code semantics.** Clean signal shutdown → exit 0 (unchanged). Confirmed daemon death (crash-gone or hung-killed) → exit non-zero so launchd/systemd restarts `space-bus serve`. Cleanup on the death path goes through `stopServer`/Layer A compare-and-delete, so a concurrent respawn's record is preserved.
- **`auth-failure` from the probe is treated as alive, not dead.** A 401/403 means the server is up and answering (a password mismatch is a config problem, not death) — it must not trip the death threshold. Only `retry` (unreachable/timeout/5xx) counts toward the failure streak.

## Open Questions

### Resolved During Planning

- Where does the loop live? → exported `superviseServer` in `server.ts`, awaited by `runServe`'s foreground branch.
- What counts as death vs slow? → pid-gone is immediate; endpoint-unreachable needs `SUPERVISE_FAILURE_THRESHOLD` consecutive failures; `auth-failure` counts as alive.
- How is a hung daemon taken down? → `stopServer` (group-aware), never a bare-pid kill.

### Deferred to Implementation

- Exact seam shape for testing the loop (inject `{ now, sleep, probe, stop, status }` vs. a smaller `{ checkOnce }` unit + a thin driver) — settle when writing the code; the plan requires deterministic testability without real timers or a real daemon.
- Whether to log each death-declaration to stderr (diagnostics) — likely yes, but wording is an implementation detail; must never log the discovery password.

## Implementation Units

- [ ] **Unit 1: superviseServer loop + constants in server.ts**

**Goal:** An exported, unit-testable supervision loop that polls liveness and returns a fail-closed outcome on confirmed death.

**Requirements:** R4, R5

**Dependencies:** None (composes existing `serverStatus`, `probe`, `stopServer`)

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

**Approach:**
- Add `SUPERVISE_INTERVAL_MS = 5000` and `SUPERVISE_FAILURE_THRESHOLD = 3`.
- Export `probe` (or a thin `probeLive(baseUrl, password)` wrapper) so the loop can reach the authenticated endpoint.
- Add `superviseServer(rosterPath, handle, opts?)` returning a discriminated outcome (e.g. `{ reason: "signal" } | { reason: "died" } | { reason: "hung" }`). Each tick: check `serverStatus` — if `!running`, the pid is gone → daemon died, break with `died`. Else `probe` the endpoint: `ready` or `auth-failure` → reset the failure counter; `retry` → increment. When the counter reaches the threshold with the pid still alive → `stopServer` (kill the hung daemon) and break with `hung`. Sleep `SUPERVISE_INTERVAL_MS` between ticks. Accept injectable seams (clock/sleep/probe/status/stop) for deterministic tests — default to the real ones.
- On the `died` path, ensure the record is cleaned: the pid-gone case means `serverStatus` already ran Layer A compare-and-delete; call it explicitly/idempotently so the outcome guarantees no stale record.

**Patterns to follow:**
- `src/server.ts:279` `probe`, `src/server.ts:642` `serverStatus`, `src/server.ts:687` `stopServer`, `src/server.ts:76` `sleep`.
- Discriminated-union return style used across `server.ts`/`core.ts`.

**Test scenarios:**
- Happy path (signal): a stop-signal seam fires → loop exits with `signal`, no cleanup-as-death.
- Death (crash): `serverStatus` reports `running:false` on tick 2 → loop exits `died`; discovery record is gone.
- Hung: pid alive but `probe` returns `retry` for 3 consecutive ticks → `stopServer` invoked once, loop exits `hung`, record gone, port-owner stopped.
- Edge (transient blip): `probe` returns `retry` twice then `ready` → counter resets, no death declared, loop continues.
- Edge (auth-failure ≠ death): `probe` returns `auth-failure` repeatedly with pid alive → never declares death (treated as alive).
- Edge (threshold boundary): exactly `threshold-1` failures then success → survives; exactly `threshold` → dies.

**Verification:**
- With injected seams, the loop declares death only on pid-gone or `threshold` consecutive `retry`s, calls `stopServer` exactly once on the hung path, and always leaves no stale record on a death outcome.

- [ ] **Unit 2: Wire supervision into runServe --foreground with fail-closed exit**

**Goal:** `--foreground` drives `superviseServer` and translates its outcome into the process exit code; signals still stop cleanly.

**Requirements:** R5, R6

**Dependencies:** Unit 1

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Approach:**
- Replace the foreground `Promise` body (cli.ts:113-123) so it races the existing SIGINT/SIGTERM shutdown against `superviseServer(rosterPath, handle)`.
- Signal path: unchanged behavior — `stopServer` then resolve exit 0.
- Supervision returns `died`/`hung`: write an actionable stderr line (no password), and resolve a **non-zero** exit code so an external manager restarts `space-bus serve`. Ensure the signal handlers are removed once the loop returns so a late signal can't double-stop.
- `--json` mode: keep stdout protocol-clean (the initial running-line already printed); death diagnostics go to stderr only.

**Patterns to follow:**
- `src/cli.ts:96` existing `runServe` structure and `printJson`; `src/cli.ts:136` `runStop` for the `stopServer` call shape.

**Test scenarios:**
- Happy path (signal): simulated SIGTERM → `runServe` resolves 0, daemon stopped.
- Death → non-zero exit: injected `superviseServer` resolving `died` → `runServe` returns a non-zero code, stderr carries an actionable message, no stale record.
- Hung → non-zero exit: injected `hung` outcome → non-zero code, `stopServer` was invoked.
- Non-foreground unchanged: `serve` without `--foreground` still returns 0 immediately and does not supervise.
- Regression: the initial running-line still prints before supervision starts.

**Verification:**
- `space-bus serve --foreground` returns 0 on clean signal and non-zero on daemon death, with no stale `discovery.json` left on the death path and stdout uncorrupted in `--json` mode.

## System-Wide Impact

- **Interaction graph:** `runServe` → `superviseServer` → {`serverStatus`, `probe`, `stopServer`}; all three already exist and are individually tested. Supervision is a new composition, not new lifecycle primitives.
- **Error propagation:** probe/timeout failures are classified (`retry` vs `auth-failure`) inside the loop; only confirmed death crosses into a non-zero exit. Cleanup failures stay best-effort (Layer A / `stopServer`), never throwing out of the loop.
- **State lifecycle risks:** death-path cleanup reuses Layer A compare-and-delete, so it can't delete a concurrent respawn's fresh record. The `hung` path uses group-aware `stopServer`, so it can't leak the port-holding child (the stop-leak fix invariant).
- **API surface parity:** only the `--foreground` CLI path changes; `bus_*` tools, MCP facade, and the detached `serve` path are unchanged. Exit-code contract is the new external surface (0 clean / non-zero on death) — document it.
- **Unchanged invariants:** spawn, readiness, discovery-write timing, 0600 mode, credential handling, and the non-foreground `serve` return are all untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| A briefly-slow daemon is killed as "dead" | Consecutive-failure threshold (default 3 × 5s) + single-success reset; `auth-failure` counted as alive; boundary tests. |
| Supervisor kills a hung daemon but leaks its child | Use group-aware `stopServer` (never bare-pid); inherits the stop-leak fix + its tests. |
| Death cleanup deletes a concurrent respawn's fresh record | Cleanup goes through Layer A compare-and-delete via `stopServer`/`removeDiscoveryIfMatches`. |
| Non-deterministic loop tests (real timers/daemon) | `superviseServer` takes injected clock/sleep/probe/status/stop seams; no real timers or daemon in unit tests. |
| Late signal after loop returns double-stops | Remove signal handlers once `superviseServer` resolves; idempotent `stopServer` (`{stopped:false}` on no record). |

## Documentation / Operational Notes

- README `--foreground` section: document that it now actively supervises and exits non-zero on daemon death, and give the launchd/systemd `Restart=on-failure` pattern that pairs with it.
- Note the exit-code contract (0 clean shutdown / non-zero daemon death) for anyone scripting `space-bus serve`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md](docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md)
- Issue: fro-bot/space-bus#49 (Layer B)
- Predecessor: PR #57 (Layer A, merged) — `removeDiscoveryIfMatches` compare-and-delete
- Related code: `src/cli.ts` (`runServe`), `src/server.ts` (`probe`, `serverStatus`, `stopServer`, supervision constants)
- Related learnings: `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md`, `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md`
