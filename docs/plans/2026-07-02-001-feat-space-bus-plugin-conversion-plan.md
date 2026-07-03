---
title: 'feat: Convert space-bus into the distributable @fro.bot/space-bus plugin'
type: feat
status: completed
date: 2026-07-02
deepened: 2026-07-02
origin: docs/brainstorms/2026-07-02-space-bus-plugin-conversion-requirements.md
---

# feat: Convert space-bus into the distributable @fro.bot/space-bus plugin

## Overview

Repackage the working space-bus MVP as `@fro.bot/space-bus`, an npm-distributed OpenCode plugin: programmatic registration of the four `bus_*` tools, per-workspace `spacebus.json` roster discovery, MCP facade as a package bin, Changesets + npm trusted publishing, Biome, and the full Fro Bot workflow set. The live control board migrates to an untracked sibling workspace with a reversible cutover.

## Problem Frame

The bus works only from this repo: tools load from `.opencode/tools/` and the roster resolves relative to the source tree (see origin doc). No other workspace or machine can consume it. The plugin API supports first-class tool registration (verified against installed 1.17.13 type defs), and a live probe on harness ee55e157 confirmed file-path plugin loading works and `input.directory`/`ctx.directory` track the per-request workspace on a shared server.

## Requirements Trace

R1–R12 from the origin document, grouped: packaging (R1–R4), roster discovery (R5–R7), migration (R8–R9), repo posture/CI (R10–R12). Acceptance examples AE1–AE6 gate the phases below.

## Scope Boundaries

- No new tools, behavior changes, SSE consumer, queue, or broker.
- No marketplace submission beyond npm; no remote (non-localhost) servers; no telemetry or off-machine calls from the plugin or facade at runtime (repo CI is GitHub-hosted and publishes to npm — that egress is CI's, not the shipped code's).
- External adoption is not a v1 goal.

### Deferred to Separate Tasks

- Dropping the `/vcs/status` working-tree diff tier once the #33444 carry is everywhere: revisit when upstream lands (smart note #197 tracks it).
- Deferred P2/P3 review findings (unit tests for formatters, DispatchInput type-level exclusivity): post-conversion hardening.

## Context & Research

### Relevant Code and Patterns

- `src/core.ts` — all bus logic; today loads `workspace.json` at import time (must go lazy; the flow analysis rates the eager load a plugin-load crash in any consumer workspace).
- `src/format.ts`, `src/mcp.ts`, `.opencode/tools/bus_*.ts` — shared formatters, MCP facade, current file-based adapters.
- `~/src/github.com/marcusrbrown/opencode-copilot-delegate` — the packaging template: central `src/index.ts` plugin entry returning a `tool` map, one file per tool, Bun build + `tsc --emitDeclarationOnly`, Changesets, OIDC trusted publishing (`release.yaml` verified: `id-token: write`, no NPM_TOKEN), Biome, `settings.yml` extending `bfra-me/.github` via the reusable update-repo-settings workflow with App credentials.
- `~/src/github.com/fro-bot/agent`, `~/src/github.com/fro-bot/dashboard` — Fro Bot workflow conventions: SHA-pinned actions, fro-bot.yaml review, codeql, scorecard, renovate wrapper.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md` — the tiered diff strategy ships unchanged.
- Probe findings (origin doc, Dependencies): never `process.cwd()`; only `input.directory`/`ctx.directory`.
- MCP stdio discipline: stdout carries protocol frames only; all diagnostics to stderr (existing `src/mcp.ts` already complies; keep it true through the refactor).

### External References

- `@opencode-ai/plugin` 1.17.13 `Hooks.tool` map + `ToolDefinition` (installed type defs).
- npm trusted publishing (OIDC) — requires Marcus's one-time trusted-publisher setup for `@fro.bot/space-bus` on npmjs.com.

## Key Technical Decisions

- Lazy roster resolution: replace import-time `loadManifest()` with `getRoster(directory)` resolving `<directory>/spacebus.json`, `SPACE_BUS_CONFIG` env override (absolute or `~` paths only; URLs and bare-relative rejected; resolved path canonicalized before read). No cross-call caching — a local file read per tool call is cheap and hot-edits of the roster take effect immediately. Discovery is exact-path (no upward directory walk); `ctx.directory` preferred, captured `input.directory` as fallback. Forced deviation from "logic unchanged" — eager load crashes plugin registration in consumer workspaces; ALL module-level roster/project state goes away, every exported function resolves per call.
- Plugin entry per copilot-delegate: default-exported Plugin factory; tools built once per plugin instance with the instance's `input.directory` baked in; per-call `ctx.directory` used when present (probe showed both track the request workspace).
- MCP facade as package `bin` (`space-bus-mcp`): resolves the origin doc's bin-vs-export question; Claude Desktop invocation is `bunx --package=@fro.bot/space-bus space-bus-mcp` (bunx/npx resolve bin names, not package names, when they differ) with `SPACE_BUS_CONFIG` env. Bin pattern per @fro.bot/systematic (`bin` → built dist file).
- Build: `bun build` bundle with `--target node` (matching copilot-delegate's plugin entry; the OpenCode host is Node-compatible and the bin must run under both runtimes), external `@opencode-ai/plugin`/`@modelcontextprotocol/sdk`/`zod`, + `tsc --emitDeclarationOnly` — bundling sidesteps the 1.17.x published-ESM `.js`-extension footgun.
- Peer range `>=1.17.13 <2` for `@opencode-ai/plugin`, exact dev-pin; loose peer avoids npm 7+ auto-install conflicts with the host runtime.
- Roster filename `spacebus.json`; schema unchanged from `workspace.json` (server.baseUrl + projects), localhost guard retained at load.
- Dev loop: gitignored `fixtures/dev-workspace/` generated by `scripts/make-fixture.ts` (writes `opencode.json` with this checkout's absolute file-path plugin reference and a `spacebus.json`) — fresh clones run one script to get the dev loop; avoids double-registering `bus_*` from `.opencode/tools/` + plugin in the repo root during transition.
- Smoke roster contract: `scripts/smoke.ts` reads `SPACE_BUS_CONFIG`, defaulting to the repo-root `spacebus.json` during transition and to `fixtures/dev-workspace/spacebus.json` after Unit 6 — one mechanism across the whole migration.
- Staging rule (no-break): the live control board runs from this repo until Unit 6's gate. Every unit's verification includes the bus still working from this repo; the root `spacebus.json` lands in the same commit as the lazy-load change so the `.opencode/tools/` adapters never lose their roster.

## Open Questions

### Resolved During Planning

- Settings mechanism: `settings.yml` with `_extends: .github:common-settings.yaml` + reusable `bfra-me/.github` update-repo-settings workflow (App credentials) — verified in copilot-delegate.
- Bin vs export for MCP: bin.
- Build tooling: bun bundle + declaration-only tsc (copilot-delegate pattern).

### Deferred to Implementation

- Exact Biome ruleset inherited (copy copilot-delegate's `biome.json`, adjust as diagnostics dictate).
- Whether `scripts/smoke.ts` needs a roster-path flag or reads the fixture by default once `workspace.json` is gone.

## Output Structure

    src/
      index.ts            # plugin entry: default-exported factory returning the tool map
      tools/              # bus_roster.ts, bus_task.ts, bus_status.ts, bus_result.ts (thin, per-file)
      core.ts             # logic (lazy roster; otherwise unchanged)
      format.ts           # shared formatters (unchanged)
      mcp.ts              # stdio facade (bin entry)
      config.ts           # spacebus.json discovery + SPACE_BUS_CONFIG resolution
    fixtures/dev-workspace/   # gitignored: opencode.json (file-path plugin ref) + spacebus.json
    .changeset/
    .github/workflows/    # ci, release, fro-bot, renovate, codeql, scorecard, update-repo-settings
    .github/settings.yml

## Implementation Units

- [x] **Unit 1: Lazy roster resolution (`spacebus.json` + env override)**

**Goal:** Roster loads on demand per call, never at import; `spacebus.json` discovered from the workspace directory; `SPACE_BUS_CONFIG` override.

**Requirements:** R5, R6, R7

**Dependencies:** None

**Files:**
- Create: `src/config.ts`
- Modify: `src/core.ts`, `src/mcp.ts`, `scripts/smoke.ts`, `.opencode/tools/bus_*.ts` (pass directory through)
- Test: `src/config.test.ts`

**Approach:**
- `resolveRosterPath(directory?)`: `SPACE_BUS_CONFIG` (expand `~`; reject URLs and bare-relative with an actionable error; canonicalize the resolved path) → `<directory>/spacebus.json` → error naming both options. Exact-path discovery, no upward walk.
- `getRoster(directory?)`: no caching — read + validate per call (hot roster edits apply immediately); localhost guard and zod parse move here; every exported core function resolves the roster per call — zero module-level roster/project state remains (the current `const manifest = loadManifest()` and derived `projects` are removed, and each of roster/dispatch/status/result/steer takes the directory through its call chain).
- During transition the repo-root `.opencode/tools/` adapters pass their `ctx.directory`; a `spacebus.json` copy of `workspace.json` lands at repo root until Unit 6 removes both.

**Test scenarios:**
- Happy path: directory with valid `spacebus.json` → parsed roster with expanded `~` paths.
- Happy path: `SPACE_BUS_CONFIG=~/x/spacebus.json` wins over directory discovery.
- Error path: missing file → error naming `<dir>/spacebus.json` and the env override.
- Error path: `SPACE_BUS_CONFIG=https://…` and `SPACE_BUS_CONFIG=./relative` → rejected with the absolute-or-tilde rule.
- Error path: non-localhost `baseUrl` → refused (guard preserved).
- Edge: import of core/config modules performs zero filesystem I/O (no roster read at import time).

**Verification:** typecheck clean; new unit tests pass under `bun test`; `bun run smoke` still PASS against the live server.

- [x] **Unit 2: Plugin entry + per-file tools**

**Goal:** `src/index.ts` default-exports the Plugin factory registering exactly the four tools; tool bodies move to `src/tools/*.ts`; `.opencode/tools/` untouched (removed in Unit 6).

**Requirements:** R2, R3 (groundwork), R5

**Dependencies:** Unit 1

**Files:**
- Create: `src/index.ts`, `src/tools/bus_roster.ts`, `src/tools/bus_task.ts`, `src/tools/bus_status.ts`, `src/tools/bus_result.ts`
- Test: `src/index.test.ts`

**Approach:**
- Factory captures `input.directory`; each tool's `execute` prefers `ctx.directory`, falls back to the captured directory (probe verified both track the request workspace; never `process.cwd()`).
- Tool files: same thin adapter shape as today's `.opencode/tools/` (throw on `ok:false`), descriptions byte-identical to the MCP facade.

**Patterns to follow:** copilot-delegate `src/index.ts` central registry; existing adapter bodies.

**Test scenarios:**
- Happy path: factory returns a `tool` map with exactly the four keys; each has description + args + execute.
- Integration: loading the built package from `fixtures/dev-workspace/` via file-path plugin reference registers working tools (manual/scripted probe, mirrors the /tmp probe).

**Verification:** typecheck clean; fixture-workspace live probe shows the four tools functioning via plugin registration.

- [x] **Unit 3: Packaging, build, Biome, MCP bin**

**Goal:** Publishable package shape: ESM `dist/`, declarations, bin for the MCP facade, Biome lint/format, Changesets initialized.

**Requirements:** R1, R4, R10 (changesets half), R11

**Dependencies:** Unit 2

**Files:**
- Modify: `package.json`, `tsconfig.json`, `.gitignore`
- Create: `biome.json`, `.changeset/config.json`, `scripts/build.ts` (or inline package scripts), `scripts/make-fixture.ts` (generates gitignored `fixtures/dev-workspace/`)
- Test: `Test expectation: none — packaging/config; gated by build output checks below`

**Approach:**
- `name: @fro.bot/space-bus`, `type: module`, `main/types/exports` → `dist/`, `bin: {"space-bus-mcp": "dist/mcp.js"}`, `files: [dist, README.md, LICENSE]`, `publishConfig: {access: public}` (trusted publishing auto-generates provenance — no flag needed).
- Scripts contract (copilot-delegate): `clean` (rimraf dist), `build` (clean → bun bundle → `tsc --emitDeclarationOnly --noEmit false`), `version-changesets` (`changeset version && bun install --lockfile-only`), `publish-changesets` (`bun run build && changeset publish`), `prepublishOnly` (build). `.changeset/config.json` copied verbatim (access public, baseBranch main).
- `peerDependencies: {"@opencode-ai/plugin": ">=1.17.13 <2"}`; move today's exact pins to devDependencies; keep `@modelcontextprotocol/sdk` + `zod` as regular dependencies.
- Build: `bun build src/index.ts src/mcp.ts --outdir dist --target bun --external …` + `tsc --emitDeclarationOnly`; `dev` watch script.
- MCP entry gains a shebang and stays stdout-clean (stderr-only diagnostics).

**Patterns to follow:** copilot-delegate `package.json`/build/biome/changeset config.

**Verification:** `bun run build` emits `dist/index.js`, `dist/mcp.js`, `.d.ts`; `bunx biome check .` clean; `bun pm pack --dry-run` (or equivalent) lists only intended files; fixture workspace loads the BUILT dist (not src) successfully; MCP stdio probe against `dist/mcp.js` passes (four tools, isError path, no stdout noise).

- [x] **Unit 4: CI workflow set + settings**

**Goal:** The seven workflows plus `settings.yml`, SHA-pinned, with branch protection contexts matching CI job names.

**Requirements:** R10 (publish half), R12

**Dependencies:** Unit 3

**Files:**
- Create: `.github/workflows/{ci.yaml,release.yaml,fro-bot.yaml,renovate.yaml,codeql-analysis.yaml,scorecard.yaml,update-repo-settings.yaml}`, `.github/settings.yml`, `.github/renovate.json5`
- Test: `Test expectation: none — CI config; verified by live runs on push/PR`

**Approach:**
- ci.yaml: one job — name it exactly as settings.yml's required context will reference (copilot-delegate uses `Lint, typecheck, build, unit tests`); steps: checkout → mise/bun setup → install → typecheck → lint → build → ESM export-shape smoke (`node --input-type=module -e "import(...)"`) → unit tests.
- release.yaml (copilot-delegate contract): triggers `workflow_dispatch` + `workflow_run: {workflows: [CI], branches: [main], types: [completed]}` with a job-level `if` on `workflow_run.conclusion == 'success'` (the branches filter is the fork gate); job permissions `contents: write, id-token: write, pull-requests: write`; App token via `actions/create-github-app-token` feeds changesets/action (`setupGitUser: false`, version/publish = the package scripts above); `actions/setup-node` with `registry-url: https://registry.npmjs.org`; npm ≥ 11.5.1 in the job for OIDC (upgrade step if the runner's is older); no NPM_TOKEN anywhere.
- fro-bot.yaml: pinned fro-bot/agent SHA; review prompt customized to this package (plugin API contracts, roster/config safety, changeset hygiene) keeping the standard verdict heading structure. renovate.json5 lives at `.github/renovate.json5` extending `github>marcusrbrown/renovate-config`; add a packageRule preventing automerge on `matchManagers: [github-actions]` if the preset doesn't already.
- App secrets (APPLICATION_ID/APPLICATION_PRIVATE_KEY) live as repo secrets exactly as in copilot-delegate; the SAME App token pattern also drives release.yaml's changesets action — both are Marcus-provisioned prerequisites.
- `settings.yml`: `_extends: .github:common-settings.yaml`, description/topics, required contexts = {Fro Bot, the CI job name, Renovate / Renovate}.
- Secrets/app setup (APPLICATION_ID/KEY for settings workflow; trusted publisher on npmjs.com) are Marcus's manual steps — named in the PR body checklist.

**Verification:** CI green on the conversion PR; actionlint (via ci job or local) clean; release workflow dry-behavior verified on main after merge (version PR appears when a changeset exists).

- [x] **Unit 5: Docs rewrite**

**Goal:** README and AGENTS.md reorient to the plugin: install/config for consumers, dev-loop for contributors; control-board specifics out.

**Requirements:** R9 (docs half), R4 (Claude Desktop snippet)

**Dependencies:** Units 1–3 (accurate content)

**Files:**
- Modify: `README.md`, `AGENTS.md`
- Test: `Test expectation: none — docs`

**Approach:**
- README: opencode.json `{"plugin": ["@fro.bot/space-bus"]}` + `spacebus.json` schema + Claude Desktop bin snippet with `SPACE_BUS_CONFIG`; implementation notes trimmed to what still applies; delegation-policy content moves to the new workspace's AGENTS.md (Unit 6).
- AGENTS.md: plugin-development guidance (fixture workspace dev loop, build/watch, tool-parity rule, no-cwd rule, stdio discipline), keeping the docs/solutions pointer.

**Verification:** No references to `workspace.json`, `.opencode/tools/`, or repo-checkout Claude Desktop paths remain outside historical docs (`docs/brainstorms`, `docs/solutions`, `HANDOFF.md`).

- [x] **Unit 6: Control-board migration + repo cleanup (reversible cutover)**

**Goal:** New control board at `~/src/github.com/fro-bot/workspace` passes AE4; only then the repo sheds `.opencode/tools/`, root `workspace.json`/`spacebus.json`, and the old control-board AGENTS.md content.

**Requirements:** R3, R8, R9; AE1, AE4

**Dependencies:** Units 1–5 shipped; plugin loadable (file-path reference is sufficient — npm publish not required for cutover)

**Files:**
- Create (outside repo, untracked): `~/src/github.com/fro-bot/workspace/{opencode.json,spacebus.json,AGENTS.md}`
- Delete: `.opencode/tools/bus_*.ts`, root `workspace.json` + transitional `spacebus.json`
- Test: `Test expectation: none — operational cutover; gated by the AE4 live check`

**Approach:**
- New workspace's opencode.json references the plugin by file path first (`/Users/mrbrown/src/github.com/fro-bot/space-bus`), switching to the npm name after first publish (AE6 completes then).
- Cutover gate: from the new workspace, roster → task dashboard → status → result round-trip (AE4). Rollback: relaunch from this repo — deletions land only after the gate passes.
- `scripts/smoke.ts` switches to the fixture roster.

**Verification:** AE4 live pass from the new workspace; `git grep` confirms no `.opencode/tools` remnants; smoke still PASS from the repo using the fixture.

- [x] **Unit 7: First publish + AE6**

**Goal:** The package reaches npm and the control board switches to the npm name. Bootstrap constraint (verified against current npm docs): a trusted publisher CANNOT be configured for a package that doesn't exist yet — the FIRST publish is a manual maintainer publish (`npm publish` with 2FA/granular token, version 0.1.0), then the trusted publisher is configured on npmjs.com (owner fro-bot, repo space-bus, workflow `release.yaml` — exact filename match), and AE5 is satisfied by the SECOND release flowing through CI OIDC.

**Requirements:** R1, R10; AE5 (second release), AE6

**Dependencies:** Units 4, 6; Marcus's manual bootstrap publish + trusted-publisher config

**Files:**
- Create: `.changeset/*.md` (initial version changeset)
- Modify: `~/src/github.com/fro-bot/workspace/opencode.json` (file path → npm name)
- Test: `Test expectation: none — release operations; gated by AE5/AE6 live checks`

**Approach:** bootstrap-publish 0.1.0 manually → configure trusted publisher → land a changeset → merge the CI version PR → verify the OIDC publish + auto-generated provenance on the npm listing; flip the control board's plugin reference to `@fro.bot/space-bus` and re-run the AE4 round-trip (this is AE6 — npm-name resolution through harness).

**Rollback:** a bad publish is recovered by pinning the previous version in the control board's `opencode.json` (`@fro.bot/space-bus@<prev>`) or reverting to the file-path reference — which also remains the offline fallback if npm is unreachable at startup.

**Verification:** AE5 (publish with provenance, no NPM_TOKEN) and AE6 (bus works via npm-installed plugin under harness) both pass live.

## System-Wide Impact

- **Interaction graph:** OpenCode tool registry (plugin-provided tools replace directory-loaded ones); Claude Desktop MCP config contract changes (repo path → package bin).
- **Error propagation:** roster-resolution errors now occur per tool call instead of at import — every consumer-facing error must name `spacebus.json` and the env override.
- **State lifecycle risks:** transition window where both tool sources could register `bus_*` — avoided by fixture-workspace dev loop and Unit 6's delete-after-gate ordering.
- **API surface parity:** `.opencode/tools` vs plugin vs MCP must stay byte-identical in descriptions/output through the conversion (existing parity rule).
- **Integration coverage:** fixture-workspace live probe (Unit 2/3) and the AE4/AE6 cutover gates are the cross-layer proofs; unit tests cover only pure resolution logic.
- **Unchanged invariants:** the four-tool surface, tool names, output formats, discriminated-union core contracts, localhost-only servers, tiered diff strategy.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Eager-load regression sneaks back (import-time I/O) | Unit 1 test asserts import performs no filesystem reads |
| Published ESM fails to load in harness (1.17.x extension footgun) | Bundled build; AE6 exercises the real npm install path before the cutover is called done |
| Tool double-registration during transition | Fixture-only dev loop; deletions gated on AE4 |
| Trusted publishing misconfigured on first release | AE5 is a gate; failure mode is a failed CI publish, not a broken package |
| settings.yml reusable workflow needs App secrets | Named as manual prerequisite in the conversion PR checklist |
| Control board offline / npm registry down at startup | File-path plugin reference documented as the permanent offline fallback; version pinning as the bad-release escape |

## Documentation / Operational Notes

- Marcus manual steps, in order: (1) APPLICATION_ID/APPLICATION_PRIVATE_KEY repo secrets (settings + release workflows); (2) bootstrap `npm publish` of 0.1.0 (package must exist before a trusted publisher can be configured); (3) trusted-publisher config on npmjs.com — owner `fro-bot`, repo `space-bus`, workflow filename exactly `release.yaml`, no environment; (4) branch-protection contexts activate via the settings workflow.
- HANDOFF.md and docs/brainstorms stay as history — no retro-editing.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-02-space-bus-plugin-conversion-requirements.md](../brainstorms/2026-07-02-space-bus-plugin-conversion-requirements.md)
- Probe evidence: /tmp/space-bus-probe (harness ee55e157, 2026-07-02)
- Templates: opencode-copilot-delegate (packaging/release), fro-bot/agent + dashboard (workflow conventions)
