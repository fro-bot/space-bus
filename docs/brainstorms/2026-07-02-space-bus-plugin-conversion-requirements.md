---
date: 2026-07-02
topic: space-bus-plugin-conversion
---

# Space Bus Plugin Conversion

## Summary

Convert space-bus from a workspace-local tool into `@fro.bot/space-bus`, a distributable OpenCode plugin that registers the four `bus_*` tools programmatically, reads its roster from the consuming workspace's `spacebus.json`, and ships the MCP facade as a package export — with the repo adopting the full Fro Bot CI posture (Changesets, npm trusted publishing, Biome, security workflows). Tool logic ships unchanged; roster discovery is the one deliberate behavior change.

---

## Problem Frame

The MVP works, but only inside this repo: tools load from `.opencode/tools/`, and the roster (`workspace.json`) resolves relative to the source tree. Nobody else — no other workspace, no other machine, not even a second checkout — can use the bus without cloning the repo and launching OpenCode from its root. The control board and the product are fused. Meanwhile the plugin API in `@opencode-ai/plugin` 1.17.13 supports first-class programmatic tool registration (verified in the installed type defs and the opencode tool registry), and two sibling repos (`opencode-copilot-delegate`, `systematic`) already model the packaging, release, and CI conventions a distributable plugin should follow.

---

## Actors

- A1. Plugin consumer: any OpenCode workspace that lists `@fro.bot/space-bus` in its `opencode.json` `plugin` array and provides a `spacebus.json` roster.
- A2. Control board operator (Marcus): runs the live Fro Bot control board from a new untracked sibling dir (`~/src/github.com/fro-bot/workspace`).
- A3. Claude Desktop / MCP client: consumes the same four tools via the packaged MCP facade.
- A4. CI (Fro Bot + release automation): reviews PRs, versions via Changesets, publishes via npm trusted publishing.

---

## Requirements

**Packaging**
- R1. The package publishes as `@fro.bot/space-bus`: ESM-only `dist/` (built JS + `.d.ts`), `@opencode-ai/plugin` as a peerDependency (loose range) with an exact dev-pin, `publishConfig` with public access and provenance.
- R2. The plugin entry default-exports a Plugin factory returning the four tools via the `tool` map (`bus_roster`, `bus_task`, `bus_status`, `bus_result`) — names unchanged, logic unchanged (packaging move, not a rewrite).
- R3. `.opencode/tools/` is deleted at conversion; plugin registration is the only tool source (no double-registration path).
- R4. The MCP facade ships in the package (bin or export path) so Claude Desktop config points at the installed package, not a repo checkout. It remains stdio-only — no network listener — and applies the same roster validation as the plugin.

**Roster discovery**
- R5. The plugin resolves its roster from `spacebus.json` in the consuming workspace, replacing repo-relative `workspace.json` resolution. Planning must pin the exact directory source (plugin-load input vs per-call tool context) and prove it resolves the loading workspace's roster — not a delegated target's — under the multiplexed server.
- R6. The `SPACE_BUS_CONFIG` env var overrides the roster path (primary consumer: the MCP facade, which has no workspace directory). The override accepts a local file path only — URLs are rejected; the file's contents pass the same validation as any roster (localhost guard included).
- R7. A missing or invalid `spacebus.json` produces an immediate actionable error naming the expected path — same fail-fast contract as today, localhost guard included.

**Migration**
- R8. The live control board moves to a new untracked sibling dir (`~/src/github.com/fro-bot/workspace`): `spacebus.json`, the delegation-policy `AGENTS.md`, and an `opencode.json` loading the plugin. The cutover is reversible: `.opencode/tools/` and `workspace.json` stay in this repo until the new workspace passes a live smoke check (AE4), and rolling back is reverting to launching from this repo.
- R9. This repo sheds its machine-local details: `workspace.json` and the control-board portions of `AGENTS.md` move to the new workspace; the repo's `AGENTS.md` reorients to plugin development.

**Repo posture / CI**
- R10. Release automation is Changesets with npm trusted publishing (OIDC, `id-token: write`, no NPM_TOKEN), following `opencode-copilot-delegate`'s release workflow.
- R11. Lint/format is Biome, following the plugin-repo template.
- R12. Workflow set: ci, release, fro-bot (review + maintenance), renovate, codeql, scorecard, update-repo-settings — actions SHA-pinned, branch protection via `settings.yml` with required checks matching the CI job names. The full set on day one is a deliberate org-standardization decision (every fro-bot repo carries it), not per-package cost-benefit.

---

## Acceptance Examples

- AE1. **Covers R2, R5.** Given a fresh workspace with `opencode.json` `{"plugin": ["@fro.bot/space-bus"]}` and a valid `spacebus.json`, when the control agent asks "what's on the bus?", bus_roster lists that workspace's projects with live counts.
- AE2. **Covers R7.** Given a workspace loading the plugin with no `spacebus.json`, when any bus tool runs, it errors naming the expected config path (and the env override) — no stack trace, no silent empty roster.
- AE3. **Covers R4, R6.** Given Claude Desktop configured against the installed package with `SPACE_BUS_CONFIG` pointing at a roster file, bus_roster round-trips as it does today from the repo checkout.
- AE4. **Covers R8.** Given the new `~/src/github.com/fro-bot/workspace` control board, when Marcus launches OpenCode there, delegation to `dashboard` works end-to-end (task → session ID → status → result) with no reference to the space-bus repo path.
- AE5. **Covers R10.** Given a merged PR with a changeset, when release CI runs on main, the package publishes to npm with provenance and no NPM_TOKEN secret configured in the repo.
- AE6. **Covers R2, R5.** Given the plugin loaded by the control-board workspace under `harness serve` (not stock opencode), when bus_task delegates to another project, the roster resolves from the control board's `spacebus.json` — not the delegated target's directory.

---

## Success Criteria

- The bus runs from a workspace that has never seen the space-bus source tree — install, config file, go.
- The live Fro Bot control board operates from the new workspace dir with zero functional regression from today's setup.
- A downstream planner can execute the conversion without inventing product behavior: every move (files, config names, workflow set) is specified here or in the referenced conventions.
- First npm publish succeeds through CI trusted publishing.

---

## Scope Boundaries

- No new tools, no behavior changes riding along; no SSE consumer, no queue, no broker.
- No opencode plugin marketplace/registry submission beyond npm.
- No multi-server rosters or remote (non-localhost) servers — the localhost guard stays.
- No telemetry and no off-machine network calls from the plugin or facade — the only network egress anywhere in the project is CI's npm publish.
- External adoption is not a v1 goal — distribution mechanics are being built for the ecosystem's conventions, not a known second consumer.
- The smoke canary stays a dev-repo script; it is not part of the published package surface.

---

## Key Decisions

- `spacebus.json` in the consumer workspace (not `workspace.json`, not global, not inline in opencode.json): the loading workspace owns its roster; distinct filename avoids generic-name collisions; env var covers the no-workspace MCP case.
- Control board → new untracked sibling dir: machine-local by nature, nothing publishable; keeps the plugin repo clean of operator specifics.
- Biome + Changesets over ESLint + semantic-release: plugin repos follow the plugin-repo template (`opencode-copilot-delegate`), not the fro-bot core-app conventions.
- Keep `bus_*` tool names: plugin tool maps don't prefix names; existing prompts and docs keep working.
- `@fro.bot/space-bus` scoped name: matches `@fro.bot/harness` and `@fro.bot/systematic`.

---

## Dependencies / Assumptions

- npm trusted publisher configuration for `@fro.bot/space-bus` on npmjs.com is Marcus's manual step before the first CI publish (AE5 fails without it).
- `@opencode-ai/plugin` 1.17.x npm/ESM loading caveat: published output must be valid ESM with `.js` extensions — a real build step.
- Harness loader parity: verified live (2026-07-02, harness ee55e157) — a file-path plugin entry in `opencode.json` loads and registers tools on `harness serve`; npm-package-name resolution still gets its first exercise at AE6 with the published package.
- Plugin directory scoping: verified live — on one shared server, each session's plugin instance receives the per-request workspace in `input.directory`/`ctx.directory` (correct for `spacebus.json` discovery). `process.cwd()` stays pinned to the server launch dir and must never be used.
- Migration sequencing (R8 before R3/R9): this session's own control board is this repo; the new workspace must pass AE4 before the local tools/manifest are removed, or the bus goes dark mid-conversion. Rollback is relaunching from this repo pre-deletion.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] bin vs export path for the MCP facade (`bunx @fro.bot/space-bus mcp` vs `bun run` against an export) — pick whichever matches how Claude Desktop config resolves cleanest.
- [Affects R1][Technical] Exact build tooling (plain `tsc` vs `bun build` + `tsc --emitDeclarationOnly`) — copy whichever of the two reference repos fits the package's size.
- [Affects R12][Needs research] Whether `update-repo-settings`/`settings.yml` needs org-level app installation for a fro-bot repo — verify against dashboard's setup during planning.

---

## Sources / Research

- Installed type defs: `node_modules/@opencode-ai/plugin/dist/index.d.ts` (`Hooks.tool` map), `tool.d.ts` (`ToolDefinition`) — plugins register tools first-class in 1.17.13.
- opencode tool registry merges plugin tools with `.opencode/tools/` files (`packages/opencode/src/tool/registry.ts`).
- Packaging templates: `~/src/github.com/marcusrbrown/opencode-copilot-delegate` (Changesets, OIDC trusted publishing, Biome, central `src/index.ts` + one-file-per-tool), `~/src/github.com/marcusrbrown/systematic` (publishConfig provenance, peer-dep posture).
- Fro Bot CI conventions: `fro-bot/dashboard` and `fro-bot/agent` workflow sets (SHA pinning, fro-bot.yaml review, codeql/scorecard/settings).
- Published plugin examples registering tools: `myai-tools`, `opencode-ask-github`, `@opencode-trace/plugin`.
