---
title: Verify claims against ground truth — subagent assertions and external state both drift
date: 2026-07-05
last_updated: 2026-07-10
category: workflow-issues
module: space-bus
problem_type: workflow_issue
component: development_workflow
severity: medium
applies_when:
  - a delegated subagent reports a failure as "flaky", "unrelated", or "pre-existing"
  - the orchestrator is about to act on a claim that a cheap check could confirm or refute
  - continuing a long session where external state (merged PRs, releases) may have changed out-of-band
tags:
  - orchestration
  - subagent-verification
  - state-drift
  - flaky-tests
  - empirical-verification
  - workflow
---

# Verify claims against ground truth — subagent assertions and external state both drift

## Context

Across one long orchestration session, the orchestrator acted on two kinds of unverified claim and had to walk both back. Both are the same failure at different sources: **trusting an assertion instead of checking the ground truth it's about.**

1. **Dismissive subagent claims.** A delegated fixer reported a failing test as "1 pre-existing flaky test… fails identically on the unmodified branch via `git stash`." Two things were wrong: the test was *added on this branch* (so it cannot pre-exist on main), and it was genuinely flaky (~1-in-3), not "unrelated." Accepting the claim would have shipped a flaky test on a reliability fix. A second fixer earlier called a `/doc` auth branch "dead code" — also wrong, refuted by a live probe.

2. **Stale external-state assumptions.** Mid-flow, the orchestrator referenced PRs #43 and #44 as "pending your merge" — they had already been merged out-of-band. The in-session belief about board state had drifted from reality.

## Guidance

**When a subagent makes an exculpatory or dismissive claim, verify it before accepting** — those claims are exactly the ones that let a real defect through. Specifically:

- "flaky / intermittent" → reproduce it yourself. Run the test in isolation N times (`for i in $(seq 1 25); do ... ; done`) and count. "Flaky" is a hypothesis about a race, not a pass.
- "pre-existing / fails on main too" → **reproduce it on a clean checkout of the base branch, not on your working branch.** A subagent's `git stash` A-B still runs against the branch's own HEAD (which already contains the change under suspicion), so it proves nothing about main. Add a worktree on the base SHA (`git worktree add /tmp/base <main-sha>`) and run the test there in isolation N times. This single standard resolves both directions: a test *added on the branch* won't exist on main (claim impossible), and a test that *does* exist on main can be measured there (claim confirmed or refuted by its real failure rate). The narrower `git show main:<path>` existence check only catches the first case — it misses a genuinely pre-existing flake that lives on main.
- "unrelated to my change" → confirm by running the thing on both refs (clean base worktree vs branch), not by reasoning.
- "dead code / never happens / X is unauthenticated" → probe the running system (see the companion empirical-claims doc).

**At each continuation boundary in a long session, re-verify external state rather than carrying an in-session belief.** PRs get merged, releases publish, branches move — often by the human, out-of-band. Before referencing PR/release/branch state, query it (`gh pr view`, `npm view`, `git pull`). The cost of a `gh pr list` is trivial; the cost of telling the user something they already did is a correction.

## Why This Matters

The orchestrator's leverage is delegation, but delegation moves the *work* out, not the *responsibility*. A subagent optimizes to complete its task and will rationalize a failure it can't easily fix ("flaky", "pre-existing") — those are the highest-value claims to distrust, because they're the ones that end with a defect merged under a green check. Likewise, a long session accumulates stale beliefs about a world that keeps changing underneath it; acting on those beliefs wastes the human's attention on corrections. Both are cheap to prevent with a check and expensive to discover after the fact.

## When to Apply

- Any delegated result whose summary explains *away* a problem (flaky, unrelated, pre-existing, environmental, transient) rather than fixing it — verify the explanation.
- Any point where the orchestrator is about to state or act on external state (PR merged/open, version released, branch present) after time has passed or the human has been active — re-query first.
- Any empirically-checkable claim in a review or a fix rationale — probe, don't trust.

## Examples

Reproduce a "flaky" claim instead of accepting it:

```sh
# subagent said "1-in-3 flaky, unrelated" — verify
for i in $(seq 1 25); do
  bun test src/server.test.ts -t "escalates to group SIGKILL" 2>&1 | grep -oE "[0-9]+ (pass|fail)"
done
# result: genuinely intermittent → root-cause it (zombie-reap race), don't ship it
```

Reproduce a "pre-existing" claim on a clean base-branch worktree — the evidentiary standard, not a stash on the working branch:

```sh
# subagent: "pre-existing flake, confirmed on unmodified branch via git stash"
# a stash on the branch still includes the branch's commits — check MAIN itself:
git worktree add /tmp/sb-main-check <main-sha>
cd /tmp/sb-main-check && bun install >/dev/null
pass=0; fail=0
for i in $(seq 1 15); do
  bun test src/server.test.ts -t "escalates to SIGKILL" >/dev/null 2>&1 && pass=$((pass+1)) || fail=$((fail+1))
done
echo "MAIN: $pass pass / $fail fail"   # ~33% fail on main → genuinely pre-existing → split into its own PR
git worktree remove /tmp/sb-main-check --force
```

The scope decision hinges on the result: **pre-existing** (reproduces on clean main) → split into its own focused PR, don't bundle it into the feature; **introduced** (only on the branch) → fix it in the feature PR. In this session the worktree showed ~33% failure on main, so the flake was split into its own PR while the feature PR stayed clean.

Note the earlier `git show main:<path>` existence check is a weaker special case — it correctly flags a test that was *added on the branch* (can't pre-exist), but a genuinely pre-existing flake exists on main and passes that check. The worktree-reproduction standard covers both.

Re-check board state at a continuation boundary:

```sh
gh pr view 44 --json state -q .state   # MERGED — don't call it "pending"
npm view @fro.bot/space-bus version    # ground truth, not the last value you remember
```

## Related

- [../best-practices/verify-reviewer-empirical-claims-2026-07-05.md](../best-practices/verify-reviewer-empirical-claims-2026-07-05.md) — the same discipline applied to *reviewer* claims about live behavior; this doc extends it to *subagent* claims about their own work and to stale external state.
- [../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md](../integration-issues/managed-stop-leaked-wrapper-child-2026-07-05.md) — the reliability fix where the "flaky/pre-existing" claim, if trusted, would have shipped a flaky test.
- [../best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md](../best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md) — the sibling case: a green *mock-injected* test suite is itself a "claim" that needs a real-process ground-truth check; both are about not trusting a proxy for the thing itself.
