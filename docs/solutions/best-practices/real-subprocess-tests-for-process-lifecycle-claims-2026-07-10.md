---
title: Seam-injected tests can't prove process-level lifecycle claims — use a real subprocess
date: 2026-07-10
category: best-practices
module: space-bus
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - the change's value proposition is about process behavior (exit latency, signal handling, timer/handle cleanup, event-loop draining)
  - the test suite injects a clock/sleep/timer seam and never touches a real timer or process
tags:
  - testing
  - subprocess
  - signal-handling
  - event-loop
  - lifecycle
  - negative-control
---

# Seam-injected tests can't prove process-level lifecycle claims — use a real subprocess

## Context

`space-bus serve --foreground` supervises a managed daemon in a poll loop. To restore instant Ctrl+C shutdown, the inter-tick sleep was made "interruptible" — a signal races the sleep so the loop breaks immediately instead of waiting out the 5s interval. Every `superviseServer` unit test injected a `sleep: noop` seam, so the suite (196 tests) and a 7-persona review both passed, and the PR *claimed* the latency class was fixed. It wasn't: the fix worked at the promise level but not the process level. Fro Bot caught it with a real subprocess reproduction — the daemon died in ~23ms but the CLI process lingered ~4.97s (exactly one poll interval).

## Guidance

When a fix's value proposition is about **process behavior** — exit latency, signal handling, timer/FD/handle cleanup, event-loop draining — a seam/mock-injected unit test cannot verify it. Injecting the clock or sleep proves the *logical* path (the await resolved) while hiding the *real* resource (the OS timer that keeps the event loop alive). Add a real-subprocess test that measures the observable itself: wall-clock exit time, alive/dead pid, leaked handle count. **Negative-control it** — confirm it fails against the pre-fix code, or it isn't a regression guard.

## Why This Matters

The bug was a classic mock-lies-to-you: `interruptibleSleep` raced `doSleep(intervalMs)` against the interrupt, but the real `sleep` is a bare `setTimeout(resolve, ms)` with no cancellation. When the interrupt won the race, the losing `setTimeout` stayed registered on the event loop and held the process open until it fired naturally — up to the full interval. The injected `noop` sleep had nothing to leak, so no seam-driven test could ever see it. Only a test that spawns the real process and measures real exit time exercises the timer that actually matters. A green seam-suite gave false confidence precisely on the claim the PR was built to deliver.

## When to Apply

- Any change to SIGINT/SIGTERM handling, graceful shutdown, or "the process exits promptly."
- Timers, intervals, and anything that must be `clearTimeout`/`clearInterval`/`unref`'d to let the loop drain.
- Child-process lifecycle (spawn/kill/reap), where a single-process fixture can't model the real topology.

## Examples

The trap — a bare, uncancellable timer behind an injectable seam (`src/server.ts`):

```ts
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
// interruptibleSleep raced Promise.race([doSleep(intervalMs), interrupt]) —
// when interrupt won, doSleep's setTimeout was never cleared and kept the
// event loop alive up to intervalMs after a clean SIGINT.
```

The fix — own the timer and reclaim it so the loop can drain:

```ts
let timer: ReturnType<typeof setTimeout> | undefined;
const timed = new Promise<void>((resolve) => { timer = setTimeout(resolve, intervalMs); });
try {
  await Promise.race([timed, interrupt]);
} finally {
  if (timer !== undefined) clearTimeout(timer);
}
```

The guard that actually catches it — a real subprocess measuring wall-clock exit (`src/cli.test.ts`):

```ts
const proc = Bun.spawn(["bun", "run", CLI_PATH, "serve", "--foreground"], { /* stub roster, isolated XDG_STATE_HOME */ });
// ...wait for the "server running at" readiness line...
const t0 = performance.now();
proc.kill("SIGINT");
await proc.exited;
expect(performance.now() - t0).toBeLessThan(2000); // negative control: 4989ms broken → ~190ms fixed
```

The negative control is the proof it guards the regression: reverting `interruptibleSleep` to the bare-race form makes this test fail at ~4989ms (one poll interval), and the fix drops it to ~190ms.

## Related

- [../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md](../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md) — the concrete precedent: a single-process test stub couldn't model the wrapper/child process group, hiding a stop-path leak. Same lesson, different resource (process topology vs. event-loop timer).
- [../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md](../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md) — the review-side companion: a green mock-suite is exactly the "claim" that needs a ground-truth (real-process) check before you trust it.
