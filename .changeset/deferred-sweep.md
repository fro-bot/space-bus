---
"@fro.bot/space-bus": minor
---

Tighten `dispatch()` arguments: `DispatchArgs` is now a discriminated union requiring `project` or `sessionId` (bare `{prompt}` is a compile error), with a distinct error for empty-string `sessionId`. The `space-bus-mcp` server reports the real package version, and the generated dev fixture is fully self-contained (placeholder projects, no machine-local paths).
