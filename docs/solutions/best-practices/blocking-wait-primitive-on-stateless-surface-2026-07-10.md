---
title: Blocking-wait primitive on a stateless, multiplexed tool surface
date: 2026-07-10
category: best-practices
module: space-bus
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - building a "block until X changes" primitive on a stateless tool/plugin surface with no persistent process to hold state
  - a single tool call must return a final answer rather than stream events to a caller that can't hold a subscription
  - each poll must re-apply a security check and tolerate partial failure without failing the whole call
  - multiple emitters must report the same derived state and must not drift
tags:
  - stateless
  - long-poll
  - wait-primitive
  - level-triggered
  - sse
  - bus-wait
  - never-throw
  - forward-compat-enum
---

# Blocking-wait primitive on a stateless, multiplexed tool surface

## Context

space-bus dispatches work to per-project agents over a shared harness server and, until 0.9.0, a control agent had no way to *wait* for a delegated session — it polled `bus_status` in a loop, inferring completion from `busy`/`blocked` flags. The ask was a `bus_wait` tool: block until any watched session needs attention (completes, blocks on a question, fails, or vanishes) or a timeout elapses.

The hard constraint: space-bus tools are **stateless HTTP clients**. There is no persistent plugin process holding promises or subscriptions between calls — a tool call runs, returns, and its state is gone. The natural "async" shape from other systems (a long-lived event subscription plus an in-memory task registry, e.g. `opencode-copilot-delegate`'s `completionPromise` + `client.session.prompt` notify trick) does not transfer: there is nowhere for that state to live, and the MCP facade has no session to notify into. This doc captures the patterns that made a robust blocking wait possible *without* persistent state.

## Guidance

### 1. Bounded long-poll over SSE when the surface is stateless

Source the "block" from the **latency of a single tool call**, not a persistent connection. The wait is a loop that re-reads current state, sleeps a bounded interval, and returns when a wake condition is met or the deadline passes:

```ts
while (true) {
  await mapWithConcurrency(groupList, DEFAULT_WAIT_CONCURRENCY, pollGroup);
  const sessions = uniqueIds.map((id) => lastKnown.get(id)!);
  const waker = sessions
    .filter((s) => NEEDS_ATTENTION_STATES.includes(s.state))
    .map((s) => s.sessionId);
  if (waker.length > 0) return { ok: true, sessions, waker, timedOut: false };
  if (Date.now() >= deadline) return { ok: true, sessions, waker: [], timedOut: true };
  const remaining = deadline - Date.now();
  await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
}
```

**Why SSE was rejected here** (a design decision, not a code artifact): OpenCode's `/event` SSE stream is directory-scoped, carries no wire-level event id, and requires full-state reconciliation on every reconnect. A long-lived connection also fights the multiplexed shared-server model (one server, many per-directory consumers). A stateless long-poll keeps every existing invariant — per-call context validation, loopback guard, never-throw — intact by construction, at the cost of latency granularity (the poll interval). For an agent-facing tool where the alternative is a busy poll loop anyway, that trade is strongly positive.

### 2. Level-triggered wake, not edge-triggered

Each poll reads the *current* normalized state, so an already-finished session wakes on the **first** poll — there is no "subscribe after the event already fired" miss:

```ts
const NEEDS_ATTENTION_STATES: SessionState[] = ["complete", "blocked", "failed", "not_found"];
// ...wake if ANY watched session is currently in one of these states
```

Edge-triggered designs (wait for a *transition*) have a classic bug: if the session completed before the wait started, the transition never arrives and the caller hangs to timeout. Level-triggering eliminates that whole failure class.

### 3. Own your deadline, independent of the per-request timeout

The shared HTTP helper `api()` hard-codes `AbortSignal.timeout(30_000)` per request. The wait loop must own a **separate** total deadline — a single poll is bounded by 30s, but the loop keeps issuing fresh polls until `timeoutMs` total:

```ts
const deadline = Date.now() + timeoutMs;   // owned by the loop, not by api()
```

Be honest that it's a **soft** deadline: if a poll request is mid-flight when the deadline passes, the call can overshoot by up to the per-request bound (~30s). Say so in the tool description rather than implying a hard cap. Clamp absurd values (`Math.min(timeoutMs, MAX_WAIT_TIMEOUT_MS)`) so a caller can't pin an MCP call open indefinitely.

### 4. Never throw; degrade gracefully per unit

One bad session or one unreachable directory must not fail the whole wait:

```ts
if (!statusRes.res.ok) return;               // failed poll: keep last-known state
try {
  statusMap = sessionStatusMapSchema.parse(JSON.parse(statusRes.bodyText));
} catch {
  return;                                     // unparseable poll: same — no throw, no fabricated change
}
```

- A failed/unparseable poll for a directory **keeps its sessions at last-known state** — it never throws, loops forever, or invents a transition.
- An unresolvable session id is seeded as a permanent `not_found` (`state: loc ? "running" : "not_found"`) which is itself a needs-attention state, so a bad id **wakes** the caller rather than hanging or erroring it.
- The function returns a discriminated-union `Result`; timeout is `{ ok: true, timedOut: true }`, **not** an error.

### 5. Keep the state enum closed *and* forward-compatible

The normalized enum ships all five states even though `failed` has no wire signal yet:

```ts
export const sessionStateSchema = z.enum([
  "running", "blocked", "complete", "failed", "not_found",
]);
```

`failed` is unreachable in production today (the `/session/status` shape exposes no errored/aborted signal — an honest, documented deferral). It stays in the enum anyway because **adding a variant to a closed union later is a breaking change** for consumers doing exhaustive pattern-matching. Reserving the state now makes wiring detection later a non-breaking, additive change. Document the reserved-but-unreached state so a reviewer doesn't mistake it for dead code (and so `NEEDS_ATTENTION_STATES` staying in sync with the enum is a conscious contract).

### 6. Derive the normalized state exactly once

`deriveSessionState` is the single derivation, called identically by `status()`, `snapshot()`, and `wait()` so three emitters cannot diverge:

```ts
export function deriveSessionState(input): SessionState {
  if (!input.resolved) return "not_found";
  if (input.failed) return "failed";
  if (input.pendingQuestion) return "blocked";
  if (input.busy) return "running";
  return "complete";
}
// precedence: not_found > failed > blocked > running > complete
```

Pin the precedence with a truth-table test and add a cross-emitter parity test (the state `wait()` reports for a session equals what `status()` reports for it). Without the single-derivation discipline, the three surfaces drift the first time someone tweaks one.

## Why This Matters

- **Stateless surfaces can't hold subscriptions.** A long-poll within one call is the only shape that keeps a stateless tool stateless; reaching for SSE re-introduces connection ownership the surface doesn't have.
- **Level-triggering removes the "already done" hang** — the single most common wait bug.
- **Owning the deadline** decouples wait semantics from transport/request timeouts, so a slow request can't silently cap or blow the caller's intended budget.
- **Per-unit graceful degradation** means one bad id or one down directory returns partial truth instead of failing the batch — essential when a single call watches sessions across projects.
- **Closed enum + single derivation** prevents the slow drift that makes multi-emitter state untrustworthy.

## When to Apply

- Any "wait until X changes" primitive on a **stateless** HTTP tool, MCP/plugin surface, or multiplexed shared server.
- Any case where **one call must return a final answer**, not stream events to a caller that can't hold a subscription.
- Any normalized status/state value emitted by **more than one** code path.

Do **not** reach for this when you genuinely own a persistent process and a durable connection — then a real event subscription with reconnect/replay may beat polling on latency. The trade flips with statefulness.

## Examples

- **Good:** `bus_wait(["ses_a","ses_b"])` — `ses_a` is already `complete` at entry, so the first poll wakes immediately with `waker: ["ses_a"]` and a full snapshot of both.
- **Good:** one directory's `/session/status` returns 500 for the whole wait — the call still returns the other directory's sessions with fresh state, and the failing directory's sessions stay at last-known `running` until the (soft) deadline.
- **Good:** `timeoutMs: 600_000` requested → clamped to `MAX_WAIT_TIMEOUT_MS` (5 min); returns a timeout **snapshot** (`ok: true, timedOut: true`), not an error.
- **Bad:** an SSE subscription with reconnect bookkeeping for a tool that has no persistent process to own the connection — re-introduces exactly the state the surface was designed not to keep.

## Related

- `docs/solutions/best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md` — the neighboring polling pattern (spawn readiness: per-request timeout + a caller-owned overall budget). Same "own your budget" spine, different problem (server startup, not agent-facing wait).
- `docs/solutions/best-practices/browser-safe-library-boundary-cut-2026-07-04.md` — the never-throw + per-call `validateContext` boundary discipline `wait()` inherits.
- `docs/solutions/best-practices/browser-safe-discovery-contract-parity-2026-07-05.md` — the "one contract, multiple implementations, pin them with a parity test" discipline, mirrored here as one state derivation across three emitters.
- `docs/solutions/integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md` — adjacent caution that a server surface can report empty/stale where you expect data; probe the real shape before concluding.
- Issue #49 — the parent async/lifecycle thread (daemon supervision); adjacent context, not the canonical home for the wait primitive.
