---
"@fro.bot/space-bus": minor
---

Add asynchronous-delegation foundation: a normalized session-state enum and the `bus_wait` tool.

- **Normalized state enum** (`running | blocked | complete | failed | not_found`) plus a `resultAvailable` signal, derived once in core (`deriveSessionState`) and emitted identically by `bus_status`, the library `snapshot()`, and `bus_wait` — callers no longer infer state from `busy`/`blocked`. Exported on the `/core` and `/contract` subpaths (`SessionState`, `SessionStateInfo`).
- **`bus_wait`** (fifth tool, both plugin and MCP surfaces): blocks until any watched session needs attention (completes, blocks on a question, fails, or is not found) or a bounded timeout elapses, then returns each session's normalized state plus which session(s) woke the wait. Level-triggered, stateless (a bounded long-poll within the single call), watches sessions across directories, and never throws across the boundary. Replaces the poll-`bus_status`-in-a-loop pattern with one call that makes progress.

Fire-and-forget push notification (get notified as tasks complete without holding a call open) is a deferred follow-on — this release delivers the blocking-wait foundation and the shared state contract it builds on.
