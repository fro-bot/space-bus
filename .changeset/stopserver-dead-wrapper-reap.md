---
"@fro.bot/space-bus": patch
---

Fix: `stopServer` now reaps a surviving orphaned child when the recorded managed wrapper has already died (identity verification fails). Previously this branch cleaned up the discovery record but never reaped the process group, leaking the wrapper's `opencode` child (still holding its port) whenever the wrapper died alone before a stop was requested. This brings the dead-wrapper branch to parity with the existing supervision died-path reap, reusing the same guarded `reapSurvivingGroup` (no-op for a live/recycled leader; no-op if the whole group is already dead). `stopServer`'s return value is unchanged (`stopped: false`) — reaping an orphan is best-effort cleanup, not a verified stop.
