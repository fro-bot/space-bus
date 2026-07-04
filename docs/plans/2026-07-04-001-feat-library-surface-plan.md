---
title: 'feat: publish the space-bus library surface (subpath exports)'
type: feat
status: active
date: 2026-07-04
origin: docs/brainstorms/2026-07-04-library-surface-requirements.md
---

# feat: publish the space-bus library surface (subpath exports)

## Overview

Expose the bus's semantics as a public library: `@fro.bot/space-bus/core` (browser-safe, roster + credentials injected), `/config` (Node-side roster resolution), `/contract` (OpenCode API zod schemas + types), `/format` (pure formatters), plus a `snapshot()` composite. Root plugin-factory export and the four-tool surface are untouched; all subpaths ship experimental-labeled.

## Problem Frame

Mothership needs the bus's semantics (roster + localhost guard, status + pending questions, steering, diff ladder, session-directory resolution) but the package exports only the plugin factory — see the origin doc. The refactor cuts core's Node couplings (verified: `node:fs` existsSync at three call sites, `process.env` in authHeader, ambient roster re-resolution via `resolveContext → getRoster`) and publishes the pieces.

## Requirements Trace

R1–R9 from the origin doc: export surface (R1–R2), browser-safe core with boundary validation (R3–R5), config subpath (R6), snapshot (R7), contract module (R8), consumer docs (R9). AE1–AE5 + AE2b gate the units.

## Scope Boundaries

- No SSE client, no transcript handling, no new tools, no tool-surface changes.
- No stability promise beyond experimental labels; no second package.

### Deferred to Separate Tasks

- Structured dispatch metadata on ToolResults and the probe pack: separate ideation survivors (docs/ideation/2026-07-04-mothership-support-ideation.md #3, #5).
- Webview→127.0.0.1 CORS/origin reachability: Mothership's runtime concern (its brainstorm carries it).

## Context & Research

### Relevant Code and Patterns

- `src/core.ts` — Node couplings to cut: `existsSync` in resolveProjectOrErr / roster / findSessionDirectory; `authHeader()` env reads feeding every `api()` call; `resolveContext(directory?)` re-resolving the roster per call. 19 zod schemas (session, status map, todo, diff×3, turn×3, summary, message×3, question×4, vcs×2) are pure and extractable.
- `src/config.ts` — roster resolution + localhost guard + `getProjects` (expandedPath mapping); already the natural Node boundary.
- `src/format.ts` — pure, zero Node deps; exporting costs nothing technically.
- `build.ts` + `package.json` + `tsconfig.build.json` — two entrypoints and a root-only exports map today; declarations already emitted per-file into dist/.
- Test pins that must survive: `core.test.ts` (mocked-fetch semantics), `config.test.ts` (resolution + import purity), `mcp-parity.test.ts`, `index.test.ts` (fail-fast ordering), `format.test.ts` (exact strings), `version-injection.test.ts` (build shape).

### Institutional Learnings

- `docs/solutions/best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md` — no ambient cwd/env in plugin code paths; the same discipline now extends to credentials.
- `docs/solutions/integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md` — the diff ladder the contract module publishes.

## Key Technical Decisions

- **Injected context object**: core's exported functions take a `BusContext` — `{ roster, credentials? }` (exact field names settled in Unit 2) — produced by `/config`'s Node-side loader. Validation happens ONCE per exported-function call at entry via a single internal gate (the resolveContext successor): zod roster-shape parse (which copies — killing validate-then-mutate bypasses) + localhost guard, returning `ok:false` on violations; internal helpers trust the parsed copy. Never-throw holds for consumer-crafted input. `BusContext` is per-call/short-lived by contract — documented, not defended: consumers caching contexts across filesystem changes get stale `exists` flags, same class of staleness as any snapshot. Adapters resolve `{directory} → context` per call via config, preserving current external behavior. Contexts are never logged or serialized into error strings — errors carry message text only, never the context object (credentials stay unprintable).
- **Path existence moves to config**: `Project` gains an `exists` flag computed at roster load (Node side); core filters on the flag instead of calling `existsSync`. Browser consumers get rosters whose existence was determined where the filesystem lives. Kills `node:fs` in core with no behavior change (roster is re-read per call today — no added staleness).
- **Credentials as input**: `authHeader` logic moves behind the context — config supplies env-derived credentials on the Node path; browser consumers pass their own or none. Core never reads `process.env`.
- **Contract extraction direction**: schemas move to `src/contract.ts`; core imports from contract (never the reverse) so `/contract` stays dependency-pure (zod only).
- **`/format` ships in v1**: resolves the origin doc's open question — pure module, zero cost, and tool-identical rendering is exactly the parity a renderer wants.
- **snapshot() lives in `src/core.ts`** (not a separate module — settled): takes the same context; fans out per project with bounded concurrency (default 4, option to override); inherits the existing 100-cap with `sessionCountCapped` flags; per-project errors carry message text only (no response bodies, no context objects). Snapshot reads roster + status + questions per project directly — it does not route through findSessionDirectory's sequential probing (that path is for session-id lookups, not project status); no compounding fan-out.
- **Browser-safety is CI-enforced**: a test bundles `src/core.ts`, `src/contract.ts`, `src/format.ts` for a browser target with Node builtins forbidden, and additionally asserts the browser modules' graphs do NOT reach `src/config.ts` (config stays Node-only by construction) — mirrors the existing build-based version-injection test pattern.
- **Experimental labeling**: `@experimental` JSDoc on subpath entry modules + a README compatibility note ("shapes may change in minors; pin if you adopt").

## Open Questions

### Resolved During Planning

- format.ts fate: exported as `/format` (pure, costless, parity-valuable).
- snapshot() home: core (it's semantics, not resolution).
- Browser-safety enforcement: bundle-probe test in the suite.
- Experimental label mechanism: JSDoc + README note (both).

### Deferred to Implementation

- Exact `BusContext` field names and whether credentials ride the roster object or sit beside it — settle when cutting Unit 2's signatures.
- Concurrency limiter implementation (hand-rolled batching vs a tiny util) — whatever stays dependency-free.

## Implementation Units

- [ ] **Unit 1: Extract the contract module**

**Goal:** All OpenCode API zod schemas + inferred types live in `src/contract.ts` (zod-only imports); core imports from it.

**Requirements:** R8

**Dependencies:** None

**Files:**
- Create: `src/contract.ts`
- Modify: `src/core.ts` (import schemas from contract)
- Test: `src/contract.test.ts`

**Approach:** Mechanical move of the 19 schemas + type exports; keep names; add `@experimental` JSDoc at module head. No behavior change.

**Test scenarios:**
- Happy path: representative fixtures (session, status map, turn message with diffs, question entry, vcs status) parse to the expected shapes.
- Edge: unknown extra fields pass through (passthrough posture preserved).
- Integration: `bun test` whole suite green (core still parses identically).

**Verification:** typecheck clean; suite green; `src/contract.ts` module graph contains only zod.

- [ ] **Unit 2: Cut the core boundary (context injection)**

**Goal:** Core is browser-safe: no `node:fs`, no `process.env`, roster + credentials injected via a validated context; adapters resolve context through config.

**Requirements:** R3, R4, R5, R6; AE2, AE2b

**Dependencies:** Unit 1

**Files:**
- Modify: `src/core.ts`, `src/config.ts` (context loader, `exists` flag, credential supply), `src/tools/bus_*.ts`, `src/mcp.ts`, `src/index.ts`, `scripts/smoke.ts`
- Test: `src/core.test.ts` (adapt harness), `src/config.test.ts` (context loader), new boundary cases

**Approach:**
- `/config` exports the Node-side context loader (directory → context: roster with `exists`-flagged projects + env credentials).
- Core validates at the single entry gate per exported call (zod parse copies the input; localhost guard travels); `existsSync` call sites switch to the `exists` flag; `authHeader` derives from context credentials.
- Adapters/MCP/plugin factory swap `{directory}` plumbing for load-context-then-call — preserving the pinned fail-fast ordering: argument-shape validation (toDispatchArgs) runs BEFORE context loading, exactly as `index.test.ts` asserts today; that pin must stay green unmodified.
- `scripts/smoke.ts` migrates in this unit but LAST, after the suite is green on the new boundary — the canary keeps proving the old path until the new one is proven, then flips in the same commit.

**Execution note:** adapt the existing mocked-fetch harness first — it pins the semantics this unit must not move.

**Test scenarios:**
- Happy path: context loaded from a temp roster produces identical results to today's suite expectations (existing 60 tests keep passing, adjusted only for signatures).
- Error path: consumer-crafted context with non-localhost baseUrl → `ok:false` citing the localhost rule, no fetch attempted (AE2b).
- Error path: malformed roster object (missing projects, wrong types) → `ok:false`, nothing throws.
- Error path: mutate the roster object AFTER passing it — core's parsed copy is unaffected (validate-then-mutate cannot bypass the guard).
- Error path: no error string anywhere contains credential values (assert against a sentinel password).
- Edge: `index.test.ts` fail-fast pin passes unmodified (args error beats missing config).
- Edge: project with `exists: false` → same skip/error behavior existsSync produced.
- Integration: smoke PASS against the live server.

**Verification:** typecheck clean; suite green; grep: zero `node:fs`/`process.env` references in `src/core.ts`; smoke 11/11.

- [ ] **Unit 3: snapshot() composite**

**Goal:** One structured call returning projects + per-project status (busy counts, capped totals, truncation flags) + pending questions, bounded fan-out, sanitized per-project errors.

**Requirements:** R7; AE3

**Dependencies:** Unit 2

**Files:**
- Modify: `src/core.ts` (or `src/snapshot.ts` re-exported from core if size warrants)
- Test: `src/core.test.ts` (snapshot describe block)

**Test scenarios:**
- Happy path: multi-project roster → all projects present with status + questions merged.
- Error path: one project's status fetch fails → per-project error entry (message only), other projects intact, call resolves ok.
- Edge: project with `exists: false` → reported as such, not fetched.
- Edge: concurrency bound honored (mock records max in-flight ≤ default).

**Verification:** typecheck clean; suite green.

- [ ] **Unit 4: Packaging — subpath exports + browser-safety guard**

**Goal:** `/core`, `/config`, `/contract`, `/format` published with JS + declarations; root export and bin unchanged; browser-safety enforced in CI.

**Requirements:** R1, R2, R3; AE1, AE4

**Dependencies:** Units 1–3

**Files:**
- Modify: `package.json` (exports map with per-subpath types), `build.ts` (entrypoints), `tsconfig.build.json` (verify coverage)
- Create: `src/browser-safety.test.ts`
- Test: `src/version-injection.test.ts` (extend for new dist files if needed)

**Approach:** Add the four entrypoints to Bun.build; exports map entries with `types` per subpath; browser-safety test bundles core/contract/format with `--target browser` (or Bun.build target browser) and asserts success with Node builtins forbidden.

**Test scenarios:**
- Happy path: build emits dist/{core,config,contract,format}.js + .d.ts; pack dry-run includes them; root import shape unchanged.
- Error path (the guard): introducing a `node:fs` import into core/contract/format makes the browser-safety test fail (verify once by temporary mutation during development, not committed).

**Verification:** `bun run build` output complete; `npm pack --dry-run` lists intended files only; mcp-parity + version-injection tests green; browser-safety test green.

- [ ] **Unit 5: Docs + changeset**

**Goal:** README "Library surface" section (per-subpath import examples, experimental posture, browser credential/validation expectations); AGENTS.md structure map updated; minor changeset.

**Requirements:** R2, R9

**Dependencies:** Units 1–4

**Files:**
- Modify: `README.md`, `AGENTS.md`
- Create: `.changeset/library-surface.md` (minor)
- Test: `Test expectation: none — docs; gated by the accuracy cross-checks below`

**Verification:** every documented import path exists in the exports map; JSON/TS snippets parse; changeset present (review gate requires it); no machine-local paths.

## System-Wide Impact

- **Interaction graph:** adapters/MCP/plugin factory change how they enter core (context loader) — behavior pinned by the existing suite; smoke covers the live path.
- **Error propagation:** config-resolution errors now surface at the adapter boundary instead of inside core — error-precedence change mirrors the toDispatchArgs precedent (changeset callout, as before).
- **API surface parity:** two-surface parity (plugin map + MCP) unchanged; the library surface is a third consumer of the same functions — parity by construction where adapters migrated.
- **State lifecycle risks:** none new — roster stays read-per-call; no caching introduced.
- **Unchanged invariants:** four tools, names, output strings, discriminated unions, localhost-only servers, diff ladder, no telemetry.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Signature churn breaks a consumer path silently | Existing 60-test suite + smoke pin every adapter path; parity tests pin descriptions/args |
| Browser-safety regresses after v1 | CI bundle-probe test fails on any Node-builtin import in public browser modules |
| Contract schemas drift from upstream API | Already true today (internal); publishing changes visibility, not risk; experimental label + pin guidance |
| Exports map/type resolution quirks in consumer bundlers | Per-subpath `types` fields; AE1-style Vite probe can be added on Mothership's side |

## Documentation / Operational Notes

- Changeset: minor ("library surface: subpath exports…"), with the error-precedence callout.
- Release timing batches with the open version PR flow as usual; no operator steps.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-04-library-surface-requirements.md](../brainstorms/2026-07-04-library-surface-requirements.md)
- Repo research: core import graph, schema inventory (19), call graph, packaging deltas, test-pin map (this session)
- Ideation: [docs/ideation/2026-07-04-mothership-support-ideation.md](../ideation/2026-07-04-mothership-support-ideation.md)
