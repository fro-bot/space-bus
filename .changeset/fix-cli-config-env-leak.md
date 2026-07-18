---
"@fro.bot/space-bus": patch
---

Fix the CLI's `--config` flag leaking into `process.env.SPACE_BUS_CONFIG`. `resolveRoster()` in `src/cli.ts` previously mutated the process environment as a side effect of resolving an explicit `--config` path, which persisted for the remainder of the process and could cause later ambient (env-based) roster resolution in the same process to resolve a stale/deleted path. `resolveRosterPath()` in `src/config.ts` now accepts an optional explicit override argument, so the CLI can thread `--config` through without touching `process.env`.
