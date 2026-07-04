---
"@fro.bot/space-bus": patch
---

Replace the `DispatchArgs` casts in both adapters with a shared `toDispatchArgs` validator, and add an end-to-end test asserting the built `space-bus-mcp` reports the injected package version.

Observable behavior change: argument-shape errors (missing `project`, empty `sessionId`) now surface before roster/config resolution errors, so a bad-args call on a machine with no roster reports the args problem instead of the config problem.
