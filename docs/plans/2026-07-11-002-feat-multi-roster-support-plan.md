---
title: "feat: Multi-roster support — registry, mutation module, per-call addressing"
type: feat
status: active
date: 2026-07-11
origin: docs/brainstorms/2026-07-11-multi-roster-support-requirements.md
---

# feat: Multi-Roster Support — Registry, Mutation Module, Per-Call Addressing

## Overview

Make rosters first-class and plural: a per-user registry names rosters machine-wide; one shared Node-only mutation module creates rosters and edits projects (exposed via library, MCP, and CLI); the tool surfaces gain an optional per-call `roster` parameter with an MCP session default; reconciliation reports registry-vs-reality drift. Three phases, each independently shippable and releasable (incremental minors, so Mothership can adopt the registry/mutation library before the tool surfaces land).

## Problem Frame

Everything above the substrate is single-roster today: `src/mcp.ts` pins one roster via `SPACE_BUS_CONFIG` at process start, nothing enumerates the rosters on a machine, and no code path writes a roster file — every `spacebus.json` is hand-authored (verified: only `scripts/make-fixture.ts` writes one). The daily driver is Mothership instances over different boards; switching or creating boards today means hand-editing JSON and restarting clients. Core is already N-roster-capable (per-call injected `BusContext`, no module state) and the managed lifecycle is per-roster by construction — the gap is naming, mutation, and addressing. (See origin doc for requirements R1–R16, flows F1–F3, AE1–AE7.)

## Requirements Trace

- R1–R4: registry (name → path, optional, register/unregister/default, one-op roster creation)
- R5–R8: mutation module (atomic + validated, three surfaces, discriminated unions, Mothership-adoptable)
- R9–R12: addressing (roster param + result echo + parity, MCP session default, one management tool, actionable unknown-roster errors)
- R13–R14: reconciliation (discovery rosterPath field, listing + drift flags)
- R15–R16: security (no credentials in registry, canonicalized paths, localhost guard re-applied; no client-config editing)

## Scope Boundaries

- No cross-roster aggregates (`bus_wait`/`snapshot()` stay single-roster per call).
- No remote rosters; loopback guard stands everywhere a server is resolved.
- No MCP client-config editing; no Mothership UI work (library substrate only).
- `spacebus.json` shape unchanged; registry and discovery field are additive.

### Deferred to Separate Tasks

- Registry rename + reconciliation repair actions: future iteration, after core flows prove out.
- Mothership migration to the registry/mutation library: Mothership-repo work.
- Advisory locking for concurrent roster edits: revisit if last-writer-wins bites (see KTDs).

## Context & Research

### Relevant Code and Patterns

- `src/config.ts` — `resolveRosterPath`/`getRoster`/`loadContext`: the resolution pipeline the registry loader extends; localhost guard lives in `loadManifest` path.
- `src/contract.ts` — zod-only schemas (`rosterSchema`, `projectSchema`, `discoveryFileSchema`); registry file schema joins this lane for browser-safe consumption.
- `src/discovery.ts` — `stateDirFor` (sha256(roster path)[0:16] keying), `writeDiscovery`: where the `rosterPath` field lands at spawn.
- `src/launchd.ts` — `writePlistAtomic` + `verifyPlistSafe`: the atomic-write + symlink-rejection pattern the registry/mutation writers reuse (extract a shared Node-only helper rather than duplicating).
- `src/tools/bus_*.ts` — `makeBus*` factories + description constants: the parity mechanism; the `roster` param and management tool follow this exact shape.
- `src/mcp.ts` — `mcpLoadContext()`: per-call context load; session state slots in here.
- `src/cli.ts` — subcommand dispatch pattern for `space-bus roster` verbs.
- `src/browser-safety.test.ts` + `src/plugin-entry-guard.test.ts` — the two CI guards every new module must be wired into.

### Institutional Learnings

- `docs/solutions/integration-issues/opencode-plugin-reserved-subpath-loader-resolution-2026-07-11.md` — `exports["./server"]` is reserved; the new subpath must avoid it and the entry-guard test must stay green.
- `docs/solutions/security-issues/launchd-log-symlink-toctou-2026-07-11.md` — no check-then-use on paths: O_NOFOLLOW/atomic patterns for all new writers.
- `docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md` + memory 6547 — tests must isolate the env-derived write base; registry tests get the same preload treatment (XDG_CONFIG_HOME).
- `docs/solutions/workflow-issues/source-ref-dogfooding-can-mask-packaged-artifact-failures-2026-07-11.md` — dist-level guard twin for any new subpath export.

## Key Technical Decisions

- **Registry location**: `$XDG_CONFIG_HOME/space-bus/rosters.json` falling back to `~/.config/space-bus/rosters.json` — config (durable, user-editable), distinct from state (`~/.local/state/space-bus`, daemon-owned). Schema in `contract.ts` (zod-only); reader/writer Node-only.
- **Registry/mutation writes**: atomic temp+rename in the target dir, canonicalized realpaths, symlink rejection, safe-charset names (`[a-z0-9-]`, case-insensitive-unique); last-writer-wins v1, no lock — registry edits are human-paced; documented as accepted risk.
- **Name→context resolution is a Node-only loader concern** (`config.ts`): core stays context-only and browser-safe; adapters resolve `roster` name → path → `BusContext` before calling core.
- **MCP session state is ephemeral**: in-memory active roster per stdio process (one per connection), init `SPACE_BUS_CONFIG` → registry default, reset on restart.
- **New library subpath `/registry`** (NOT `/server` — reserved by the OpenCode loader): exports registry + mutation + reconcile for Mothership; joins the Node-only browser-safety lane.
- **Management tool named `bus_registry`**: narrow action enum, per-action input validation via zod discriminated union, per-action errors; same factory/description-constant parity pattern as the five bus tools.
- **Every tool result names the resolved roster** — the split-brain/confused-deputy mitigation from document review.
- **Discovery `rosterPath`**: optional additive field, written at spawn, never logged, surfaced only in reconciliation output; registered rosters are named by hashing registry paths against state-dir keys (works for pre-field files), the field names unregistered daemons.

## Open Questions

### Resolved During Planning

- Registry file location/shape: XDG config-lane JSON, zod schema in contract (above).
- Concurrent-edit posture: last-writer-wins v1, documented (above).
- MCP session state: ephemeral in-memory (above).
- Management tool shape: single tool, action-enum discriminated union (above).

### Deferred to Implementation

- Exact per-action zod shapes for `bus_registry` (bounded by the discriminated-union decision).
- Whether the shared atomic-write helper extraction from `launchd.ts` is clean or the writers stay parallel (implementer's call after touching the code).
- CLI verb output formatting details (`--json` parity with existing verbs).

## Implementation Units

### Phase A — substrate (releasable as a minor: library-only)

- [x] **Unit 1: Registry schema + module**

**Goal:** Per-user roster registry: list/register/unregister/set-default/resolve-name, hardened per R15.

**Requirements:** R1, R2, R3, R15

**Dependencies:** None

**Files:**
- Modify: `src/contract.ts` (registry file schema, zod-only)
- Create: `src/registry.ts` (Node-only reader/writer)
- Test: `src/registry.test.ts`
- Modify: `test/setup.ts` (XDG_CONFIG_HOME isolation + leak guard), `src/browser-safety.test.ts` (registry joins Node-only lane)

**Approach:** Discriminated-union returns throughout; canonicalize on write AND read; reject symlinked registry entries; names validated `[a-z0-9-]`; registry absent ⇒ empty list (not an error). Atomic write per the launchd pattern.

**Execution note:** Test-first; registry writes in tests must land under an isolated XDG_CONFIG_HOME (extend the preload guard — the LaunchAgents incident must not repeat for `~/.config`).

**Test scenarios:**
- Happy path: register two rosters → list returns both with default flagged; resolve by name returns canonical path.
- Edge: absent registry file → empty list; duplicate name (case-insensitive) → ok:false naming the collision; unregister keeps roster file on disk.
- Error: symlinked registry entry → rejected naming the path; invalid name charset → ok:false; registry JSON corrupted → ok:false with actionable message (not a throw).
- Integration: register → set-default → resolve-name round-trip through the real file.

**Verification:** Suite green with zero real `~/.config/space-bus` writes; browser-safety test proves registry unreachable from browser lanes.

- [x] **Unit 2: Roster mutation module**

**Goal:** Create/edit roster files programmatically: `createRoster` (write + register in one op), add/remove/update project, edit server block.

**Requirements:** R4, R5, R7, R8

**Dependencies:** Unit 1 (createRoster registers)

**Files:**
- Create: `src/roster-edit.ts` (Node-only)
- Test: `src/roster-edit.test.ts`
- Modify: `src/browser-safety.test.ts`

**Approach:** Read-validate-mutate-validate-write: parse existing file through `rosterSchema`, apply the edit, re-validate the whole document (including localhost guard on any `baseUrl`), atomic-write only on full validity — invalid edit leaves the file byte-identical (AE4). `createRoster` defaults to managed-server mode.

**Execution note:** Test-first.

**Test scenarios:**
- Happy path: createRoster(name, root, managed) → valid file on disk + registered; addProject/removeProject/updateProject round-trips.
- Error: non-loopback baseUrl edit → ok:false, file unchanged (byte-compare); duplicate project name → ok:false; edit on missing/invalid roster file → ok:false actionable.
- Edge: remove last project → valid empty-projects roster; concurrent edit lost-update is accepted v1 behavior (document in test as characterization).

**Verification:** AE1/AE4 semantics pass; no partial writes under injected write failures.

- [x] **Unit 3: Discovery `rosterPath` + `/registry` subpath packaging**

**Goal:** Discovery files record their roster path at spawn; the new library surface ships as `/registry`.

**Requirements:** R13 (field), R6 (library surface), R8

**Dependencies:** Units 1–2

**Files:**
- Modify: `src/contract.ts` (optional `rosterPath` on discovery schema), `src/server.ts` (write it at spawn), `package.json` (exports `./registry`), `build.ts` (entry), `src/plugin-entry-guard.test.ts` (assert `./registry` is NOT the loader-resolved entry and root entry still single-function), `src/browser-safety.test.ts` (dist-level twin)
- Test: existing `src/discovery.test.ts` + `src/server.test.ts` additions

**Approach:** Field optional (old files parse); written from the canonicalized roster path `ensureServer` already holds; excluded from all log lines. Subpath exports `registry` + `roster-edit` + (later) `reconcile` symbols.

**Test scenarios:**
- Happy path: spawn → discovery file contains rosterPath matching the canonical roster.
- Edge: pre-field discovery file parses and attaches (no regression).
- Integration: packaged-artifact guard — built dist entry for `./registry` exists, root plugin entry unchanged (loader-emulation test still selects `dist/index.js` single-function namespace).

**Verification:** Changeset minor; Phase A releasable alone.

### Phase B — addressing (releasable as a minor: tool surfaces)

- [ ] **Unit 4: Loader + `roster` param on the five bus tools**

**Goal:** Any bus call can name a registry roster; every result names the roster it resolved.

**Requirements:** R9, R10 (plugin side), R12

**Dependencies:** Phase A

**Files:**
- Modify: `src/config.ts` (loadContext accepts roster-name source; unknown name → error listing known names), `src/tools/bus_roster.ts` + `bus_task.ts` + `bus_status.ts` + `bus_result.ts` + `bus_wait.ts` (optional `roster` input; result header line naming resolved roster), `src/format.ts` (roster-name header helper), `src/mcp.ts` + `src/index.ts` (wire param through)
- Test: `src/tools/bus_wait.test.ts` additions, `src/mcp-parity.test.ts`, `src/config.test.ts`

**Approach:** Resolution precedence everywhere: explicit `roster` param > surface ambient (plugin: `ctx.directory`; MCP: session active roster). Echo is a single shared formatter so both surfaces emit identical lines.

**Test scenarios:**
- Happy path: call with `roster: "personal"` resolves that roster's context (AE2); omitted param keeps today's behavior byte-identical (AE3 regression).
- Error: unknown name → error listing known rosters (AE5).
- Integration: parity test — all five descriptions + input schemas byte-identical across surfaces (AE7).

**Verification:** Existing 300+ tests green unchanged (no-param path untouched).

- [ ] **Unit 5: `bus_registry` management tool + MCP session state**

**Goal:** The sixth tool: list/use/create/register/unregister/set-default/add-project/remove-project/update-project; MCP active-roster session state.

**Requirements:** R10 (MCP session), R11, R16

**Dependencies:** Unit 4

**Files:**
- Create: `src/tools/bus_registry.ts` (factory + description constant + action-enum zod discriminated union)
- Modify: `src/index.ts`, `src/mcp.ts` (register + in-memory active-roster state), `src/mcp-parity.test.ts`
- Test: `src/tools/bus_registry.test.ts`

**Approach:** One factory, action-discriminated input; mutating actions call `roster-edit`; `use` sets MCP session state (plugin surface: `use` returns an actionable error — plugin resolution is directory-first, selection is an MCP concept). Results echo the affected roster.

**Test scenarios:**
- Happy path: list → use → subsequent omitted-roster call resolves the selected roster (F1); create → project add via tool (F2/AE1).
- Edge: `use` on plugin surface → actionable error; session state resets on process restart (ephemeral).
- Error: mutating action with invalid payload → per-action zod error naming the action.
- Integration: description parity for six tools; `isError` paths for every action.

**Verification:** AE2/AE3 full flows pass through the MCP bin against a temp registry.

### Phase C — reconciliation + CLI + docs (releasable as a minor)

- [ ] **Unit 6: Reconciliation**

**Goal:** One view: registered rosters + daemon liveness + drift flags (unknown state-dir daemons, dangling registry entries).

**Requirements:** R13 (naming strategy), R14

**Dependencies:** Phase A (field), Unit 5 (tool surface)

**Files:**
- Create: `src/reconcile.ts` (Node-only; exported on `/registry`)
- Modify: `src/tools/bus_registry.ts` (`reconcile` action), `src/cli.ts` (verb)
- Test: `src/reconcile.test.ts`

**Approach:** Enumerate registry (hash paths → match state dirs) + scan state dirs; liveness via existing `serverStatus`; unregistered daemons named from discovery `rosterPath` when present, else `unknown`. Listing + flags only — no repair actions.

**Test scenarios:**
- Happy path: registered roster with live daemon → running; with no state dir → not-running.
- Drift: state dir with discovery rosterPath not in registry → flagged unregistered with path; pre-field discovery → flagged unknown; registry entry whose roster file is deleted → flagged dangling.
- Edge: tampered discovery file (invalid JSON) → skipped with flag, not a throw (AE6).

**Verification:** AE6 semantics; loopback re-validation on any attach it performs.

- [ ] **Unit 7: CLI verbs + docs + changesets**

**Goal:** `space-bus roster list|create|register|unregister|default|add-project|remove-project|update-project|reconcile` (+ `--json`); README/AGENTS docs; changesets.

**Requirements:** R6 (CLI surface), docs for R1–R16

**Dependencies:** Units 1–6

**Files:**
- Modify: `src/cli.ts`, `README.md`, `AGENTS.md` (structure map + invariants: registry lane, sixth tool, reserved-subpath note), `.changeset/`
- Test: `src/cli.test.ts` additions

**Approach:** Thin wrappers over `registry`/`roster-edit`/`reconcile` mirroring the existing verb pattern (`--json` + plain output, exit codes).

**Test scenarios:**
- Happy path per verb (seam-injected); `--json` shape stable.
- Error: unknown verb/args → usage + exit 1.
- Test expectation for docs: none — prose only.

**Verification:** Full gates; docs PR-ready; three changesets tell the phased release story.

## System-Wide Impact

- **API surface parity:** six tools × two surfaces — the parity test is the contract; any description drift fails CI.
- **Interaction graph:** `loadContext` grows a resolution source; every existing caller (plugin tools, MCP, CLI, smoke) must behave identically when no name is supplied — regression-pinned by the untouched no-param tests.
- **Error propagation:** all new modules return discriminated unions; adapters convert (throw for plugin tools, `isError` for MCP) — matching the core invariant.
- **State lifecycle risks:** registry last-writer-wins (accepted, documented); MCP session state is process-local and ephemeral (documented in tool description).
- **Integration coverage:** packaged-artifact guards (entry-guard + dist browser-safety twin) must cover `/registry` — the two July-11 incidents both lived in this gap.
- **Unchanged invariants:** `SPACE_BUS_CONFIG` + `<dir>/spacebus.json` resolution, localhost guard, credentials never in registry/plist/argv, browser-safe core/contract/format/attach lanes, never `process.cwd()`.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| New subpath collides with a loader-reserved name | `/registry` chosen deliberately; entry-guard test asserts loader still resolves the plugin entry |
| Registry tests leak into real `~/.config` | Preload isolation + leak guard extended before any test lands (Unit 1 execution note) |
| Roster param silently changes no-param behavior | No-param paths pinned by existing suite; param plumbed as pure addition |
| Mothership adopts mid-phase | Incremental releases; Phase A alone gives it registry+mutation |
| Registry poisoning via symlink/path tricks | Canonicalization + symlink rejection + charset validation (R15), tested |

## Sources & References

- **Origin document:** docs/brainstorms/2026-07-11-multi-roster-support-requirements.md
- Substrate verification (explorer, this session): discovery schema fields, single-pin MCP, per-call core, Mothership consumption points
- Related PRs: #73 (reserved subpath), #80 (write hardening), #38 (/attach lane pattern)
