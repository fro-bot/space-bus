---
title: Browser-safe library boundary cut — injected context, traveling guards, negative-controlled safety tests
date: 2026-07-04
category: best-practices
module: space-bus
problem_type: best_practice
component: core
severity: high
applies_when:
  - making a Node-coupled module importable in browser/webview contexts
  - moving a security guard from config-load time to a call boundary
  - writing CI tests that assert bundle-level browser safety
tags: [browser-safety, context-injection, zod, localhost-guard, bun-build, credentials, negative-control]
---

# Browser-safe library boundary cut

## Context

The library-surface refactor (PR #25) made `src/core.ts` browser-safe so renderers can import bus semantics directly. Core previously read `process.env` (credentials), called `existsSync` (project paths), and re-resolved `spacebus.json` per call — with the localhost guard firing at roster load. All three couplings had to move without changing tool behavior, and the security guard had to survive the move.

## The Pattern

**1. Inject a validated context; validation copies.**
Ambient inputs (env credentials, filesystem-derived flags, config files) become one context object produced by a Node-only loader (`loadContext()` in `src/config.ts`). Core validates the injected context at a single entry gate per exported call: a zod parse — which **copies** the input, so a caller mutating the object after passing it cannot bypass what was validated — plus the security checks. Internal helpers trust the parsed copy; nothing downstream re-validates.

**2. Guards travel with the data, not the loader.**
The localhost guard originally lived where the roster was loaded. Once the roster is injectable, load-time validation is bypassable by construction — the guard must re-fire at the consuming boundary (core's gate), or a consumer-crafted context defeats it. Rule: when data crosses a trust boundary by injection, every invariant previously enforced at its origin must be re-enforced at the destination.

**3. Filesystem facts become load-time flags.**
`existsSync` call sites became an `exists: boolean` computed by the loader. Honest framing: this converts point-in-time checks into snapshot state — fine when contexts are per-call/short-lived (document that contract), wrong if consumers cache contexts across filesystem changes.

**4. Credentials are unprintable by test.**
A sentinel-credential test sets a recognizable password, forces every reachable error path, and asserts no error string contains it. Cheap, durable, and it pins the "errors carry message text only, never the context" rule.

## The Testing Trap

Bun's browser-target build **silently stubs `node:*` builtins into empty modules instead of failing** — a bundle-then-string-check test passes even with a real `node:fs` import in the graph. And import-level checks miss Node *globals* entirely: `Buffer.from()` on the auth path sailed through the first guard and would have thrown `ReferenceError` in a real webview (caught by review, not by the test).

The working guard (`src/browser-safety.test.ts`):
- a `Bun.build` resolver plugin that **hard-fails on any `node:*` resolution** (not output inspection),
- forbidden-pattern checks on the bundle output for Node globals: `Buffer.from(`, `process.env`, `require(`,
- a config-isolation assertion (browser graphs must not reach the Node-only module),
- **negative controls**: temporarily introduce the violation, watch the test fail, remove it. Both guards here were negative-controlled during development; the first iteration of the first guard provably missed the leak class it was written for.

## Why This Matters

"Browser-safe" claimed at the package level is a contract consumers build on. The failure modes are all silent-until-runtime: stubbed builtins produce empty-module behavior, `Buffer` throws only when the credential path executes, and a bypassed guard is invisible until someone injects a non-localhost URL. Every one of these is catchable in CI — but only with guards that were proven to fire.

## When to Apply

Any package publishing browser-consumable subpaths from a Node codebase; any refactor that turns ambient state into injected parameters; any test claiming a bundle property (verify the test fails on a violation before trusting it).
