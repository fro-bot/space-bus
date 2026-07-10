---
title: "fix: Reap the orphaned daemon child on the supervision died path"
type: fix
status: active
date: 2026-07-10
---

# fix: Reap the orphaned daemon child on the supervision died path

## Overview

The `--foreground` supervisor's `died` path (Layer B, 0.8.0) exits fail-closed when the tracked `harness` wrapper pid is gone, but it never signals the process group. Because the managed daemon is a wrapper+child group (the wrapper is a `harness serve` shim; the real `opencode serve` child holds the port), a death in which the wrapper dies but the child survives leaves the child as a reparented orphan holding its port until reboot or a manual kill. This fix makes the supervisor reap the surviving group on the `died` path before it exits, guarded so it can never signal an unrelated process that recycled the wrapper pid.

## Problem Frame

Discovered during 0.8.0 live verification (scenario 3). `superviseTick` declares `died` when `serverStatus(rosterPath).running === false` — i.e. the recorded wrapper pid fails identity verification (gone or recycled). It returns `{reason:"died"}` and `runServe` exits non-zero without any group signal, on the assumption "the process is gone." That assumption holds for a clean crash (wrapper and child die together) but not for a wrapper-only death: the daemon is a detached process group (`spawnAndWaitReady` spawns `detached:true`, so the wrapper is group leader `pgid==pid` and the `opencode` child inherits the pgid). `stopServer` already relies on this — its live path group-signals via `signalGroup` — but its *dead-wrapper* branch just `removeDiscovery`s and returns, the same gap. So on `died`, a surviving child is orphaned. Low severity (resource leak, self-heals on next `ensure` which spawns fresh on a new port; nothing routes to the orphan), but real: an ~160MB `opencode` process lingers indefinitely.

## Requirements Trace

- R1. On the supervision `died` path, if the tracked pid's process group still has live members, the supervisor signals the group to terminate before exiting, freeing the orphaned child's port.
- R2. The reap never signals a process that recycled the wrapper pid: it fires only when the recorded pid is genuinely dead AND its group is still alive (a live group under a dead leader's pgid cannot have been recycled).
- R3. The fail-closed contract is unchanged — the supervisor still removes the discovery record (already done via Layer A cleanup in `serverStatus`) and still exits non-zero regardless of whether a reap was needed or succeeded. Reap is best-effort and never throws across the loop.
- R4. Covered by tests using an isolated `XDG_STATE_HOME`/state dir and a real (or stub wrapper+child) daemon: wrapper-only death leaves no orphan after the died path; a fully-dead group is a clean no-op; a recycled pid is never signaled.

## Scope Boundaries

- Only the supervision `died` path. The `hung` path already group-kills via `stopServer`; the `signal` path already stops cleanly; neither changes.
- No change to the fail-closed exit contract (still non-zero on death) or the discovery-cleanup behavior.
- No discovery-schema change — the surviving group is identified by the recorded wrapper pgid + group-liveness, not by recording the child pid.
- Layer A resolvers (`attachLive`/`serverStatus`) stay side-effect-free beyond their existing record cleanup — reaping is the supervisor's job (lifecycle owner), not a read-path concern.
- Not touching `stopServer`'s own dead-wrapper branch in this change (it `removeDiscovery`s on a dead pid where the same orphan could exist); noted as a deferred sibling.

### Deferred to Separate Tasks

- Apply the same group-reap to `stopServer`'s dead-wrapper branch (`src/server.ts` ~663) if we want `space-bus stop` on an already-dead wrapper to also sweep a surviving child — separate, lower-frequency path.

## Context & Research

### Relevant Code and Patterns

- `src/server.ts` `superviseTick` (~882) — the `!st.running → {reason:"died"}` branch is the insertion point.
- `src/server.ts` `signalGroup(pid, sig)` (~185) — `process.kill(-pid, sig)`; already guards `pid<=1`, throws on EPERM, falls back to bare-pid on ESRCH. The reap primitive.
- `src/server.ts` `waitForGroupDeath(pid, budgetMs)` (~1003) — `process.kill(-pid, 0)` group-liveness probe: true while any group member lives, ESRCH once the whole group is gone. Both the guard signal and the confirmation.
- `src/server.ts` `isAlive(pid)` / `verifyIdentity` — distinguish "leader genuinely dead" from "recycled".
- `src/server.ts` `stopServer` (~687) — the SIGTERM→SIGKILL group escalation + `waitForGroupDeath` pattern to mirror for the reap's escalation.
- `src/server.ts` `spawnAndWaitReady` (~507-516) — the `detached:true` spawn that makes the group-leader guarantee this fix relies on.

### Institutional Learnings

- `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md` — the original stop-leak: same wrapper/child topology, same "signal the group not the bare pid" fix; the died path is the one lifecycle exit that didn't adopt it.
- `docs/solutions/best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md` — this orphan can only be proven caught by a real wrapper+child process test, not a single-process stub or a seam mock.
- `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md` — isolate `XDG_STATE_HOME` in the tests.

## Key Technical Decisions

- **Guard = dead leader + live group, no child pid recorded.** Reap fires only when `!isAlive(discovery.pid)` (leader gone — excludes the recycled-pid case, where the pid is alive under a mismatched identity) AND `process.kill(-discovery.pid, 0)` succeeds (group still has members). A process group cannot outlive its leader *and* be recycled: while any member is alive the kernel won't reuse that pgid, so a live group under a dead leader pid is provably still ours. This gives the pid-recycle safety (R2) by construction — no discovery-schema change, no process-tree walking.
- **Reuse `signalGroup` + `waitForGroupDeath`, mirror `stopServer`'s escalation.** SIGTERM the group, wait a bounded grace (`STOP_GRACE_MS`), SIGKILL if still alive. Do not reimplement group signaling.
- **Best-effort, contract-preserving.** The reap is wrapped so it never throws into the loop; the outcome stays `{reason:"died"}` and `runServe` still removes the record (already done) and exits non-zero whether or not a child was found or the reap succeeded (R3). A leftover we couldn't kill (e.g. EPERM) still gets the fail-closed exit for the external manager.
- **Supervisor-only.** Reaping lives on the `died` path in `server.ts`, reached only from the `--foreground` supervisor. Read-path resolvers do not reap.

## Open Questions

### Resolved During Planning

- How to avoid killing a recycled pid without recording the child? → dead-leader + live-group guard; a live group can't have a recycled pgid.
- Reuse `stopServer` or a new path? → new reap on the died branch; `stopServer`'s dead-wrapper branch has the same gap and is explicitly deferred, and its live path assumes the wrapper is alive.

### Deferred to Implementation

- Exact factoring: a small `reapSurvivingGroup(pid)` helper in `server.ts` vs. inline in the died branch — settle when writing; the plan requires the guarded-reap semantics, not the signature.
- Whether the reap runs inside `superviseTick` (returning died after reaping) or in `superviseServer`/`runServe` after the outcome — pick whichever keeps the seam-testability and the `serverStatus`-already-cleaned invariant clean.

## Implementation Units

- [ ] **Unit 1: Guarded group-reap on the died path**

**Goal:** When supervision detects `died`, terminate a still-alive process group under the (now-dead) wrapper pid before returning, guarded against pid recycling.

**Requirements:** R1, R2, R3

**Dependencies:** None (composes `signalGroup`, `waitForGroupDeath`, `isAlive`)

**Files:**
- Modify: `src/server.ts`
- Test: `src/server.test.ts`

**Approach:**
- Add a best-effort `reapSurvivingGroup(pid)` (or inline equivalent) invoked on the `died` path: if `isAlive(pid)` is false AND `process.kill(-pid, 0)` succeeds (group still alive), `signalGroup(pid, "SIGTERM")`, `waitForGroupDeath(pid, STOP_GRACE_MS)`, escalate to `signalGroup(pid, "SIGKILL")` if needed. Swallow all errors — never throw into the loop.
- If the leader is alive (recycled/identity-mismatch) or the group is already fully dead, do nothing (no-op).
- Keep the `died` outcome and the existing record cleanup unchanged.

**Execution note:** Test-first — the wrapper+child topology means a real (or realistic stub) process is required to prove the reap; a single-process stub can't reproduce the orphan.

**Patterns to follow:**
- `src/server.ts` `stopServer` group SIGTERM→SIGKILL→`waitForGroupDeath` escalation; `signalGroup`/`waitForGroupDeath` as-is.
- `test/fixtures/wrapper-server.ts` (wrapper that spawns a child) as the managed daemon in the test.

**Test scenarios:**
- Integration (the bug): spawn a real wrapper+child managed daemon; kill only the wrapper pid; run the died path; assert the child is dead and its port freed, and no group members remain.
- Edge (clean crash): whole group already dead → reap is a no-op, no throw, died still returned.
- Edge (pid recycle safety): recorded pid is alive but identity-mismatched (simulated recycle) → the guard's `isAlive` check means the reap does NOT fire; assert no signal is sent to that pid. (Reuse the existing bystander-pid test pattern in `server.test.ts`.)
- Error path: group signal raises EPERM → swallowed, died still returned, supervisor still exits fail-closed.

**Verification:**
- After a wrapper-only death, the died path leaves zero surviving group members and a freed port; a fully-dead group and a recycled pid are both untouched; nothing throws.

- [ ] **Unit 2: Wire into supervision + fail-closed exit unchanged**

**Goal:** The supervisor performs the reap on `died` and still exits non-zero with the record removed.

**Requirements:** R1, R3

**Dependencies:** Unit 1

**Files:**
- Modify: `src/server.ts` (superviseTick/superviseServer) and/or `src/cli.ts` (runServe died branch) per the factoring chosen in Unit 1
- Test: `src/server.test.ts`, `src/cli.test.ts`

**Approach:**
- Ensure the reap runs exactly once on the died outcome, then `runServe` proceeds exactly as today (stderr line, `resolve(1)`), and `serverStatus`'s Layer A cleanup still removes the record.
- No change to signal/hung paths or the exit code.

**Test scenarios:**
- Integration: injected/real died outcome → reap invoked once, `runServe` returns non-zero, discovery gone.
- Regression: signal path still exits 0; hung path still calls `stopServer` once; non-foreground still returns 0 immediately.

**Verification:**
- `died` → child reaped + exit 1 + no stale record; all other supervision outcomes byte-for-byte unchanged.

## System-Wide Impact

- **Interaction graph:** `superviseTick`(died) → new reap → `signalGroup`/`waitForGroupDeath` (existing). No new primitives.
- **Error propagation:** reap is best-effort/swallowed; a failed reap never changes the died outcome or the non-zero exit.
- **State lifecycle risks:** the pid-recycle guard (dead leader + live group) is the one real hazard and is closed by construction; covered by the recycle-safety test.
- **API surface parity:** `stopServer`'s dead-wrapper branch has the same orphan gap and is explicitly deferred (Scope Boundaries) — flagged so the parity is a conscious decision, not an oversight.
- **Unchanged invariants:** fail-closed exit code, discovery cleanup, signal/hung/non-foreground paths, spawn/readiness, and the detached group-leader spawn all unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Reap signals a process that recycled the wrapper pid | Fire only when `isAlive(pid)` is false AND the group is still alive; a live group's pgid can't be recycled. Dedicated recycle-safety test. |
| Reap throws and breaks the fail-closed exit | Best-effort swallow; died outcome and non-zero exit are independent of reap success. |
| Child re-`setpgid`s out of the group and escapes the reap | Same documented, not-expected-in-practice limitation as `waitForGroupDeath` already carries for harness/opencode; out of scope. |
| Test can't reproduce the orphan with a single-process stub | Use the real wrapper+child fixture (`test/fixtures/wrapper-server.ts`) / real harness; a single-process stub is insufficient (see the real-subprocess-tests learning). |

## Documentation / Operational Notes

- Update `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md` (or cross-link) to note the died path as the third lifecycle exit that needed the group-signal treatment, closing the set (stop, hung, died).

## Sources & References

- Issue: fro-bot/space-bus#49 (Layer B follow-up; edge found in 0.8.0 verification, not in the original requirements)
- Related code: `src/server.ts` (`superviseTick`, `signalGroup`, `waitForGroupDeath`, `stopServer`, `spawnAndWaitReady`)
- Related learnings: `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md`, `docs/solutions/best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md`
