---
"@fro.bot/space-bus": patch
---

Fix: managed-server stop now signals the process group so the opencode child spawned by the harness wrapper is torn down too — previously `stop` killed only the wrapper and leaked the child (still holding the port). Readiness-failure and orphan-reap kills cascade to the group as well.

Hardening: `stopServer` no longer treats an EPERM from the group signal as a successful stop — the server is still alive and its discovery credentials are preserved instead of being discarded. Discovery/lock/provisional pid fields now reject 0/1 (`min(2)`), and `signalGroup` itself refuses to issue a group-form signal for pid<=1, closing off `process.kill(-1, sig)`/`process.kill(-0, sig)` footguns from a tampered or malformed record. The no-identity fallback in `killIdentifiedProcess` (used when identity capture failed) now bare-kills instead of group-signaling, so a recycled pid can't cascade a SIGTERM to an unrelated process's entire subtree.
