---
"@fro.bot/space-bus": patch
---

Replace the `DispatchArgs` casts in both adapters with a shared `toDispatchArgs` validator, and add an end-to-end test asserting the built `space-bus-mcp` reports the injected package version.
