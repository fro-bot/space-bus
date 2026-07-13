---
"@fro.bot/space-bus": patch
---

Fix `bus_registry` MCP tool responses: every successful action now returns `structuredContent` (`{ rosters: [...] }` for `list`, `{}` for all other actions), matching the tool's declared output schema. Previously, non-`list` actions (`register`, `create`, `unregister`, `set-default`, `use`, `add-project`, `remove-project`, `update-project`) omitted `structuredContent`, causing MCP clients to reject the response with error -32602 even though the underlying mutation had already succeeded.
