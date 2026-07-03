---
title: OpenCode plugin tool registration and directory scoping
date: 2026-07-03
category: best-practices
module: space-bus
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - building or converting an OpenCode plugin that ships custom tools
  - plugin behavior depends on per-workspace config on a shared serve instance
  - migrating tools from .opencode/tools/ files to programmatic registration
tags: [opencode, plugin, tool-registration, directory-scoping, ctx-directory, lazy-loading, harness]
---

# OpenCode plugin tool registration and directory scoping

## Context

Converting space-bus from workspace-local `.opencode/tools/*.ts` files into the distributable `@fro.bot/space-bus` plugin required facts the docs don't spell out. All of the following was verified by live probes on harness `1.17.13+harness.ee55e157` (an OpenCode distribution) with two workspaces multiplexed on one server.

## Guidance

**Registration.** Plugins ship custom tools first-class via the Hooks `tool` map — the registry merges them with `.opencode/tools/` files:

```ts
const SpaceBusPlugin: Plugin = async (input) => ({
  tool: {
    bus_roster: makeBusRoster(input.directory),
    bus_task: makeBusTask(input.directory),
    bus_status: makeBusStatus(input.directory),
    bus_result: makeBusResult(input.directory),
  },
});
export default SpaceBusPlugin;
```

**Loading.** The `plugin` config array (singular key) accepts bare absolute file paths (no `file://` prefix) and npm names including `@scope/pkg@version`; npm plugins are auto-installed by Bun at startup. A file-path reference resolves the package's `main` — the built output loads, not `src/`.

**Directory scoping.** On a shared server routing per-request via `x-opencode-directory`, each session's plugin instance receives the correct per-request workspace in `input.directory` (factory arg) and `ctx.directory` (per tool call). `process.cwd()` stays pinned to the server's launch directory — never use it. Resolution pattern:

```ts
async execute(_args, ctx) {
  const r = await roster({ directory: ctx.directory ?? defaultDirectory });
  if (!r.ok) throw new Error(r.error);
  return formatRoster(r.projects);
}
```

**Lazy config.** Plugin modules must do zero import-time filesystem I/O. Config resolution happens inside `execute()` per call — an eager top-level `loadConfig()` crashes plugin registration in any workspace that lacks the config file.

**Transition hazard.** A repo hosting both `.opencode/tools/*.ts` and a plugin registering the same tool names double-registers. During a migration, test through a generated fixture workspace (own `opencode.json` with a file-path plugin ref) instead of launching from the repo root, and delete the file-based tools only after the plugin path passes a live gate.

## Why This Matters

Directory scoping is the difference between "works in my workspace" and "resolves the right workspace's config on a multiplexed server." The `process.cwd()` and import-time-I/O traps both pass every test run from the plugin's own repo and only fail in consumer workspaces — the probes are the cheap way to catch them before distribution.

## When to Apply

- Writing any OpenCode plugin whose tools read per-workspace config.
- Debugging tools that behave differently across workspaces on one server.
- Planning a `.opencode/tools/` → plugin conversion.

## Examples

Live probe shape that verified scoping: two workspaces on one `harness serve`, each session prompting a plugin tool that echoes `input.directory`/`ctx.directory`/`process.cwd()` — both directory fields tracked the request workspace; `cwd` stayed at the launch dir.

## Related

- `fro-bot/agent/docs/solutions/best-practices/versioned-tool-config-plugin-pattern-2026-03-29.md` — plugin declaration and startup config resolution; this doc adds the scoping, lazy-loading, and double-registration rules.
- `docs/solutions/integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md` — adjacent OpenCode server API behavior (session diffs) consumed by the same tools.
