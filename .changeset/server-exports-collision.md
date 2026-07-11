---
"@fro.bot/space-bus": minor
---

Remap the `./server` subpath to the plugin entry: OpenCode's plugin loader resolves `exports["./server"]` before `main`, so the managed-server lifecycle API published there broke plugin loading with `Plugin export is not a function` (affects 0.6.0–0.9.0 when loaded from npm). The lifecycle API (`ensureServer`, `serverStatus`, `stopServer`, `superviseServer`, …) moves to `@fro.bot/space-bus/managed-server`.

**Migration:** direct importers of `@fro.bot/space-bus/server` must switch to `@fro.bot/space-bus/managed-server` before upgrading — after this release, `/server` resolves to the plugin factory and the old lifecycle imports fail silently (missing properties), not with an error.
