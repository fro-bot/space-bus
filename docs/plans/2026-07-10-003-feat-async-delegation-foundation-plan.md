---
title: "feat: Async-delegation foundation — normalized state enum + bus_wait"
type: feat
status: active
date: 2026-07-10
origin: docs/brainstorms/2026-07-10-async-delegation-requirements.md
---

# feat: Async-delegation foundation — normalized state enum + bus_wait

## Overview

Give the dispatching agent a first-class way to track delegated bus work: a **normalized state enum** derived once in core (`running | blocked | complete | failed | not_found`, plus a "result available" signal) and emitted identically by `bus_status`, the library `snapshot()`, and a new **`bus_wait`** tool; and `bus_wait` itself — a stateless, level-triggered, first-to-attention wait over one or more sessions with its own timeout, sourced from a bounded long-poll of the harness status/question endpoints. This is the 0.9.0 foundation of the async-delegation arc (a smarter wait that replaces the busy-poll loop); fire-and-forget push-notification is a deferred follow-on. (See origin: docs/brainstorms/2026-07-10-async-delegation-requirements.md.)

## Problem Frame

A control agent that delegates via `bus_task` today calls `bus_status` in parallel across session IDs, infers state from raw `busy`/`blocked` fields, and re-polls on its own initiative because nothing tells it when something changed. Two costs: every caller re-derives the same state machine from low-level fields (and will diverge), and a delegate that **blocks on a question stalls silently** until the caller happens to poll again. An agent asked for the fix by name: a normalized state enum plus a `bus_wait`/`bus_watch(sessionIds[])` primitive. This matters more now that space-bus is a library (`/core`, `/contract`, `snapshot()`) whose consumers (Mothership) each answer "is this delegate done?" ad hoc.

## Requirements Trace

- R1. A normalized state enum (`running | blocked | complete | failed | not_found`) is the caller-facing lifecycle contract, not raw `busy`/`blocked`; the state carries whether a result is available and, when blocked, the pending question (origin R1, R2).
- R2. The enum is derived once in core and emitted identically by `bus_status`, `snapshot()`, and `bus_wait`; it is exported on the browser-safe `/core` + `/contract` surface (origin R3).
- R3. A new `bus_wait` tool (the fifth bus tool) accepts one or more session IDs and a bounded timeout and blocks until a wake condition or timeout (origin R4).
- R4. Wake is level-triggered on "needs attention" — any watched session already in or reaching `complete | blocked | failed | not_found` wakes the wait; a still-`running` session does not. Returns immediately if a watched session is already in a needs-attention state at entry (origin R5).
- R5. On wake, `bus_wait` returns a snapshot of every watched session's normalized state, identifying the waker(s) — the set already in a needs-attention state — so the caller drains all ready sessions in one call (origin R6).
- R6. On timeout, `bus_wait` returns the current snapshot without an error; repeated-timeout retry budget is the caller's policy, not a hidden guarantee (origin R7).
- R7. `bus_wait` holds no persistent plugin state; the wait lives within the single tool call and does not use `api()`'s 30s abort — it has its own timing (origin R8, R11).
- R8. Cross-directory: `bus_wait` groups watched session IDs by resolved project directory and polls each group (group-by-directory, not reject) (origin R12).
- R9. A single unresolvable/failed session ID is reported inline as its state and never fails the whole call; concurrent long-held waits are bounded (origin R14).
- R10. The wait path re-validates its endpoint against the loopback guard before each auth-bearing request and fails closed off-loopback (origin R13).
- R11. `bus_wait` works over both the plugin tool map and the stdio MCP facade with byte-identical description and output (two-surface parity) (origin R9).
- R12. All existing invariants hold: core returns discriminated unions (never throws across the boundary), no telemetry/off-machine calls, directory-routing via `ctx.directory` (origin R10).

## Scope Boundaries

- 0.9.0 ships the normalized enum + `bus_wait` (blocking wait). Progressive delivery; enum and `bus_wait` may land in sequence.
- No persistent plugin process, background watcher, or in-memory task registry — `bus_wait` is stateless per call.
- No change to the `bus_task` dispatch/steering contract — answering a blocked delegate still goes through `bus_task`.
- No separate `bus_watch` board tool; one wait primitive.
- No SSE stream consumption in 0.9.0 — the wait is a bounded long-poll (see Key Technical Decisions).

### Deferred to Separate Tasks

- **Fire-and-forget push-notification** — dispatch then get notified later; needs a background watcher that outlives the tool call and a channel to push into the caller's session, and cannot reach two-surface parity (the MCP facade has no session to push into). Deferred beyond 0.9.0, plugin-only when built.
- **SSE-based wait** — if long-poll latency proves inadequate, an event-driven `/event` variant is a later optimization, not 0.9.0.
- **`bus_cancel`-style dispatcher cancellation** — adjacent, not requested.

## Context & Research

### Relevant Code and Patterns

- `src/core.ts` `status` (~589) — already fetches `/session/{id}`, `/session/status`, `/session/{id}/todo`, the diff, and `fetchPendingQuestion` in parallel and computes `busy` + `pendingQuestion`. The normalized-state derivation consumes exactly these; the per-session state builder is factored out of here.
- `src/core.ts` `fetchPendingQuestion` (~565) and `findSessionDirectory` — the question read and directory resolution `bus_wait` reuses per session.
- `src/core.ts` `api` (~62) — hard-codes `AbortSignal.timeout(30_000)`. `bus_wait`'s poll must not inherit that as its overall bound; each individual poll request can still use `api`, but the loop owns its own deadline.
- `src/core.ts` `snapshot` (~925) + `fetchSnapshotProject` — where the enum must also surface for library consumers; uses `mapWithConcurrency`, the same bounded-fan-out `bus_wait` groups need.
- `src/core.ts` `validateContext` — the per-call context gate (zod parse + loopback guard) every core function runs; `bus_wait` runs it too, and R10 re-validates the resolved endpoint.
- `src/contract.ts` — already exports `sessionStatusMapSchema`, `pendingQuestionListSchema`, etc.; the new state enum (a zod enum + the per-session state object schema) lands here, browser-safe (zod-only, no Node deps).
- `src/tools/bus_status.ts` + `src/format.ts` `formatStatus` — `bus_status` derives nothing itself; it calls `status()` and formats. `bus_wait`'s tool adapter mirrors this shape (`makeBusWait` + a `formatWait`), and the MCP facade in `src/mcp.ts` registers the same from the shared factory (two-surface parity).
- `src/mcp.ts` — the four `bus_*` MCP registrations; `bus_wait` adds a fifth, driven from the same `BUS_WAIT_DESCRIPTION` constant + core call, never hand-duplicated.

### Institutional Learnings

- `docs/solutions/best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md` — a long-poll wait's timing/timeout behavior is a process-level claim; cover it with a test that exercises real elapsed time (a fake/stub server that transitions state on a timer), not only mocked instant returns.
- `docs/ideation/2026-07-04-mothership-support-ideation.md` — the `snapshot()` composite and structured-state direction this enum extends.
- Memory (OpenCode `/event` SSE): the stream is directory-scoped and carries no wire `id`, forcing full-state reconcile on reconnect — the reasons SSE is deferred in favor of long-poll for 0.9.0.

## Key Technical Decisions

- **Bounded long-poll, not SSE.** `bus_wait` loops: resolve each session's directory once, then poll each directory group's `/session/status` (+ `/question` for blocked detection) on a bounded interval until any watched session is in a needs-attention state or the wait deadline elapses. This stays stateless, reuses `status()`'s building blocks, is naturally level-triggered (each poll reads current state, so an already-done session wakes immediately), re-validates loopback every request, and avoids a long-lived auth-bearing connection. SSE is lower-latency but directory-scoped, protocol-quirky (no wire id, reconcile-on-reconnect), and a long-lived connection — deferred as a later optimization.
- **State derived once in core, not per-emitter.** A single `deriveSessionState(...)` in core maps the raw `/session/status` entry (+ pending question, + resolution success) to the normalized enum. `status()`, `snapshot()`, and `bus_wait` all call it, so the three emitters cannot diverge (R2). The enum + per-session state object schema live in `contract.ts` (browser-safe).
- **`bus_wait` owns its deadline, individual polls use `api`.** Each poll request keeps `api`'s 30s per-request abort (a single status read should never take that long), but the wait loop's own `timeoutMs` (defaulted below any MCP-facade ceiling) governs total duration — the two are independent (R7).
- **Level-triggered by construction.** Because each poll reads current state rather than subscribing to transitions, "already complete/blocked at entry" is just the first poll returning a needs-attention state — no edge-vs-level bug (R4).
- **`not_found`/`failed` are first-class states, not errors.** `findSessionDirectory` failing for one ID yields that ID's state as `not_found`; a session the server reports as errored/aborted yields `failed`. Neither throws; the wait proceeds on the rest (R9). Core keeps its never-throw discriminated-union contract.
- **New fifth tool, driven from one factory.** `makeBusWait` + `BUS_WAIT_DESCRIPTION` are consumed by both the plugin tool map and the MCP registration (parity), exactly as the existing four are.

## Open Questions

### Resolved During Planning

- Wait mechanism? → bounded long-poll (stateless, level-triggered, loopback-safe); SSE deferred.
- Cross-directory? → group-by-directory and poll each group; do not reject mixed-directory waits.
- How to avoid the 30s `api` abort bounding the wait? → the loop owns its deadline; per-poll requests keep the 30s per-request cap.
- Where does the enum live? → derived once in core, schema in `contract.ts`, exported on `/core`+`/contract`.

### Deferred to Implementation

- Exact poll interval and default/max `timeoutMs` — tune against the live harness and any MCP-facade call ceiling; the requirement is "bounded, below the facade ceiling," not a specific number.
- Concrete member spelling (`failed` vs `error`, `not_found` vs `unknown`) — settle at implementation; the state *set* is fixed.
- Exact concurrent-wait cap (R9) and whether it's per-call fan-out only or a global guard — settle when wiring; that a bound exists is required.
- Whether `bus_status` adopts the new state object shape additively (keeps current fields, adds `state`) or restructures — verify against `formatStatus` and existing tests to avoid a breaking output change.

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. Treat it as context, not code to reproduce.*

```
bus_wait(sessionIds[], timeoutMs)
  ├─ validateContext (loopback guard, once)
  ├─ resolve each sessionId -> directory   (findSessionDirectory; unresolved -> not_found)
  ├─ group sessionIds by directory
  ├─ loop until (any session in needs-attention state) OR (deadline):
  │     for each directory group (bounded concurrency):
  │        poll /session/status (+ /question) -> deriveSessionState per session
  │     if any state in {complete, blocked, failed, not_found}: break
  │     sleep(pollInterval)   // own timing, not api()'s 30s
  └─ return { sessions: [{ sessionId, project, state, resultAvailable?, pendingQuestion? }...],
              waker: [ids already in needs-attention state], timedOut: bool }

deriveSessionState(statusEntry, pendingQuestion, resolved) -> "running"|"blocked"|"complete"|"failed"|"not_found"
  // called identically by status(), snapshot(), bus_wait
```

## Implementation Units

- [ ] **Unit 1: Normalized state enum + deriveSessionState in core/contract**

**Goal:** One place that turns raw session status into the normalized enum, exported for all three emitters and library consumers.

**Requirements:** R1, R2, R12

**Dependencies:** None

**Files:**
- Modify: `src/contract.ts` (add the state enum + per-session state object schema, browser-safe)
- Modify: `src/core.ts` (add `deriveSessionState`; have `status()` populate the normalized state from it)
- Test: `src/contract.test.ts`, `src/core.test.ts`

**Approach:**
- Add a zod enum `sessionStateSchema` (`running | blocked | complete | failed | not_found`) and a `sessionStateInfoSchema` (`{ sessionId, project, state, resultAvailable, pendingQuestion? }`) to `contract.ts`.
- Add `deriveSessionState(statusEntry, pendingQuestion, resolved)` to `core.ts`: `not_found` when unresolved; `blocked` when a pending question exists; `complete` when not busy and resolved; `running` when busy; `failed` for a server-reported errored/aborted session. Encode the precedence explicitly.
- Have `status()` emit the normalized `state` additively (keep existing fields to avoid a breaking change; add `state`).

**Execution note:** Test-first — pin the derivation precedence (blocked-vs-complete-vs-running-vs-failed) before wiring emitters.

**Patterns to follow:**
- `src/core.ts` `status` busy/pendingQuestion computation; `src/contract.ts` existing zod `looseObject`/enum exports.

**Test scenarios:**
- Happy path: busy entry → `running`; not-busy resolved → `complete` with `resultAvailable:true`; pending question present → `blocked` with the question; unresolved id → `not_found`; server-errored session → `failed`.
- Edge: busy AND a pending question → `blocked` wins (precedence); not-busy but a pending question still open → `blocked` wins over `complete`.
- Edge: the enum + state object parse/round-trip through the contract schema (browser-safe, zod-only).
- Integration: `status()` output now carries `state` matching `deriveSessionState`, with existing fields unchanged.

**Verification:** `status()` reports a normalized `state` for every case; the derivation precedence is pinned; existing `bus_status` output fields are unchanged.

- [ ] **Unit 2: snapshot() emits the normalized state**

**Goal:** The library composite reports the same enum, so Mothership/library consumers get one definition.

**Requirements:** R2

**Dependencies:** Unit 1

**Files:**
- Modify: `src/core.ts` (`fetchSnapshotProject` / `snapshot` include per-session `state`)
- Test: `src/core.test.ts`

**Approach:**
- Where `snapshot()` already surfaces per-session busy/pending info, add the normalized `state` from `deriveSessionState` so it reads identically to `status()` and `bus_wait`.

**Patterns to follow:** `src/core.ts` `snapshot` / `fetchSnapshotProject`, `mapWithConcurrency`.

**Test scenarios:**
- Happy path: a snapshot over projects with busy / idle / blocked sessions reports the matching `state` per session.
- Integration: the `state` a session reports via `snapshot()` equals what `status()` reports for the same session (parity of the shared derivation).

**Verification:** `snapshot()` per-session state matches `status()` for the same session.

- [ ] **Unit 3: bus_wait core function (long-poll, level-triggered, grouped)**

**Goal:** The stateless wait primitive in core: resolve → group-by-directory → bounded long-poll until needs-attention or timeout → snapshot.

**Requirements:** R3, R4, R5, R6, R7, R8, R9, R10, R12

**Dependencies:** Unit 1

**Files:**
- Modify: `src/core.ts` (add `wait(sessionIds, opts)` returning a discriminated-union `Result`)
- Test: `src/core.test.ts`

**Approach:**
- Resolve each session's directory (`findSessionDirectory`); unresolved → `not_found` state, kept in the result, not thrown.
- Group resolved sessions by directory; poll each group's `/session/status` (+ `/question`) with bounded concurrency, mapping each session through `deriveSessionState`.
- Loop with an owned deadline (`timeoutMs`) and a bounded poll interval; break as soon as any watched session is in `complete|blocked|failed|not_found`. Level-triggered: the first poll already wakes on an at-entry needs-attention session.
- Re-run the loopback guard on the resolved endpoint before each request (R10); fail closed off-loopback.
- Return `{ sessions: SessionStateInfo[], waker: sessionId[], timedOut }` as an `ok:true` result; on timeout, same shape with `timedOut:true` and all current states.
- Never throw across the boundary; a per-session resolution/read failure is that session's state, not a call failure.

**Execution note:** Test-first, and include a real-elapsed-time test (a stub server that flips a session to complete/blocked after a delay) so the long-poll timing and level-triggering are proven, not mocked instant.

**Patterns to follow:** `src/core.ts` `status`, `findSessionDirectory`, `mapWithConcurrency`, `validateContext`; the never-throw `Result` union used throughout core.

**Test scenarios:**
- Happy path: three sessions, one already `complete` at entry → returns immediately, waker = [that id], all three states present.
- Level-triggered: a session already `blocked` at entry → immediate return (no waiting for a transition).
- Transition: all `running` at entry, one flips to `complete`/`blocked` mid-wait (stub timer) → wakes before timeout with that session as waker.
- Timeout: all stay `running` past `timeoutMs` → `timedOut:true` with all-`running` snapshot, no error.
- not_found: one id unresolvable → inline `not_found`, wait proceeds on the rest; and a `not_found` at entry wakes (needs attention).
- Cross-directory: sessions in two directories → both groups polled, both represented in the snapshot.
- Loopback: a resolved non-loopback endpoint → fails closed, no auth request sent.
- Deadline vs api: the wait honors `timeoutMs` and is not bounded by `api`'s 30s (a wait longer than 30s with a late transition still wakes).

**Verification:** `wait()` wakes level-triggered on needs-attention across directories, times out with a full snapshot, never throws, and honors its own deadline + the loopback guard.

- [ ] **Unit 4: bus_wait tool + MCP registration (two-surface parity)**

**Goal:** Expose `wait()` as the fifth `bus_*` tool on both surfaces, driven from one factory.

**Requirements:** R3, R5, R6, R11

**Dependencies:** Unit 3

**Files:**
- Create: `src/tools/bus_wait.ts` (`makeBusWait` + `BUS_WAIT_DESCRIPTION`)
- Modify: `src/index.ts` (register `bus_wait` in the tool map), `src/mcp.ts` (register the fifth MCP tool from the same factory/description), `src/format.ts` (`formatWait`)
- Test: `src/tools/*.test.ts` (or the existing tool/MCP parity test), `src/format.test.ts`, `src/mcp` parity test
- Modify: `README.md`, `AGENTS.md` (tool count 4→5, `bus_wait` description)

**Approach:**
- Mirror `makeBusStatus`: accept `sessionIds` (array) + optional `timeoutMs`, call `wait()`, throw on `ok:false` (plugin) / `isError` (MCP), format the snapshot via `formatWait`.
- Register in `src/index.ts` and `src/mcp.ts` from the same `BUS_WAIT_DESCRIPTION` + core call so descriptions/output stay byte-identical (the two-surface-parity invariant).
- `formatWait` renders the per-session normalized state + waker(s) + timedOut, reading the enum identically to `formatStatus`.

**Patterns to follow:** `src/tools/bus_status.ts` (`makeBusStatus`), `src/mcp.ts` existing registrations, `src/format.ts` `formatStatus`.

**Test scenarios:**
- Happy path: `bus_wait` tool returns a formatted snapshot with per-session state and waker.
- Parity: the plugin tool and MCP registration produce byte-identical description + output for the same input (extend the existing parity test).
- Error path: `wait()` returns `ok:false` → plugin tool throws, MCP returns `isError` (no raw context leak).
- Format: `formatWait` renders `running`/`blocked` (with question)/`complete`/`failed`/`not_found` and the `timedOut` case.

**Verification:** `bus_wait` works on both surfaces with identical description/output; parity test passes; the tool count is 5 in docs.

- [ ] **Unit 5: Changeset + docs**

**Goal:** Ship-ready release metadata and updated docs.

**Requirements:** (release hygiene)

**Dependencies:** Unit 4

**Files:**
- Create: `.changeset/async-delegation-foundation.md` (minor — new tool + new exported contract)
- Modify: `README.md`, `AGENTS.md` (if not fully covered in Unit 4)

**Approach:** Minor changeset describing the normalized state enum + `bus_wait`; note push-notify is a deferred follow-on. Update the tool inventory and any two-surface/parity notes.

**Test scenarios:** Test expectation: none — release metadata + docs.

**Verification:** `changeset status` shows a minor bump; docs list five tools and the new `/core`+`/contract` state export.

## System-Wide Impact

- **Interaction graph:** `bus_wait` (tool + MCP) → core `wait()` → `findSessionDirectory` + `/session/status` + `/question` + `deriveSessionState`. `status()` and `snapshot()` also route through `deriveSessionState` — a change to derivation affects all three (that's the point; parity).
- **Error propagation:** core stays never-throw; per-session resolution/read failures become `not_found`/`failed` states, not call failures; tool adapters convert `ok:false` to a thrown error (plugin) / `isError` (MCP).
- **State lifecycle risks:** none persistent — `bus_wait` holds no state between calls; the only in-call risk is an unbounded wait, mitigated by the owned deadline + concurrency bound.
- **API surface parity:** the two-surface-parity invariant now covers five tools; the browser-safety CI guard must still pass with the new `contract.ts` enum (zod-only, no Node deps); the new `/core`+`/contract` export widens the library surface.
- **Unchanged invariants:** `bus_task` dispatch/steering, roster, diff machinery, managed-server lifecycle, the localhost guard, and `bus_status`'s existing output fields (state added additively) are unchanged.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Long-poll adds latency vs event-driven SSE | Bounded poll interval tuned against live harness; SSE deferred as an optimization if latency proves inadequate. Level-triggering means an already-done session returns on the first poll. |
| A long `bus_wait` exceeds an MCP-facade call timeout (Claude Desktop) | Default `timeoutMs` capped below the facade ceiling (verified at implementation); timeout returns a snapshot, not an error, so a re-wait is cheap. |
| `deriveSessionState` precedence wrong (e.g. blocked vs complete) | Precedence pinned test-first in Unit 1 before any emitter wires to it. |
| Enum change breaks `bus_status` output for existing callers | `state` added additively; existing fields unchanged; verified against `formatStatus` + existing tests. |
| Unbounded concurrent waits pin resources | Per-call fan-out concurrency bound + a wait cap (R9); each poll keeps `api`'s 30s per-request abort. |
| New long-lived-ish poll path bypasses loopback guard | R10 re-validates the resolved endpoint against the loopback guard before each request; fail closed. |

## Documentation / Operational Notes

- README: add `bus_wait` to the tool list (5 tools), document the `sessionIds`+`timeoutMs` contract, the normalized state enum, and that push-notify is a deferred follow-on.
- AGENTS.md: update the two-surface-parity invariant and tool inventory for the fifth tool; note the new `/core`+`/contract` state export.
- Note the exit contract for callers: `bus_wait` returns on first-needs-attention or timeout; the caller owns its retry budget on repeated all-`running` timeouts.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-10-async-delegation-requirements.md](docs/brainstorms/2026-07-10-async-delegation-requirements.md)
- Related code: `src/core.ts` (`status`, `snapshot`, `fetchPendingQuestion`, `findSessionDirectory`, `api`, `validateContext`), `src/contract.ts`, `src/tools/bus_status.ts`, `src/mcp.ts`, `src/format.ts`
- Related research: `docs/ideation/2026-07-04-mothership-support-ideation.md`; OpenCode `/event` SSE directory-scoping + protocol quirks (project memory)
- Related learning: `docs/solutions/best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md`
