---
"@fro.bot/space-bus": patch
---

Remap the `./server` subpath to the plugin entry. OpenCode's plugin loader resolves `exports["./server"]` before falling back to `main`, so the managed-server lifecycle API previously published there broke plugin loading with `TypeError: Plugin export is not a function`. Affects versions 0.6.0–0.9.0 when loaded as an npm plugin. The managed-server lifecycle API (`ensureServer`/`serverStatus`/`stopServer`) moves to `@fro.bot/space-bus/managed-server`.
