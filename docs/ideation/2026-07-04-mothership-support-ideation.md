---
date: 2026-07-04
topic: mothership-support
focus: Space Bus support for delegation to project agents in Mothership (marcusrbrown/mothership workspace-mission-control brainstorm)
mode: repo-grounded
---

# Ideation: space-bus support for Mothership

## Grounding Context

Mothership (Tauri v2 desktop, "renderer for the bus") binds to space-bus at R7 (rosters + live status "reusing space-bus core semantics"), R8 (SSE transcripts read from the server directly), R9 (blocked-question surfacing + inline answering), and F2 (prompt → control agent → bus_task dispatch → watch/steer), while freezing the bus tool surface. Verified gap: the published package exports only the plugin factory — roster resolution (localhost guard), discriminated-union core functions, pendingQuestion/steering, the tiered diff ladder (`diffSource`), and `findSessionDirectory` are all internal; tools return formatted strings. Documented no-match gaps requiring live probes: `/event` directory scoping on a multiplexed server, SSE reconnect/backfill, steering-mid-flight contract, question-answer mechanics, per-turn diff paging.

## Ranked Ideas

### 1. Export the headless core
**Description:** Subpath exports (`/core`, `/config`, `/format`) publishing the existing structured semantics: discriminated-union core functions, roster resolution with the localhost guard, diff-tier ladder with `diffSource`, `fetchPendingQuestion`/steering, `findSessionDirectory`.
**Warrant:** direct: Mothership R7 says "reusing space-bus core semantics"; package.json exports only `"."` (the plugin factory). Without this, Mothership forks or deep-imports fragile paths.
**Rationale:** One packaging change makes the bus a library and a plugin — the highest-leverage unlock for every Mothership requirement.
**Downsides:** Public API surface to keep stable; needs a deliberate "what's public" pass.
**Confidence:** 90% · **Complexity:** Low-Med · **Status:** Explored

### 2. Mission-control snapshot function
**Description:** One exported `snapshot(directory?)` returning `{projects, sessions, pendingQuestions, capped counts}` — structured, one call, the first paint for any renderer and a better primitive for the control agent.
**Warrant:** direct: F1/R7/R9 need this composite; today it takes N roster+status+question calls every consumer re-stitches.
**Rationale:** The bus computes all the pieces per tool call already; composing once kills renderer-side assembly everywhere.
**Downsides:** Snapshot shape becomes a contract; pagination posture needed for big rosters.
**Confidence:** 80% · **Complexity:** Low · **Status:** Unexplored

### 3. Executable probe pack → compatibility suite
**Description:** Promote the smoke-canary pattern into versioned probes for the documented unknowns (`/event` scoping, SSE reconnect/backfill, steering mid-flight, question mechanics, diff paging), runnable against any live server and consumable in Mothership CI.
**Warrant:** direct: Mothership's Deferred-to-Planning questions and this repo's learnings pass both list these as no-match gaps needing live probes.
**Rationale:** Probes-before-build already paid off once (plugin scoping probe); shipping them makes consumers inherit evidence instead of risk.
**Downsides:** Maintenance against upstream drift; requires a live server.
**Confidence:** 75% · **Complexity:** Med · **Status:** Unexplored

### 4. Typed OpenCode API contract module
**Description:** Export the zod schemas + inferred types the bus maintains for the server API (session, status map, turn diffs, question entries, vcs status) as a versioned module for consumers making direct HTTP calls.
**Warrant:** direct: Mothership's dependencies cite "known API sharp edges (see space-bus README)"; the schemas encoding them exist in core.ts, unexported.
**Rationale:** The bus survived an upstream API regression by encoding knowledge in schemas; publishing them turns institutional knowledge into inherited code.
**Downsides:** Version-coupling to upstream API evolution; schema churn on opencode releases.
**Confidence:** 75% · **Complexity:** Low-Med · **Status:** Unexplored

### 5. Structured dispatch metadata on tool results
**Description:** bus_task (and siblings) attach `{sessionId, project, mode}` metadata alongside the formatted string via the ToolResult metadata channel — string surface unchanged.
**Warrant:** direct: Mothership F2 needs the sessionId from the control agent's dispatch without regexing "Dispatched. Session ses_…".
**Rationale:** Smallest change that makes delegation machine-observable for any host rendering tool calls.
**Downsides:** Host handling of metadata varies; verify what OpenCode surfaces to observers.
**Confidence:** 70% · **Complexity:** Low · **Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Split into space-bus-core package | Heavier duplicate of exports idea — subpaths achieve it without a second npm pipeline |
| 2 | Question/steering state machines (3 variants) | YAGNI formalization; exporting existing functions covers the need |
| 3 | File-watched roster cache / roster-provider abstraction | Contradicts the deliberate no-caching hot-edit decision; premature |
| 4 | Version handshake / semantics version / capability manifest (3 variants) | Premature for one same-machine consumer; npm version + published schemas suffice |
| 5 | Full SSE client with reconnect/backfill in the package | Collides with Mothership's "app reads server directly" scope decision; probes + types carry the shareable part |
| 6 | Transcript snapshot builder / replay envelope | Server owns transcripts; renderer-side concern; build after probes prove the shape |
| 7 | Per-turn diff pager (standalone) | Folds into the core export (the ladder ships with it) |
| 8 | Probe→docs auto-generation | Overbuilt; probes + manual ce:compound is the working loop |
| 9 | Delegation trace lane | Transcripts already carry the trace |
| 10 | Bus emits events / daemon mode | Inverts the renderer-for-the-bus architecture; bus is stateless per call |
| 11 | Knowledge-server module | Docs-as-code with no action |
