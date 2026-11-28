---
"@fro.bot/space-bus": minor
---

Breaking for direct importers: replace `await plugin(input)` with `await plugin.server(input)` for v1 hooks. The package root and `/server` now export the same plugin object for OpenCode v1 and v2. If OpenCode loads the plugin for you, no configuration change is needed.
