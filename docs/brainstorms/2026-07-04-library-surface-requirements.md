---
date: 2026-07-04
topic: library-surface
---

# Space Bus Library Surface

## Summary

Publish a public library surface for `@fro.bot/space-bus` via subpath exports: a browser-safe core (structured bus semantics with the roster injected), a Node-side config module (roster resolution, localhost guard, env override), a composite `snapshot()` for one-call mission-control state, and the zod schema/type contract for the OpenCode server API. The root export stays the plugin factory; the tool surface is untouched. All new subpaths ship experimental-labeled.

---

## Problem Frame

Mothership — the Tauri desktop "renderer for the bus" (see `marcusrbrown/mothership` workspace-mission-control brainstorm) — needs the bus's semantics: roster resolution with the localhost guard, session status with pending questions, steering, the tiered diff ladder, and session-to-directory resolution. Its brainstorm assumes "reusing space-bus core semantics" (R7). But the published package exports exactly one thing: the plugin factory. Every semantic Mothership needs is internal, and the four tools emit formatted strings. Without a public surface, the app forks the logic, deep-imports fragile dist paths, or regexes tool output — three flavors of drift against the component that already survived one upstream API regression by encoding the sharp edges in schemas.

---

## Actors

- A1. Plugin hosts (OpenCode/harness workspaces): consume the root export; must see zero change.
- A2. Mothership webview (browser context): imports the browser-safe core and contract types directly.
- A3. Mothership Node/Rust-sidecar side: imports config resolution to read `spacebus.json` and feed rosters to the webview.
- A4. MCP facade + plugin adapters (this repo): become consumers of the same public surface — parity by construction.

---

## Requirements

**Export surface**

- R1. The package publishes subpath exports — `@fro.bot/space-bus/core`, `/config`, `/contract` — alongside the unchanged root plugin-factory export; the `bus_*` tool surface does not change.
- R2. Every new subpath is experimental-labeled: docs and changesets state that shapes may change in minor releases until stabilized.

**Browser-safe core**

- R3. The core subpath is importable in a browser context: no Node-builtin imports (fs, os, path) in its module graph.
- R4. Core functions take the roster (or the pieces they need) as input instead of resolving it ambiently; filesystem-based resolution lives only in the config subpath. Injected input is validated at the core boundary — malformed rosters and non-localhost `baseUrl` values return `ok:false` (the localhost guard travels with the roster type; the never-throw boundary holds for consumer-crafted input). Credentials likewise enter as input in browser contexts — core does not read `process.env` ambiently. Behavior semantics (discriminated-union results, tiered diff ladder with `diffSource`, pending-question detection, steering, session-to-directory resolution) carry over unchanged.
- R5. The plugin adapters and MCP facade are updated to consume the public core + config surface where practical, without changing tool behavior; parity between the tool semantics and the library surface is verified by the existing test suite either way.

**Config subpath (Node)**

- R6. The config subpath exports roster resolution as it exists today: `spacebus.json` discovery from a directory, `SPACE_BUS_CONFIG` override with its path rules, `~` expansion, and the localhost guard as a reusable validation.

**Snapshot**

- R7. A `snapshot()` composite returns structured mission-control state in one call: projects (roster), per-project session status (busy counts, capped totals inheriting the existing 100-cap with explicit truncation flags), and pending questions. It fans out with bounded concurrency; partial failures are reported per project (message text only — no raw server response bodies), not thrown.

**Contract module**

- R8. The contract subpath exports the zod schemas and inferred types the bus maintains for the OpenCode server API (session, status map, turn messages/diffs, question entries, vcs status), labeled as tracking upstream — consumers making direct HTTP calls parse through the same schemas the bus uses. The label states the schemas are parsing aids, not a security boundary or compatibility guarantee; adopters pin versions.
- R9. The README documents the library surface: per-subpath import examples, the experimental posture, and the credential/validation expectations for browser consumers.

---

## Acceptance Examples

- AE1. **Covers R1, R3.** Given a Vite browser build importing `@fro.bot/space-bus/core` and `/contract`, when it bundles, no Node-builtin externals are required and the bundle succeeds.
- AE2. **Covers R4, R6.** Given a roster object loaded via the config subpath on the Node side, when it is passed to core functions in any context, success-path results are behaviorally equivalent to today's tool behavior for the same inputs; error surfaces may differ only where config resolution was hoisted out of core.
- AE2b. **Covers R4.** Given a consumer-crafted roster object with a non-localhost `baseUrl`, when any core function receives it, the result is `ok:false` citing the localhost rule — no fetch is attempted, nothing throws.
- AE3. **Covers R7.** Given the five-project Fro Bot roster with one delegate blocked on a question, when `snapshot()` runs, the result contains all five projects' status and the pending question, and a project whose path is missing appears as a per-project error entry rather than failing the whole call.
- AE4. **Covers R1, R5.** Given the published package, when the existing plugin and MCP surfaces run the smoke canary and parity tests, behavior and output are unchanged.
- AE5. **Covers R8.** Given Mothership fetching `/session/status` directly, when it parses the response with the contract module's schema, it gets the same typed shape the bus's own status path uses.

---

## Success Criteria

- Mothership implements its roster/status/needs-attention panels importing only published subpaths — zero forked bus logic, zero deep imports, zero string parsing.
- This repo's own adapters run on the public surface (parity by construction, verified by existing tests).
- A downstream planner can produce the export/refactor plan from this doc without inventing API shapes.

---

## Scope Boundaries

- No SSE client, no transcript handling — Mothership reads the server's event feed directly per its own scope decision.
- No new tools and no tool-surface changes; structured dispatch metadata and the probe pack are separate ideation survivors, not this work.
- No stability promise beyond experimental labels; no compatibility matrix.
- No second npm package — subpaths only.

---

## Key Decisions

- Browser-safe core (roster injected) over Node-only: costs a core entry-point refactor now, lets the webview import logic/types directly and saves an IPC hop per read later.
- Subpath exports over a package split: one npm pipeline, root untouched for plugin hosts.
- Experimental-labeled everything: no premature semver promise until Mothership proves the shapes.
- Adapters consume the public surface (R5): prevents public/internal drift permanently.

---

## Dependencies / Assumptions

- Mothership's Tauri architecture (Rust core/sidecar owns processes; webview renders) — the Node-side config consumer exists there.
- The core refactor is real work, not re-exporting: core today imports `node:fs` directly and re-resolves the roster internally per call (`resolveContext` → `getRoster`); the refactor moves that boundary out and the plugin/MCP adapters absorb the signature change invisibly.
- Browser-safe means bundle-safe, not call-proven: whether Mothership's webview can fetch `127.0.0.1` from its `tauri://` origin is Mothership's runtime concern (its brainstorm already flags the server `--cors` flag / Rust-proxy options). AE1 asserts bundling; runtime reachability is verified on Mothership's side.
- Packaging follow-through: subpath exports need the exports map, build entrypoints, and per-subpath declarations extended (current build bundles only index + mcp).
- Bundler subpath-exports support in Mothership's toolchain (standard `exports` map semantics).

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Exact subpath inventory and what `format.ts` becomes (export as `/format`, fold into core, or omit from v1).
- [Affects R7][Technical] Where `snapshot()` lives (core vs its own subpath) and its concurrency bound default.
- [Affects R3][Technical] Enforcement mechanism for browser-safety (build-time check, eslint boundary, or a browser-bundle CI probe like the existing ESM-shape smoke).
- [Affects R2][Technical] How the experimental label is carried (README section, JSDoc `@experimental`, or both).

---

## Sources / Research

- **Origin ideation:** [docs/ideation/2026-07-04-mothership-support-ideation.md](../ideation/2026-07-04-mothership-support-ideation.md) (idea #1, absorbing #2 and #4)
- Mothership brainstorm: `marcusrbrown/mothership` `docs/brainstorms/2026-07-03-workspace-mission-control-requirements.md` (R7–R9, F2, dependencies citing space-bus semantics)
- Current package surface: `package.json` (root-only export), `src/core.ts`, `src/config.ts`, `src/format.ts`
