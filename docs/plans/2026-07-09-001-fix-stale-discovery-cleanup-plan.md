---
title: "fix: Fail-closed cleanup of stale managed-daemon discovery records"
type: fix
status: active
date: 2026-07-09
origin: docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md
---

# fix: Fail-closed cleanup of stale managed-daemon discovery records

## Overview

When a managed `harness serve` daemon dies outside an explicit `space-bus stop` (crash, host-process exit), its `discovery.json` stays on disk pointing at a dead pid. Every later resolver reads that stale record and hands attachers a dead endpoint — the overnight `Connection failed: 599` in issue #49. This plan (Layer A of the issue) makes every Node-side resolver that detects a dead pid remove the stale record, using compare-and-delete so a concurrent respawn's fresh record is never destroyed. Layer B (active `--foreground` monitoring) is a separate follow-on plan.

## Problem Frame

`discovery.json` is written only after a readiness probe (correct, unchanged). But nothing removes it when the daemon later dies without an explicit stop. The two Node-side read surfaces both detect the dead pid and both decline to clean up:

- `attachLive` (`src/discovery.ts:150`) — verifies pid identity, returns `null` on failure, leaves the file.
- `serverStatus` (`src/server.ts:640`) — `readDiscovery` + `verifyIdentity`, returns `{ running: false }`, leaves the file.

The only paths that call `removeDiscovery` today are `stopServer`'s explicit stop and the orphaned-provisional reaper on the next spawn. So a crash-died daemon leaves a stale record indefinitely, and any attacher resolving it keeps dialing a dead port. (See origin: docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md.)

## Requirements Trace

- R1. A Node-side resolver that reads a discovery record whose pid fails identity verification removes `discovery.json` before returning — via compare-and-delete: only remove if the on-disk record still matches the stale record that was read (origin R1).
- R2. Both Node-side resolver surfaces perform this cleanup — the attach path and the CLI `status` path — so a dead daemon observed through either leaves no record behind (origin R2).
- R3. Cleanup is best-effort and never throws across the caller boundary; a resolver that can't remove the file still reports not-running (origin R3).
- R7. Covered by tests using an isolated `XDG_STATE_HOME`/state dir and a fake/test daemon: dead-child → next resolve removes the record; concurrent fresh record survives a stale-read cleanup (origin R7, Layer-A slice).

## Scope Boundaries

- Compare-and-delete cleanup only on the dead-pid read path. No behavior change when the pid verifies alive.
- No change to discovery-write timing (already correct — written only after readiness).
- The browser `/attach` resolver (`src/attach.ts`) is not modified — it has no filesystem access, already fails closed on read (surfaces an actionable not-answering error), and never deletes. Node-side cleanup is what removes the file.

### Deferred to Separate Tasks

- Layer B — active `--foreground` liveness monitoring + fail-closed exit for an external process manager: separate plan sourced from the same requirements doc.

## Context & Research

### Relevant Code and Patterns

- `src/discovery.ts:102` `readDiscovery` — read+zod-validate, returns `null` on absent/corrupt.
- `src/discovery.ts:121` `removeDiscovery` — `unlinkSync`, swallows ENOENT, rethrows other errors.
- `src/discovery.ts:150` `attachLive` — the shared pure read-path; **called directly by `config.ts:187` (plugin `loadContext`) and by `attachServer` (`src/server.ts:237`)**. Cleanup added here covers both resolver entry points at once.
- `src/server.ts:640` `serverStatus` — separate dead-pid detection (`readDiscovery` + `verifyIdentity`); needs the same cleanup independently.
- `src/discovery.ts:206` `verifyIdentity` — alive + identity match; the dead-pid signal that gates cleanup.
- `src/discovery.ts:81` `writeDiscovery` — atomic temp+rename+chmod 0600; the pattern a fresh concurrent record follows (why compare-and-delete matters).
- Best-effort unlink precedent: `releaseLock` (`src/discovery.ts:313`) and `removeProvisional` (`src/discovery.ts:456`) both swallow unlink errors.

### Institutional Learnings

- `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md` — the stop-path fix; established that the daemon is a wrapper+child in a detached group and that "confirmed dead → then remove discovery" is the discipline.
- `docs/solutions/best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md` — pid-identity verification before acting on a pid; the same best-effort framing applies to cleanup gating.
- `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md` — tests must isolate `XDG_STATE_HOME` (already wired via `test/setup.ts` preload) so cleanup tests don't touch the real home.

## Key Technical Decisions

- **Compare-and-delete lives in `attachLive`, not the `attachServer`/`serverStatus` wrappers.** The requirements doc assumed wrapper placement to avoid a config→server import cycle, but grounding shows `config.ts:187` calls `attachLive` *directly* — wrapper-only cleanup would silently skip the plugin's own resolver. And there is no cycle: `removeDiscovery` is defined in `discovery.ts` alongside `attachLive`, so the call is same-module. `attachLive` + `serverStatus` is the correct pair, and it covers all three resolver entry points (`config.ts` loadContext, `attachServer`, CLI status).
- **Compare-and-delete is best-effort, not atomic.** POSIX has no unlink-if-content-matches. The primitive re-reads the record immediately before unlinking and removes only if it still matches the pid/identity that were read; a fresh record written in the microsecond between re-read and unlink is not covered. This narrows the race to a tiny same-user window, consistent with the existing best-effort `verifyIdentity` posture — not a hard guarantee.
- **Match on pid + identity, not the whole record.** The stale record is uniquely keyed by `{ pid, identity }` (identity = start-time + comm captured at spawn). A fresh respawn always has a different identity (new process) — so pid+identity mismatch is a sufficient, minimal discriminator that a concurrent record is not the one we meant to delete.

## Open Questions

### Resolved During Planning

- Where does cleanup live without creating an import cycle? → In `attachLive` (same module as `removeDiscovery`); no cycle, and it covers the direct `config.ts` caller the wrappers would miss.
- What key proves "same stale record"? → `{ pid, identity }` from the record read; a respawn changes identity.

### Deferred to Implementation

- Exact shape of the compare-and-delete helper (a new `removeDiscoveryIfMatches(rosterPath, expected)` in `discovery.ts` vs. an inline re-read in the callers) — settle when touching the code; the plan requires the semantics, not the signature.

## Implementation Units

- [ ] **Unit 1: Compare-and-delete primitive in discovery.ts**

**Goal:** A best-effort helper that removes `discovery.json` only if the on-disk record still matches the stale `{ pid, identity }` that was read.

**Requirements:** R1, R3

**Dependencies:** None

**Files:**
- Modify: `src/discovery.ts`
- Test: `src/discovery.test.ts`

**Approach:**
- Add `removeDiscoveryIfMatches(rosterPath, expected: { pid, identity })`: re-read via `readDiscovery`; if it returns a record whose `pid` and `identity` both equal `expected`, call `removeDiscovery`; otherwise leave the file. Never throw — mirror the best-effort swallow used by `removeDiscovery`/`removeProvisional`.
- Reuse `removeDiscovery` for the actual unlink (keeps the ENOENT-swallow in one place).

**Patterns to follow:**
- `src/discovery.ts:121` `removeDiscovery` (best-effort unlink), `src/discovery.ts:456` `removeProvisional` (swallow-all precedent).

**Test scenarios:**
- Happy path: record on disk matches `{ pid, identity }` → file removed.
- Edge case: on-disk record has a different identity (simulated respawn) → file left intact.
- Edge case: on-disk record has a different pid → file left intact.
- Edge case: no file on disk (already gone) → no throw, no-op.
- Error path: unlink fails for a non-ENOENT reason → does not throw across the boundary.

**Verification:**
- A concurrent-respawn record survives; a matching stale record is removed; no call throws.

- [ ] **Unit 2: Wire cleanup into the dead-pid read paths**

**Goal:** `attachLive` and `serverStatus` remove the stale record (via Unit 1) when they detect a dead pid, before returning their existing not-running result.

**Requirements:** R1, R2

**Dependencies:** Unit 1

**Files:**
- Modify: `src/discovery.ts` (`attachLive`)
- Modify: `src/server.ts` (`serverStatus`)
- Test: `src/discovery.test.ts`, `src/server.test.ts`

**Approach:**
- In `attachLive`: when `verifyIdentity(discovery.pid, discovery.identity)` fails, call `removeDiscoveryIfMatches(rosterPath, { pid: discovery.pid, identity: discovery.identity })` before returning `null`. The record was already read, so the expected key is in hand.
- In `serverStatus`: same — when the `!verifyIdentity(...)` branch fires, clean up with the read record's `{ pid, identity }` before returning `{ running: false }`.
- No change to the alive path in either function; return values are unchanged.

**Patterns to follow:**
- `src/discovery.ts:150` `attachLive`, `src/server.ts:640` `serverStatus` — existing dead-pid branches are the insertion points.

**Test scenarios:**
- Happy path (attach): discovery for a killed child → `attachLive` returns `null` AND the file is gone.
- Happy path (status): discovery for a killed child → `serverStatus` returns `{ running: false }` AND the file is gone.
- Integration: `config.ts` `loadContext` against a dead managed record → resolves to not-running and the stale file is cleaned (proves the direct-`attachLive` caller is covered, not just `attachServer`).
- Edge case: alive+verified daemon → neither function removes the file (no false cleanup).
- Integration: a fresh record written concurrently with a stale-read cleanup survives (end-to-end of the compare-and-delete guard through the real read path).

**Verification:**
- After a managed child is killed, the next `attach`/`status`/`loadContext` both reports not-running and leaves no `discovery.json`; a live daemon's record is untouched.

## System-Wide Impact

- **Interaction graph:** three resolver entry points converge on `attachLive` (`config.ts` loadContext, `attachServer`, and transitively any `ensureServer` fast-path attach) plus the independent `serverStatus`; Unit 2 covers both convergence points.
- **Error propagation:** cleanup is best-effort and swallowed; a failed unlink never changes the not-running result the caller already returns.
- **State lifecycle risks:** the compare-and-delete guard is the mitigation for the one real risk — deleting a fresh record written by a concurrent respawn. Covered by a dedicated test.
- **API surface parity:** `attachServer` delegates to `attachLive`, so it inherits cleanup for free; the browser `/attach` resolver is intentionally excluded (no fs access).
- **Unchanged invariants:** discovery-write timing, the 0600 file mode, credential handling, and the alive-pid attach/status behavior are all unchanged — this only adds a delete on the already-existing dead-pid branch.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Cleanup deletes a fresh record from a concurrent respawn | Compare-and-delete: re-read and match `{ pid, identity }` before unlink; dedicated test. Residual same-user microsecond window accepted (documented best-effort, matches `verifyIdentity` posture). |
| Cleanup added in a wrapper misses the direct `config.ts` `attachLive` caller | Place cleanup in `attachLive` itself (verified via grounding that `config.ts:187` calls it directly); integration test through `loadContext`. |
| An unlink error crashes a resolver mid-attach | Best-effort swallow (mirrors `removeDiscovery`/`removeProvisional`); explicit error-path test. |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md](docs/brainstorms/2026-07-09-managed-daemon-supervision-requirements.md)
- Issue: fro-bot/space-bus#49 (+ Fro Bot triage comment)
- Related code: `src/discovery.ts` (`attachLive`, `readDiscovery`, `removeDiscovery`, `verifyIdentity`), `src/server.ts` (`serverStatus`, `attachServer`), `src/config.ts:187` (`loadContext`)
- Related learnings: `docs/solutions/integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md`, `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md`
