---
"@fro.bot/space-bus": patch
---

Fix: managed-server stop now signals the process group so the opencode child spawned by the harness wrapper is torn down too — previously `stop` killed only the wrapper and leaked the child (still holding the port). Readiness-failure and orphan-reap kills cascade to the group as well.
