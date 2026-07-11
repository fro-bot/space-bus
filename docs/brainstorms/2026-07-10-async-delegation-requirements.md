---
date: 2026-07-10
topic: async-delegation
---

# Asynchronous Delegation for Space Bus

## Summary

Give the dispatching agent a first-class way to track delegated bus work instead of hand-rolling status-inference loops. This is the first step of an asynchronous-delegation arc whose end state is both a blocking wait and fire-and-forget notification. **0.9.0 ships the foundation: the blocking wait + normalized state.** A **normalized state enum** on `bus_status` (`running | blocked | complete`, plus failed/`not_found` states and a "result available" signal) lets callers stop inferring state from raw `busy`/`blocked` fields, and a new **`bus_wait`** tool blocks — for the duration of a single tool call, driven by the harness event stream — until any watched session needs attention (completes, blocks on a question, or fails). This replaces a busy-poll loop with a single call that wakes on the right event; it does not yet let the agent dispatch and move on. That last piece — **fire-and-forget push-notification**, the capability that makes delegation fully asynchronous — is a deferred, plugin-only follow-on.

---

## Problem Frame

A control agent that delegates work to per-project sessions via `bus_task` has no efficient way to learn when that work is done or stuck. Today it must:

- call `bus_status` in parallel across known session IDs,
- infer state from `busy`/`blocked` fields (`busy:false` → try `bus_result`; `busy:true` + a pending question → answer via `bus_task`; `busy:true` otherwise → leave it and remember to re-check),
- and re-poll on its own initiative, because nothing tells it when something changed.

Two costs fall out of this. First, the caller re-derives a state machine on every check from low-level fields, and different callers will infer it differently. Second — the sharper pain — a delegate that **blocks on a question stalls silently**: the caller only discovers it by polling again, so headless multi-delegate flows either busy-loop or leave a blocked delegate waiting indefinitely. An agent asked directly for the fix named it precisely: a normalized state enum plus a `bus_wait` / `bus_watch(sessionIds[])` primitive.

This matters more now that space-bus is a library (`/core`, `/contract`, `snapshot()`) that external consumers like Mothership build on: the "how do I know a delegate is done?" question is being answered ad hoc by every consumer.

---

## Actors

- A1. Dispatching agent: the control agent (or Mothership, or an MCP client) that delegates via `bus_task` and needs to know when delegated sessions finish or block. The primary beneficiary.
- A2. Delegate session: a per-project session running on the harness/opencode server, doing the delegated work. Emits lifecycle changes on the server's event stream.
- A3. Harness server: the `harness serve` / `opencode serve` instance whose `/event` SSE stream and per-session status endpoints are the source of truth for session state.

---

## Key Flows

- F1. Wait for the first delegate to need attention (0.9.0 core)
  - **Trigger:** A1 has dispatched one or more sessions and calls `bus_wait` with their IDs.
  - **Actors:** A1, A2, A3
  - **Steps:** `bus_wait([ids], timeout)` → observes session state via the harness → blocks while all watched sessions are still `running` → returns as soon as any one becomes `complete` or `blocked`, carrying that session plus a snapshot of every watched session's current state → A1 acts on the ready one (fetch result / answer question) and re-waits on the rest.
  - **Outcome:** A1 makes progress on exactly the session that needs it, with no busy-loop and no silent stall. A bounded timeout returns the current snapshot without waking.
  - **Covered by:** R4, R5, R6, R7

- F2. Answer a blocked delegate and continue (0.9.0)
  - **Trigger:** `bus_wait` returns a session in state `blocked`.
  - **Actors:** A1, A2
  - **Steps:** A1 reads the pending question from the returned state → answers via `bus_task(sessionId, ...)` (existing steering contract) → re-issues `bus_wait` including that session again.
  - **Outcome:** The blocked-delegate stall is resolved in a tight loop instead of by chance polling.
  - **Covered by:** R2, R5

- F3. Fire-and-forget with later notification (deferred, plugin-only)
  - **Trigger:** A1 dispatches and does NOT want to hold a call open; it wants to be told later.
  - **Actors:** A1, A2
  - **Steps:** A background watcher (a capability space-bus does not have today) observes the session and, on completion/block, pushes a notification into A1's session.
  - **Outcome:** A1 is interrupted with the news rather than waiting. Explicitly out of scope for 0.9.0 — see Scope Boundaries.
  - **Covered by:** (deferred)

---

## Requirements

**Normalized state (0.9.0)**
- R1. A single normalized state enum represents a delegate session's lifecycle for callers: at minimum `running`, `blocked`, and `complete`, plus defined members for a session that has **failed/aborted** and one whose **ID does not resolve** (`not_found`) — so a wait can never hang or be poisoned waiting for a transition that will never come. The enum is the caller-facing contract, not raw `busy`/`blocked` fields; exact member spelling is settled in planning.
- R2. The state carries enough for the caller to act without a second inference step: whether a result is available to fetch (`complete`), and when `blocked`, the pending question (text + options) that must be answered.
- R3. The enum is a shared contract, not a `bus_status`-only output detail: `bus_status`, the new `bus_wait`, and the library `snapshot()` emit the same enum, and it is exported on the browser-safe `/core` + `/contract` surface so library consumers (Mothership) depend on one definition.

**Blocking wait (0.9.0)**
- R4. A new `bus_wait` tool accepts one or more session IDs and a bounded timeout, and blocks until a wake condition is met or the timeout elapses. It is the fifth bus tool, distinct from `bus_status` (instant snapshot) by verb.
- R5. The wake condition is "needs attention" — a watched session in `complete`, `blocked`, or a failed/`not_found` state. A session merely still `running` does not wake the wait. Wake is **level-triggered, not edge-triggered**: `bus_wait` returns immediately if any watched session is *already* in a needs-attention state at entry, not only on a transition observed during the call.
- R6. On wake, `bus_wait` returns a snapshot of the current normalized state of every watched session, with the needs-attention session(s) identified: at minimum one `waker` plus the set of all sessions already in a needs-attention state, so a caller can drain every ready session in one call. One call always makes progress.
- R7. On timeout, `bus_wait` returns the current snapshot of all watched sessions without having woken — an actionable state read, not an error. A caller that re-waits on an unchanged all-`running` snapshot is responsible for its own retry budget; `bus_wait` does not itself detect a genuinely-stuck delegate (it has no question and no completion to wake on), so the doc makes that the caller's policy rather than a hidden guarantee.
- R11. `bus_wait` does not use the shared `api()` 30s abort choke point: either its default wait bound is capped below 30s, or the wait path uses a dedicated long-lived request/stream that is not hard-aborted at 30s. The bound is explicit and chosen so the wait cannot die mid-wait on a slow-but-healthy session.
- R12. Cross-directory waits have one defined behavior, chosen in planning from exactly two options (no third): either group the watched session IDs by their resolved project directory and observe one stream/poll per directory, or reject a mixed-directory `bus_wait` with a clear actionable error. This is load-bearing because the harness `/event` SSE stream is directory-scoped; leaving it open produces divergent implementations.
- R8. `bus_wait` holds no persistent plugin state between calls: the wait lives entirely within the single tool call, sourced from the harness's live session state/event stream. Each call is independent and reconstructs what it needs.
- R9. `bus_wait` works over BOTH surfaces — the plugin tool map and the stdio MCP facade — with byte-identical description and output (two-surface parity).

**Cross-cutting**
- R10. All new behavior honors the existing invariants: core returns discriminated unions (never throws across the boundary), the localhost guard holds, no telemetry / off-machine calls, and directory-routing via `ctx.directory` is preserved.
- R13. The wait path re-validates its resolved endpoint against the loopback guard before opening the auth-bearing connection — the new long-lived stream/poll is a new trust boundary and must fail closed on a non-loopback endpoint exactly as `config.ts`/core do, so Basic-auth credentials can never flow off-machine over a tampered stream URL.
- R14. A single unresolvable or failed session ID is reported inline as that session's state (`not_found`/failed) and does not fail the whole `bus_wait` call — one bad ID never poisons the wait on the rest. `bus_wait` also bounds concurrent/long-held waits so a caller cannot pin unbounded tool-call slots and stream connections (the exact cap is a planning detail; that there is one is a requirement).

---

## Acceptance Examples

- AE1. **Covers R4, R5, R6.** Given three dispatched sessions where one is `running`, one has just gone `complete`, and one is `blocked`, when the agent calls `bus_wait([a,b,c], 60s)`, then it returns immediately (something already needs attention) with the complete-or-blocked session identified and all three sessions' normalized states in the snapshot.
- AE2. **Covers R5.** Given all watched sessions are `running`, when a watched session then blocks on a question mid-call, then `bus_wait` wakes and returns that session in state `blocked` with the pending question, before the timeout.
- AE3. **Covers R7.** Given all watched sessions stay `running` for the whole timeout, when `bus_wait([ids], 10s)` times out, then it returns the current snapshot of all watched sessions (all `running`) without an error.
- AE4. **Covers R2.** Given a session in state `complete`, when the caller inspects the returned state, then it can tell a result is available and proceed to `bus_result` without re-inferring from `busy`.
- AE6. **Covers R5 (level-triggered).** Given a watched session that was already `complete` before `bus_wait` was called, when the agent calls `bus_wait([id], 60s)`, then it returns immediately rather than blocking for a transition that already happened.
- AE7. **Covers R14.** Given a `bus_wait` over three IDs where one ID no longer resolves to any session, when the call runs, then that ID is reported inline as `not_found` and the wait proceeds normally on the other two — the bad ID does not error the whole call.
- AE8. **Covers R12.** Given watched sessions that resolve to two different project directories, when `bus_wait` is called, then the implementation's one defined cross-directory behavior applies (group-by-directory observation, or a clear mixed-directory rejection) — never silently missing one directory's events.
- AE5. **Covers R3, R9.** Given the MCP facade (Claude Desktop), when a client reads a session's state via `bus_status` and via `bus_wait`, then both report the same normalized enum as the plugin surface does.

---

## Success Criteria

- A dispatching agent can replace its hand-rolled "parallel bus_status → infer busy/blocked → maybe bus_result → remember to re-check" loop with: `bus_wait` → act on the returned session → re-wait. No busy-loop, no silently-stalled blocked delegate.
- Callers (including library consumers) branch on one normalized enum rather than re-deriving state from `busy`/`blocked` — and all three emitters agree.
- A downstream planner can implement the enum and `bus_wait` for 0.9.0 from this doc without inventing the wake semantics, the multi-session return shape, or the parity/statelessness constraints, and can see exactly what push-notify defers.

---

## Scope Boundaries

- 0.9.0 ships the normalized state enum + `bus_wait` (blocking wait). Progressive delivery toward 0.9.0; the enum and `bus_wait` may land in sequence.
- No persistent plugin process, background watcher, or in-memory task registry — space-bus stays a stateless HTTP client; the wait lives within a tool call.
- No new dispatch tool and no change to the `bus_task` dispatch/steering contract — `bus_wait` observes; answering a blocked delegate still goes through `bus_task`.
- No separate `bus_watch` board tool — one wait primitive (`bus_wait`), not two.
- No change to the managed-server lifecycle, roster, or diff machinery.

### Deferred to Separate Tasks

- **Fire-and-forget push-notification** (F3): dispatch, then get notified later when a task completes/blocks. Deferred beyond 0.9.0, and when built it is **plugin-only** — it needs a background watcher that outlives the tool call and a channel to push into the caller's session (the model `opencode-copilot-delegate` uses via `client.session.prompt`). The stdio MCP facade has no session to push into, and OpenCode does not surface MCP progress mid-`tools/call`, so push-notify cannot reach two-surface parity. Tracked as an explicit follow-on release, not part of the 0.9.0 line.
- Cancellation of a running delegate from the dispatcher (a `bus_cancel`-style primitive) — adjacent, not requested here.

---

## Key Decisions

- Blocking-wait first, push-notify deferred: blocking wait fits space-bus's stateless HTTP-client nature (block = tool-call latency over the harness event stream) and reaches both surfaces; push-notify needs machinery space-bus lacks and cannot reach two-surface parity. Both modes remain the end state, sequenced. 0.9.0 is honestly the *foundation* of async delegation (a smarter wait that replaces the busy-poll loop), not the fire-and-forget capability — `bus_wait` still holds the caller's turn; only the deferred notify lets the agent dispatch and move on.
- Wake on complete-OR-blocked: a blocked delegate is exactly as actionable as a finished one; waking on both is what actually fixes the silent-stall pain, matching the caller's real branch logic.
- First-to-attention + full snapshot (not wait-for-all): a Promise.race shape means one slow delegate can't stall the batch and every call makes progress; the snapshot lets the caller drain everything already ready.
- `bus_wait` as a new fifth tool (not a `bus_status` overload): wait and snapshot-now are distinct verbs; overloading `bus_status` with a long-blocking mode and variadic sessions muddies a clean instant-read tool. This grows the surface past the 4-tool line, justified by a genuinely new capability (contrast: `bus_reply` was folded into `bus_task` because it was the same verb).
- State enum as a shared `/core` + `/contract` contract: one definition consumed by `bus_status`, `bus_wait`, and `snapshot()`, so library consumers and both tool surfaces never diverge.

---

## Dependencies / Assumptions

- The harness/opencode server exposes live session state usable within a single tool call — a `/event` SSE stream that is directory-scoped and carries session lifecycle + `question.asked`/`question.replied`, plus the per-session status/question endpoints `bus_status` already uses. (Assumed from prior integration knowledge; the exact wait mechanism — long-poll on status vs. consume the SSE stream for the call's duration — is a planning decision to verify against the live server.)
- The space-bus plugin factory currently captures only `input.directory` and discards the rest of `input` (including the OpenCode `client`). Blocking wait does not need the client; push-notify (deferred) would.
- Existing browser-safety CI guard and two-surface parity tests extend to the new enum and `bus_wait`.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R11][Technical] Wait mechanism: consume the harness `/event` SSE stream for the call's duration vs. a bounded long-poll loop over `/session/status` + `/question`. Verify against the live server which is reliable and cheap, honoring the R11 no-30s-abort and R12 cross-directory constraints.
- [Affects R1][Technical] Exact member spelling of the enum (e.g. `failed` vs `error`, `not_found` vs `unknown`) and how a failed/aborted session is distinguished from a blocked one on the wire — the *set* of states is fixed by R1/R5; only the spelling is open.
- [Affects R6][Technical] Concrete return shape of the multi-session snapshot (per-session normalized state + the `waker`/ready set) and how it reconciles byte-for-byte with the existing `bus_status` output so the enum reads identically in both.
- [Affects R11, R14][Needs research] Whether the stdio MCP facade (Claude Desktop) imposes its own tool-call timeout shorter than the intended wait bound — bound the default wait accordingly — and the concrete concurrent-wait cap for R14.
- [Affects R12][Needs research] Whether the harness `/event` stream supports server-side idle/read timeouts, so a long-held wait connection can't be pinned open indefinitely.
