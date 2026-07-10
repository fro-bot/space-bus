---
"@fro.bot/space-bus": patch
---

Fix: Node-side resolvers now clean up stale managed-daemon discovery records. When a managed daemon dies by crash or host-process exit (not an explicit `stop`), its `discovery.json` was left pointing at a dead pid, so attachers kept dialing a dead port. Resolvers now remove the stale record on a dead-pid read, via compare-and-delete so a concurrent respawn's fresh record is never deleted.
