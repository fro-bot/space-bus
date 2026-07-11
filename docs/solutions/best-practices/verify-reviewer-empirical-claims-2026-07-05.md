---
title: Verify a reviewer's empirically-checkable claims before acting on them
date: 2026-07-05
last_updated: 2026-07-10
category: best-practices
module: space-bus
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - a code review makes an empirically checkable claim about live behavior (endpoint auth, an API response, dead code)
  - a reviewer infers a fact from static reading or priors rather than from the running system
  - a reviewer rates a finding as a new (P0/P1) bug when it may describe pre-existing, intentional behavior
  - acting on the claim would change security-relevant code or remove a value
tags:
  - review-process
  - empirical-verification
  - workflow
  - static-analysis
  - oracle-review
---

# Verify a reviewer's empirically-checkable claims before acting on them

## Context

Code reviewers — including strong AI reviewers and multi-model Oracle passes — reason from static reading and priors, not from the running system. Most of what they surface is sound. But when a finding makes a claim about **live behavior** that a quick probe could confirm or refute, that claim is a **hypothesis**, not a fact. Acting on it directly — especially when it changes security-relevant code or deletes a value — can introduce the very bug the review was meant to prevent.

Two misfires in one session made this concrete.

## Guidance

When a review finding rests on an empirically-checkable claim, verify it against the live system (or a one-line probe) **before** acting. The check is almost always cheaper than the bug.

Claims that warrant a probe:

- "Endpoint X is unauthenticated" / "returns Y" — hit it with and without credentials.
- "This value is dead code / never occurs" — construct the input and observe. Runtime/stdlib behavior (URL parsing, path normalization, coercion) is a five-second REPL check, not a memory recall.
- "This branch is unreachable" — trace or exercise it before deleting it.

Two guardrails that make this cheap:

- Route the highest-stakes verification to an **independent** pass (Oracle) rather than trusting a single reviewer or a single fixer — independent review caught the regression below that the original reviewer and the fixer both missed.
- Prefer a **negative control**: don't just confirm the fix works, confirm the thing you're removing actually does nothing — by observing the failure its absence causes.

## Why This Matters

A confident reviewer is not a running system. Both misfires below would have shipped a real defect if the claim had been trusted:

1. **"`/doc` is unauthenticated."** A security reviewer and an adversarial reviewer both claimed the readiness probe hit `/doc`, which they said was public — making a `401` branch "dead code" and letting a stale password silently pass as "ready." A live probe settled it: `/doc` returns **401** unauthenticated, **401** with a wrong password, **200** with the correct one. The claim was false; the branch was live. (Switching the probe to `/session?limit=1` for consistency with the rest of the code was still worth doing — but as a hardening, not the described bug fix.)

2. **"`[::1]` is dead code."** A reviewer flagged `"[::1]"` in the loopback host set as unreachable — "`URL.hostname` never has brackets" — and a fixer removed it. That **silently broke IPv6 loopback**: `new URL("http://[::1]:4096").hostname` returns `"[::1]"` **with** brackets on both Node and Bun. Caught by an Oracle re-review plus a one-line `new URL().hostname` check. The "dead" value was load-bearing.

3. **"This is a P0: error/aborted status maps to `complete`" (and "a resolved-but-absent session maps to `complete`").** During the `bus_wait` review, two adversarial reviewers rated these P0 — new, spurious-wake bugs in the diff. Reading the actual `status()` code plus the status-map schema settled it: both behaviors are **pre-existing** in `status()` (an absent status-map entry has always derived not-busy → `complete`), consistent across all three emitters, and explicitly documented as a deferred `failed`-detection gap. The `error`/`aborted` status types the P0 assumed don't even appear in the observed `/session/status` shape (`type: z.string()`, open). Changing `wait()` to "fix" them would have *diverged* it from `status()`. Verified as established behavior, not blocked on speculation — kept as a documented residual instead.

The pattern in all three: a plausible static inference about runtime behavior — or about whether a behavior is *new* — stated with confidence, that a trivial check against the running system or the actual source flips. "Is this a new bug?" is as empirically checkable as "is this endpoint authenticated?": read what the code already did on the base branch before accepting that the diff introduced it.

## When to Apply

Any review finding whose truth depends on how the running system actually behaves — endpoint responses, auth requirements, parser/stdlib output, reachability of a branch or value — before you edit code on the strength of it. Especially when the action is a deletion, a security-relevant change, or "this can never happen."

## Examples

Live probe that refuted claim #1:

```sh
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/doc"                       # 401  (not public)
curl -s -o /dev/null -w "%{http_code}\n" -u "opencode:wrong"  "$BASE/doc"  # 401
curl -s -o /dev/null -w "%{http_code}\n" -u "opencode:$REAL" "$BASE/doc"   # 200
```

One-line check that refuted claim #2:

```js
new URL("http://[::1]:4096").hostname  // => "[::1]"  — brackets ARE kept; the value was live
```

Rule of thumb: if a finding says "X always/never happens at runtime" and X is checkable in under a minute, check it. Reviewers narrow where to look; the running system decides what's true.

## Related

- [browser-safe-library-boundary-cut-2026-07-04.md](./browser-safe-library-boundary-cut-2026-07-04.md) — the negative-control discipline (prove a guard fails on the violation before trusting it) is the test-side form of this same rule.
- [../integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md](../integration-issues/opencode-session-diff-empty-v1-16-2026-07-02.md) — a case where an initial wrong hypothesis was corrected by verifying against the actual API behavior.
