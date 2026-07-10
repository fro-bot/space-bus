---
date: 2026-07-09
topic: managed-daemon-supervision
---

# Managed Daemon Supervision & Stale Discovery Cleanup

## Summary

Give `space-bus` a supervision story for the managed `harness serve` daemon, in two independently shippable layers. Layer A: any Node-side resolver that reads a discovery record for a dead daemon removes the stale `discovery.json`, so attachers stop dialing a dead port. Layer B: `--foreground` becomes an active liveness monitor that, on confirmed child death, removes the record and exits non-zero — delegating restart to an external process manager rather than restarting the daemon in-process.

---

## Problem Frame

Managed mode records a live daemon's `{ pid, baseUrl, password }` in `discovery.json` after a successful readiness probe, and attachers (Mothership, the MCP facade, the CLI) resolve that record to reach the bus. Two gaps let the record outlive the daemon:

- **No stale-record cleanup on read.** When the recorded pid is dead, the read/attach/status paths return "not running" but leave `discovery.json` on disk. The next attacher resolves the same dead record and dials a dead localhost port. This surfaced as overnight `Connection failed: 599` in an app attached to the managed daemon — the daemon had died hours earlier and nothing cleared its record.
- **`--foreground` doesn't supervise.** It installs signal handlers on the CLI process and waits, but never checks whether the child daemon is still alive. If the child crashes or the host process exits without signalling the CLI, the daemon is gone and the record persists.

The lifecycle owner is `space-bus`. Attachers must not become watchdogs — pushing restart/cleanup responsibility to every attacher duplicates it and gets it wrong. Durable daemon ownership belongs in the tool that spawns the daemon; recovery-by-restart belongs to the OS process manager (launchd/systemd) supervising `space-bus serve` itself.

---

## Actors

- A1. Supervisor: the `space-bus serve --foreground` process that monitors the managed daemon's liveness and, on death, cleans up and exits for its own supervisor to act.
- A2. Resolver: any Node-side caller that reads the discovery record to attach or report status (CLI `status`, MCP facade, plugin `loadContext`).
- A3. Attacher: an external consumer that resolves the managed endpoint to use the bus (Mothership webview, Claude Desktop MCP). Stays a pure client — never restarts or cleans up the daemon.
- A4. External process manager: launchd/systemd/etc. that restarts `space-bus serve` after a fail-closed exit.

---

## Key Flows

- F1. Stale-record cleanup on read (Layer A)
  - **Trigger:** A2 resolves the discovery record while the recorded daemon is dead.
  - **Actors:** A2
  - **Steps:** Read discovery → verify pid identity → identity fails → compare-and-delete `discovery.json` (only if the on-disk record still matches the stale one read) → report not-running/null.
  - **Outcome:** The stale record is gone; the next A3 attach finds no record and gets an actionable "not running" instead of dialing a dead port.
  - **Covered by:** R1, R2, R3

- F2. Foreground liveness monitoring, fail-closed (Layer B)
  - **Trigger:** A1 is running `--foreground`; the managed child dies (crash or exit).
  - **Actors:** A1, A4
  - **Steps:** Poll detects confirmed death → remove `discovery.json` → exit non-zero → A4 restarts `space-bus serve`, which spawns a fresh daemon and writes a new record.
  - **Outcome:** A dead daemon leaves no stale record and its supervisor exits promptly; recovery is the external manager's job, not an in-process loop.
  - **Covered by:** R4, R5, R6

---

## Requirements

**Layer A — fail-closed stale-record cleanup (ships first, standalone)**
- R1. When a Node-side resolver reads a discovery record whose recorded pid fails identity verification, it removes `discovery.json` before returning — but only via compare-and-delete: the record on disk at removal time must still match the stale record that was read (pid/identity), so a concurrent respawn's fresh record is never deleted.
- R2. Both Node-side resolver surfaces perform this cleanup — the CLI `status` path (`serverStatus`) and the attach path (`attachServer`), so a dead daemon observed through either leaves no record behind. The browser `/attach` resolver is excluded (it fails closed on read but does not delete — see Scope Boundaries).
- R3. Cleanup is best-effort and must never throw across the caller boundary; a resolver that can't remove the file still reports not-running.

**Layer B — active foreground liveness monitoring (follow-on)**
- R4. `--foreground` periodically checks the managed child's liveness (process identity, and reachability of the authenticated endpoint), not just its own signals, with a failure threshold or grace period so a briefly-slow-but-alive daemon is not declared dead.
- R5. On confirmed child death, the supervisor removes `discovery.json` (compare-and-delete per R1) and exits non-zero, so an external process manager can restart `space-bus serve`.
- R6. On a clean shutdown signal (SIGINT/SIGTERM) the supervisor stops the managed daemon and removes the record; a supervisor crash leaves state such that the next resolver fails closed and removes it (R1). Any lock/provisional artifact left by a killed supervisor is reclaimed or ignored by the next resolver/spawn before it can block a fresh start.

**Testing**
- R7. Behavior is covered by tests using an isolated `XDG_STATE_HOME`/state dir and a fake/test harness daemon: killing the child and asserting the next resolve removes the record; killing the foreground supervisor and asserting bounded-time cleanup or fail-closed removal; a compare-and-delete test proving a concurrent fresh record survives a stale-read cleanup.

---

## Acceptance Examples

- AE1. **Covers R1, R2.** Given a discovery record whose daemon has been killed, when a resolver calls attach or status, then `discovery.json` is removed and the caller is told the server is not running.
- AE2. **Covers R3.** Given a stale record on a read-only or otherwise unremovable path, when a resolver attempts cleanup and the removal fails, then the resolver still returns not-running without throwing.
- AE3. **Covers R1.** Given a stale record being read by resolver X, when a concurrent spawn writes a fresh record before X unlinks, then X's compare-and-delete sees the mismatch and leaves the fresh record intact.
- AE4. **Covers R5.** Given `--foreground` supervising a daemon that dies, when death is confirmed, then the supervisor removes the record and exits non-zero (no in-process restart).
- AE5. **Covers R4.** Given `--foreground` running against a healthy daemon, when a single liveness probe is briefly slow, then the grace threshold prevents a false death declaration and the daemon keeps serving.

---

## Success Criteria

- An app attached to the managed daemon never spends the night dialing a dead port — after the daemon dies, the next resolve clears the record and the attacher gets an actionable not-running signal.
- A dead daemon under `--foreground` leaves no stale record and exits promptly for its external manager to restart.
- Starting managed mode still creates a record only after the daemon is reachable (already true — unchanged).
- A downstream planner can implement Layer A and Layer B as separate PRs from this doc without inventing cleanup semantics, the compare-and-delete contract, or the fail-closed exit behavior.

---

## Scope Boundaries

- Layer A and Layer B ship as separate PRs; Layer A does not depend on Layer B.
- No in-process restart of the managed daemon — recovery-by-restart is delegated to the external process manager (launchd/systemd) that supervises `space-bus serve`. `--foreground` monitors and fails closed; it does not respawn the child itself.
- No attacher-side supervision, polling, or cleanup — Mothership and other attachers stay pure clients (the browser `/attach` resolver surfaces an actionable not-answering failure but does not delete the record; Node-side cleanup handles removal).
- No detached-daemon supervision without `--foreground` — a fully detached `serve` (no foreground process) relies on Layer A's read-path cleanup, not active monitoring.
- No changes to the discovery-write timing (already correct — record written only after readiness).
- No new long-lived supervisor daemon beyond the existing `--foreground` process.

---

## Key Decisions

- Layer A ships before Layer B: fail-closed cleanup is a small, low-risk change that satisfies the core user outcome on its own; active monitoring is a separate, larger surface.
- Fail-closed-only over in-process restart: document review flagged that an in-process bounded-restart loop pulls `space-bus` toward being a process manager that launchd/systemd already are, and that Layer A already prevents the bad outcome (attachers dialing a dead port). `--foreground` therefore monitors liveness and exits non-zero on death, delegating restart to the external manager. This keeps `space-bus` a lifecycle *owner* (spawn, monitor, clean up) without becoming a restart *supervisor*.
- Compare-and-delete for stale cleanup: three reviewers independently flagged that unconditional removal on a dead-pid read can delete a fresh record written by a concurrent respawn. Removal is conditional on the on-disk record still matching the stale one read.
- Cleanup lives on the Node-side resolver, not the browser attacher: `attach.ts` has no filesystem access, so it surfaces the failure while the next Node-side resolve does the actual removal — the acceptance criterion is met behaviorally.
- A fresh spawn (via external-manager restart) mints a new password/identity/discovery record; attachers holding cached credentials must re-resolve rather than reuse them.

---

## Dependencies / Assumptions

- The existing spawn+readiness path (`spawnAndWaitReady`), pid-identity verification, and `removeDiscovery` primitive are reused as-is; this work wires them into the read and monitoring paths, it does not reimplement them.
- Layer A cleanup is added in the `attachServer`/`serverStatus` wrappers, not in the shared `attachLive` read-path — `config.ts`'s managed `loadContext` delegates to `attachLive` to avoid a config→server import cycle, so mutating cleanup must sit above that shared boundary.
- The managed daemon remains a `harness serve` wrapper whose real server is a child in the same detached process group (per the stop-leak fix) — liveness checks operate on that model.
- pid-identity verification is best-effort within the same-user trust boundary (`lstart` is second-granularity; a same-second pid reuse with matching `comm` could in principle collide). Accepted as a documented edge case; the authenticated-endpoint reachability check in R4 is the stronger discriminator for the supervision decision.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Liveness poll interval and whether to reuse `POLL_INTERVAL_MS` or a separate monitoring interval.
- [Affects R4][Technical] Exact death-vs-slow classification: how many consecutive probe failures, or how much elapsed time, before the supervisor declares the daemon dead and exits.
- [Affects R6][Needs research] Best-effort `process.on('exit')` cleanup coverage and its limits (can't cover SIGKILL of the supervisor itself — that's what R1's fail-closed read guards).
