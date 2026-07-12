---
"@fro.bot/space-bus": minor
---

Per-call roster addressing and the `bus_registry` management tool (multi-roster Phase B).

All five `bus_*` tools accept an optional `roster` parameter (a registry name from `@fro.bot/space-bus/registry`) to target any registered roster instead of the ambient workspace/`SPACE_BUS_CONFIG` resolution — and every tool result now opens with a `roster:` header naming the roster it resolved, on both success AND error results — so cross-roster calls (and cross-roster errors) are always visible. A sixth tool, `bus_registry`, manages the machine's roster registry from both surfaces: list rosters, create a roster in-app, register/unregister/set-default, and add/remove/update roster projects. On the MCP surface, `bus_registry use` selects a session-active roster (ephemeral, per connection) that omitted-`roster` calls resolve to; unregistering the active roster clears the session's selection (falls back to ambient resolution). When `SPACE_BUS_CONFIG` is unset, MCP ambient resolution now also falls back to the registry default (`bus_registry set-default`) before erroring — `set-default` gains a new routing role beyond bookkeeping. Plugin calls remain workspace-directory-first.

Note: every tool's text output now begins with a `roster:` line — consumers parsing raw tool text must account for the new first line (structured `bus_task` metadata is unchanged).
