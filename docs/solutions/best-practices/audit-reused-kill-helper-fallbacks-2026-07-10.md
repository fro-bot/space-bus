---
module: space-bus
category: best-practices
date: 2026-07-10
last_updated: 2026-07-11
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - reusing a shared signaling/kill helper in a new caller
  - the new caller has weaker preconditions than the helper's original caller
  - hardening a kill/reap/cleanup path, especially on error/death paths
  - a review's obvious guard may not be the real blast-radius risk
tags:
  - code-review
  - kill-path
  - process-signaling
  - helper-reuse
  - blast-radius
  - oracle-adjudication
  - right-sizing
---

# Audit a reused kill-helper's fallback against the new caller's weaker preconditions

## Context

Adding a group-reap to the supervision `died` path (space-bus #62), the obvious hazard seemed to be pid recycling: don't signal a wrapper pid that has been recycled to an unrelated *live* process. The guard was designed around that (`isAlive(pid)` → no-op). But a 4-persona review plus an independent Oracle adjudication found the real blast-radius bug was elsewhere and subtler: the reaper reused the shared `signalGroup` helper, whose documented behavior **falls back** from the group form `process.kill(-pid, sig)` to a **bare-pid** `process.kill(pid, sig)` on ESRCH. Oracle rated that fallback "at least as important as" the guard the review had been focused on.

## Guidance

When you reuse a shared signaling/kill helper in a new caller, audit its **fallback / degradation behavior**, not just its happy path — and audit it against the *new caller's* preconditions, which are often weaker than the original caller's. A fallback that is safe because the original caller established an invariant first (e.g. "this pid is verified ours") becomes a blast-radius bug in a new caller that lacks that invariant. Three questions for security-sensitive signaling code:

1. What precondition does the original caller establish before calling the helper?
2. Does the new caller establish that same precondition?
3. If not, does the helper's fallback widen the blast radius under the new caller's state?

Reach for independent adjudication (Oracle) on kill/signal paths — ask specifically for a fallback-mode audit against the new caller. The guard you designed around may not be the real risk.

Then **right-size the fix to the finding's actual severity**: fix the genuine blast-radius bug proportionately, and track a narrow, self-healing edge as a follow-up rather than over-building for it.

## Why This Matters

`signalGroup` is safe in `stopServer` because `stopServer` calls `verifyIdentity(discovery.pid, discovery.identity)` first — the recorded pid is confirmed *ours* before any signal, so the ESRCH bare-pid fallback can only ever hit our own process. The reaper runs on the `died` path, where the pid is by definition dead or recycled and there is no live-identity precondition. If the group dies between the reaper's liveness check and its signal, `signalGroup`'s fallback would `process.kill(pid, sig)` a bare pid that may have been recycled to a stranger — i.e. SIGKILL the wrong process. Same helper, opposite safety, entirely because of the caller's precondition. The "don't signal a live recycled leader" guard was correct but not the load-bearing risk; the shared helper's fallback was.

The right-sizing half matters too: reviewers flagged a Linux zombie-leader edge as possibly "silently broken on Linux." Oracle traced it and downgraded it to a narrow, self-healing race (a zombie normally still matches identity, so the died path isn't even reached). The proportionate response was to fix the real blast-radius bug now (a group-only helper) and track the edge as a follow-up with the fuller fix sketch — not to build tri-state process inspection for an edge that rarely manifests.

## When to Apply

- Reusing a shared kill/signal helper in a new lifecycle path.
- Moving from "owned, verified process" semantics to "possibly stale/recycled pid" semantics.
- Any cleanup/reap code on error or death paths.
- Any review where the fix is signaling, killing, or process-group manipulation — get an independent pass and audit reused helpers' failure modes explicitly.
- More broadly: any **wrapper/probe helper whose failure-mode inference feeds a destructive action** — the same shape appears whenever a helper collapses "I couldn't determine X" into "X is safely absent."

## Second instance — a probe that conflates failure with absence (`printJob`, #80)

The same failure family surfaced in the `space-bus service` launchd work, in a non-kill helper. `printJob` wraps `launchctl print` to answer "is this job loaded?" — and its teardown callers (`uninstallService`, `installService`) act destructively on the answer (delete the plist, overwrite a running job). The original helper collapsed **every** non-zero exit into `{ loaded: false }`:

```ts
// Before — a permission error, an IO error, and a timeout all look identical
// to "job not found", so a probe *failure* reads as *absence*:
if (result.code !== 0) return { loaded: false };
```

That is the identical hazard to the bare-pid fallback: a helper's degraded/failure branch widens the blast radius of a caller that trusts it. Uninstall would `unlinkSync` the plist and return `ok:true` while the job was still loaded, because a failed `launchctl print` was misread as "gone."

The fix makes the helper distinguish failure from absence with a discriminated union — only launchd's own "not found" wording counts as not-loaded; every other non-zero is `ok:false` so callers fail honestly:

```ts
export type PrintJobResult =
  | { ok: true; loaded: boolean; pid?: number }
  | { ok: false; error: string };

const NOT_LOADED_MARKERS = ["could not find", "no such process"];

// ...only these markers on a non-zero exit mean not-loaded; anything else is
// { ok: false, error } — a probe failure the caller must not treat as absence.
```

...and teardown refuses to delete unless absence is *confirmed* (`bootoutUntilAbsentOrFail` re-probes after a failed `bootout`; a still-loaded or un-probeable job leaves the plist in place and returns `ok:false`). Same lesson, generalized: **don't let a helper's failure branch turn "couldn't prove absence" into "safe to do the destructive thing."**

## Examples

The shared helper's fallback — safe for its original caller, dangerous for a new one (`src/server.ts` `signalGroup`):

```ts
try {
  process.kill(-pid, sig);   // group form
  return true;
} catch (err) {
  if (err.code === "EPERM") throw err;
  // ESRCH: not a group leader, or the group is already gone — fall back
  // to signaling the bare pid.
}
process.kill(pid, sig);      // <-- bare-pid fallback: fine when pid is verified ours, a blast-radius bug when it may be recycled
```

Safe in `stopServer` because of the precondition:

```ts
if (!verifyIdentity(discovery.pid, discovery.identity)) return { stopped: false };
// ...pid is confirmed ours before signalGroup is called
```

The new group-only helper for the reaper — never falls back to a bare pid:

```ts
function signalGroupOnly(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(-pid, sig);   // group form ONLY
    return true;
  } catch {
    return false;              // ESRCH/EPERM → fail closed, never signal the bare pid
  }
}
```

Honest guard framing (model for documenting a safe-biased guard instead of overclaiming) — from `reapSurvivingGroup`'s docstring:

> ...a live group's pgid is not reused while any member holds it — a **strong practical guard, not an absolute proof**: a narrow TOCTOU remains if the whole original group exits and the pgid is recycled between this check and the signal...

Right-sizing: the blast-radius bug was fixed now (`signalGroupOnly`); the narrow zombie-leader edge and the `stopServer` dead-wrapper parity were tracked as follow-up issue #63 with Oracle's tri-state process-inspection sketch, rather than over-built into this change.

## Related

- [../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md](../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md) — the process-group signaling precedent (stop path); this is the same family (stop → hung → died), and the died-path fallback risk is its sibling.
- [./launchd-ambient-env-plist-pinning-2026-07-11.md](./launchd-ambient-env-plist-pinning-2026-07-11.md) — a sibling best-practice from the same `space-bus service` feature (#80) that surfaced the `printJob` second instance above.
- [./managed-server-lifecycle-first-caller-spawns-2026-07-05.md](./managed-server-lifecycle-first-caller-spawns-2026-07-05.md) — the managed-server lifecycle checklist: identity-gated kill, group signaling, orphan reaping.
- [./verify-reviewer-empirical-claims-2026-07-05.md](./verify-reviewer-empirical-claims-2026-07-05.md) — independent (Oracle) review of security-relevant claims; this doc extends it specifically to kill/signal fallback audits.
- [../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md](../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md) — right-sizing scope and not over-trusting the obvious framing.
