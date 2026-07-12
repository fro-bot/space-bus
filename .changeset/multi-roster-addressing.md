---
"@fro.bot/space-bus": minor
---

Per-call roster addressing and the `bus_registry` management tool (multi-roster Phase B).

All five `bus_*` tools accept an optional `roster` parameter (a registry name from `@fro.bot/space-bus/registry`) to target any registered roster instead of the ambient workspace/`SPACE_BUS_CONFIG` resolution — and every tool result now opens with a `roster:` header naming the roster it resolved, so cross-roster calls are always visible. A sixth tool, `bus_registry`, manages the machine's roster registry from both surfaces: list rosters, create a roster in-app, register/unregister/set-default, and add/remove/update roster projects. On the MCP surface, `bus_registry use` selects a session-active roster (ephemeral, per connection) that omitted-`roster` calls resolve to; plugin calls remain workspace-directory-first.
