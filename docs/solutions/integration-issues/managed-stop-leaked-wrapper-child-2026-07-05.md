---
title: Managed stop leaked the port-holding child of the harness wrapper
date: 2026-07-05
category: integration-issues
module: space-bus
problem_type: integration_issue
component: tooling
symptoms:
  - "`space-bus stop` returned {stopped:true} while the server kept running and holding the port"
  - "the opencode child spawned by the harness wrapper survived as a ~164MB untracked orphan"
  - "the discovery file was removed while the server was still reachable, losing its credentials"
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - managed-server
  - process-group
  - signal-handling
  - wrapper-child
  - stop-leak
  - zombie-reap
---

# Managed stop leaked the port-holding child of the harness wrapper

## Problem

`space-bus stop` (and the managed lifecycle's kill paths) signaled only the pid recorded in the discovery file. But `harness serve` / `opencode serve` is a thin node **wrapper** that spawns the real server as a **child** which actually binds the port. `stopServer` SIGTERM'd the wrapper, saw it die, removed the discovery file, and reported `{stopped:true}` — while the child kept listening forever as an untracked orphan.

## Symptoms

- `space-bus stop` → `{stopped:true}`, but `lsof -iTCP:<port>` still shows a listener and the child pid is alive.
- The leaked child is a full ~164MB `opencode serve` process, not the ~3MB wrapper.
- Discovery file (with the generated password) deleted, so the orphan is now unreachable *and* untracked.

## What Didn't Work

- **The tests didn't catch it.** `test/fixtures/stub-server.ts` was a single process — it never modeled the wrapper→child split, so every stop test passed while the real topology leaked. Green CI, real bug. (This is the "a leak isn't a failing assertion" trap in another form.)
- **Signaling the recorded pid harder** (SIGTERM→SIGKILL on the wrapper) doesn't help — the child is a *separate* pid; killing the wrapper never touches it.

## Solution

`spawn(..., { detached: true })` makes the wrapper a **process-group leader** (`pgid == pid`), and its child inherits that group. Signaling the *negative* pid reaches the whole group:

```ts
function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) {                       // never process.kill(-1)/(-0) — see Prevention
    try { process.kill(pid, sig); } catch {}
    return false;
  }
  try {
    process.kill(-pid, sig);            // negative pid = the whole group
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") throw err; // group alive, can't signal — don't mask
    // ESRCH: not a leader / already gone — fall back to the bare pid
  }
  try { process.kill(pid, sig); } catch {}
  return false;
}
```

Completion must also follow the **group**, not the wrapper pid — a child that traps SIGTERM while the wrapper exits would otherwise re-trigger the same false `stopped:true`:

```ts
// polls process.kill(-pid, 0) until ESRCH (whole group gone)
if (await waitForGroupDeath(pid, STOP_GRACE_MS)) { removeDiscovery(rosterPath); return { stopped: true }; }
signalGroup(pid, "SIGKILL");
if (await waitForGroupDeath(pid, STOP_GRACE_MS)) { removeDiscovery(rosterPath); return { stopped: true }; }
return { stopped: false }; // survived SIGKILL — leave discovery intact
```

`stopServer` selects `waitForGroupDeath` vs `waitForDeath(pid)` based on whether `signalGroup` actually applied the group form (its return value) — a bare-pid fallback must not poll `kill(-pid,0)`, which would ESRCH-immediately and falsely report death.

## Why This Works

The leak was a **topology mismatch**: the stop logic was internally consistent but modeled the server as one process when the external harness binary is two (wrapper + child in one detached group). Signaling the group instead of the leader pid makes "stop the managed server" mean "stop the whole subtree the spawn created," which is what the operation always intended. `EPERM` is kept distinct from `ESRCH` so a group we *can't* signal is never reported as a successful stop with its credentials discarded.

## Prevention

- **Model external process topology in the test fixture.** Added `test/fixtures/wrapper-server.ts` — a wrapper that spawns the stub as a child in the same detached group and does *not* forward SIGTERM — plus a child-ignores-SIGTERM variant that forces the group SIGKILL path. Both tests are negative-controlled (they fail against the bare-pid kill / wrapper-pid death check). When you supervise an external binary, assume it may be a wrapper and prove your kill path reaches its children.
- **Guard the negative-pid footgun.** `process.kill(-1, sig)` signals *every* process the user can, and `process.kill(-0, sig)` hits the caller's own group. `signalGroup` refuses the group form for `pid <= 1`, and the discovery/lock/provisional pid schemas were tightened from `.positive()` to `.int().min(2)` so a tampered state file can't reach it.
- **Don't group-signal an unverified pid.** Only the identity-verified kill path uses the group form; the no-identity reap fallback stays a bare-pid kill so a recycled pid can't cascade a signal to an unrelated group.
- **Don't accept "flaky."** The wrapper/child tests initially failed ~1-in-3 in isolation — an instant `isAlive()` (`kill(pid,0)`) assertion racing a zombie-reap window (`kill(pid,0)` is briefly true for a just-killed, not-yet-reaped process). Fixed by polling actual termination (`waitUntilDead`), which preserves regression strength (a real signal failure leaves a *live* process that times out). Verified 25/25 in isolation before shipping.

## Related

- [../best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md](../best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md) — the lifecycle pattern whose stop-escalation section this bug refines; the wrapper/child process-group detail lives here.
- [../best-practices/verify-reviewer-empirical-claims-2026-07-05.md](../best-practices/verify-reviewer-empirical-claims-2026-07-05.md) — the same "verify, don't accept the confident claim" discipline that rejected the "flaky/unrelated" hand-wave and root-caused the zombie race.
- [../best-practices/audit-reused-kill-helper-fallbacks-2026-07-10.md](../best-practices/audit-reused-kill-helper-fallbacks-2026-07-10.md) — the **died-path sibling**: the same wrapper/child group-kill family, one path over. The stop path was fixed here; the died path's reuse of `signalGroup` exposed a bare-pid-fallback blast-radius risk (fixed with a group-only helper), with the residual zombie-leader edge and `stopServer` dead-wrapper parity tracked in issue #63.
