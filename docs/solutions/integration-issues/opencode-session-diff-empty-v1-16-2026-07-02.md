---
title: OpenCode session diff endpoint always empty since v1.16.0
date: 2026-07-02
category: integration-issues
module: space-bus
problem_type: integration_issue
component: tooling
symptoms:
  - "GET /session/{id}/diff returns [] even when the delegated session verifiably created or modified files"
  - "bus_status/bus_result report '(no changes)' while the delegate's reply and the working tree confirm a new file"
root_cause: wrong_api
resolution_type: code_fix
severity: medium
related_components:
  - development_workflow
tags:
  - opencode
  - session-diff
  - session-summary
  - harness-carry
  - per-turn-diffs
  - vcs-status
---

# OpenCode session diff endpoint always empty since v1.16.0

## Problem

On OpenCode v1.16.0+ builds without the #33444 fix, bare `GET /session/{id}/diff` (no query params) returns `[]`, so any consumer reading a session's file changes from that endpoint sees "(no changes)" regardless of what the session actually did. For space-bus this made `bus_status`/`bus_result` misreport delegate work — a false "no changes" that could hide failed or unexpected delegate activity.

## Symptoms

- E2E canary: a delegated session created a new file on disk (confirmed by `git status` and the delegate's own reply), but `bus_result` rendered `(no changes)`.
- `GET /session/{id}/diff` → `[]` for sessions with tracked and untracked changes alike (observed on 1.17.13).

## What Didn't Work

- **"Untracked files are excluded from session diffs" hypothesis** — plausible (a plain `git diff` skips untracked files) but wrong, and it shipped a misleading README note. The endpoint is empty for *tracked* edits too.
- **Repo-wide `GET /vcs/status` fallback only** — catches the changes but at the wrong scope: it reflects the whole working tree, so concurrent sessions in the same repo bleed into each other's reported diffs. Acceptable as a last resort, wrong as the primary strategy.

## Solution

Two-pronged:

**1. Bus-side tiered diff resolution** (`src/core.ts`, space-bus `b22368d`) — per-turn diffs on user messages survived the upstream change, including untracked files (extra fields like the patch text are preserved when present). Aggregate them (last turn wins per file, mirroring upstream PR #33444's semantics) before falling back:

```ts
// tier 2: aggregate per-turn diffs from user messages
const byFile = new Map<string, z.infer<typeof diffEntrySchema>>();
for (const m of messages) {
  if (m.info.role !== "user") continue;
  for (const d of m.info.summary?.diffs ?? []) {
    byFile.set(d.file ?? `<unknown:${byFile.size}>`, d); // last turn wins
  }
}
```

Order: `/session/{id}/diff` (`diffSource: "session"`) → per-turn aggregation (`"turns"`, session-scoped, no caveat) → `/vcs/status` (`"working-tree"`, labeled repo-wide). The `diffSource` discriminator travels with the data so adapters can label provenance honestly. The aggregation reads a 100-message window (`?limit=100`); very long sessions would need pagination.

**2. Upstream remediation** — the open upstream fix anomalyco/opencode#33444 was carried into the harness CLI distribution (fro-bot/agent#1102), with a recorded drop condition: remove the carry when #33444 lands upstream.

## Why This Works

Upstream #30127 (v1.16.0, perf fix) removed automatic full-session snapshot diffs and zeroes `session.summary`. The server route for bare `/session/{id}/diff` calls `SessionSummary.diff()` without a `messageID`, which short-circuits to `[]` (`packages/opencode/src/session/summary.ts`). But `summarize()` still computes and stores **per-turn** diffs on each user message (`info.summary.diffs`) — that data is session-scoped and includes untracked files. Aggregating it client-side (within the fetched message window) reconstructs what the session-level summary used to be, which is also what upstream #33444 does server-side.

## Prevention

- When an API returns empty-but-should-have-data: read the handler source and probe alternate query params (`?messageID=` here) before concluding data is missing — the data was one parameter away.
- Search upstream issues/PRs before filing or working around: #30877, #32852, #34620, #29460 had already mapped this regression, and #33444 already contained the fix semantics worth mirroring.
- Attach provenance discriminators (`diffSource`) when a consumer can be fed from multiple sources of differing fidelity — never let a repo-wide fallback masquerade as session-scoped data.
- Record a drop condition whenever carrying an unmerged upstream patch, so the carry is removed instead of fossilizing.

## Related Issues

- anomalyco/opencode#30127 — `fix(opencode): remove automatic full session diffs` (the regression source)
- anomalyco/opencode#33444 — `fix(session): restore session summary from per-turn diffs` (upstream fix, carried)
- anomalyco/opencode#30877, #32852, #34620, #29460 — reported variants
- fro-bot/agent#1102 — `feat(harness): carry OpenCode #33444 to restore session summary`
- fro-bot/agent `docs/solutions/workflow-issues/harness-base-version-source-of-truth-2026-06-12.md` — adjacent carry/version-drift guidance (moderate overlap)
