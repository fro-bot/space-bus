---
"@fro.bot/space-bus": patch
---

Fix: `space-bus serve --foreground` now reaps a surviving daemon child on the supervision death path. The managed daemon is a `harness` wrapper plus an `opencode` child in the same process group; when the wrapper died but the child survived, the supervisor exited fail-closed without signaling the group, leaving the child orphaned and holding its port. The death path now group-signals the surviving members before exiting, guarded so it never signals a process that recycled the wrapper pid (it fires only when the leader is dead and its group is still alive, which cannot be a recycled pgid).
