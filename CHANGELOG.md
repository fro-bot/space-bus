# @fro.bot/space-bus

## 0.3.0

### Minor Changes

- 83013cd: Library surface: subpath exports `/core`, `/config`, `/contract`, `/format` (experimental — may change in minors). Browser-safe core with injected, boundary-validated context (roster + credentials); `snapshot()` composite for one-call mission-control state. Internal behavior change: config-resolution errors now surface at the adapter boundary before core runs; tool behavior otherwise unchanged.

## 0.2.1

### Patch Changes

- ac6dc8f: Replace the `DispatchArgs` casts in both adapters with a shared `toDispatchArgs` validator, and add an end-to-end test asserting the built `space-bus-mcp` reports the injected package version.

  Observable behavior change: argument-shape errors (missing `project`, empty `sessionId`) now surface before roster/config resolution errors, so a bad-args call on a machine with no roster reports the args problem instead of the config problem.

## 0.2.0

### Minor Changes

- cfe5b46: Tighten `dispatch()` arguments: `DispatchArgs` is now a discriminated union requiring `project` or `sessionId` (bare `{prompt}` is a compile error), with a distinct error for empty-string `sessionId`. The `space-bus-mcp` server reports the real package version, and the generated dev fixture is fully self-contained (placeholder projects, no machine-local paths).

## 0.1.0

### Minor Changes

- 1744b88: Initial distributable release: plugin tool registration, spacebus.json roster discovery, space-bus-mcp bin.
