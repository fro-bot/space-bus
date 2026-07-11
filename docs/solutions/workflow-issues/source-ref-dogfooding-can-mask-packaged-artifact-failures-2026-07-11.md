---
title: Source-ref dogfooding masks packaged-artifact failures
date: 2026-07-11
last_updated: 2026-07-11
category: workflow-issues
module: space-bus
problem_type: workflow_issue
component: release
symptoms:
  - "a plugin/library works for months in dogfooding, then fails the first time it's consumed by published name"
  - "a packaging bug ships in multiple consecutive releases unnoticed"
  - "green CI + live daily use, yet the published artifact is broken on load"
  - "a browser-safety/bundling test passes from src/ while the published dist artifact fails to bundle downstream"
root_cause: process_gap
resolution_type: process_change
severity: medium
tags:
  - dogfooding
  - source-ref
  - packaged-artifact
  - npm-release
  - release-validation
  - blind-spot
---

# Source-ref dogfooding masks packaged-artifact failures

## Problem

`@fro.bot/space-bus` shipped a package-`exports`-map bug that made the plugin fail to load from npm across **four consecutive releases (0.6.0–0.9.0)** — while it was being dogfooded live the entire time. The bug (`./server` colliding with OpenCode's reserved plugin entrypoint; see the integration doc) only manifests through **npm package-entrypoint resolution**, and the dogfood path never exercised it.

## Symptoms

- The plugin loaded and worked perfectly in the operator workspace for months.
- The first `@fro.bot/space-bus@<name>` npm-name pin (0.9.0) failed immediately with `Plugin export is not a function`.
- Every release 0.6.0–0.9.0 was equally broken as a published plugin — the failure was structural, not version-specific.

## Root Cause

The operator workspace referenced the plugin by **source-file path** (a file ref to `src/index.ts`) for dogfooding from 0.2.x onward. A source ref imports the entry module directly and **bypasses npm package-entrypoint resolution entirely** — it never consults the `exports` map, so the reserved-subpath collision was invisible. 0.1.0 (the last npm-name pin before this) predated the `./server` subpath, so no dogfood run had ever resolved the package the way a real consumer does.

The dogfood path and the consumer path diverged at exactly the layer where the bug lived: **module resolution of the packaged artifact.**

## What Didn't Work

- **Green CI.** The unit/integration suite imported from source or built `dist/` files directly; nothing resolved the package *by its exports map* the way OpenCode's loader does.
- **Daily live use.** Real usage proved the *code* worked — it could not prove the *package* resolved, because the source ref shortcut that resolution.

## Second Instance (same day): src-bundle test vs. published dist

Hours after this doc was written, the same blind spot bit again at a different layer. The **browser-safety CI gate** bundled `src/core.ts`/`src/contract.ts`/`src/format.ts` for a browser target and asserted no `node:*` imports — and passed — while the **published** `dist/core.js`, `dist/contract.js`, `dist/format.js` all began with Bun's node-target `createRequire(node:module)` prelude, injected by `build.ts` bundling them in the node-target `Bun.build` call. The browser-safety *contract* held in source and was broken in the artifact; it surfaced only when Mothership's Vite build consumed 0.10.0 by npm name and had to ship a package patch stripping the prelude (marcusrbrown/mothership#22). Upstream fix proposed in fro-bot/space-bus#77 (open at time of writing, targets 0.10.1): build browser-safe subpaths with `target: "browser"` and extend `browser-safety.test.ts` to scan the built `dist/*.js`.

Same structure as the loader collision: the validation ran against a *reconstruction* of the artifact (an in-memory src bundle), not the artifact itself. Any contract you assert from `src/` — entrypoint shape, browser-safety, export surface — needs a twin assertion against `dist/`.

## Solution / Process Change

- **Dogfood the published artifact path periodically, not just the source path.** At least once per release train, pin the plugin by npm name (or install the tarball) and confirm it loads — don't rely on a source-file ref as the only exercise.
- **Add a packaged-artifact test to CI** that emulates the *consumer's* resolution, not your import convenience. For this class: read `package.json`, resolve the entry the way the loader does (`exports["./server"]?.import ?? main`), import *that*, and assert the shape (`src/plugin-entry-guard.test.ts`). This closes the structural gap in CI so it can't span four releases again.
- **Verify the release, then flip the pin.** After each publish, probe the tarball's resolved entry before trusting it in the operator workspace.

## Why This Works

The bug survived because the validation path was structurally incapable of seeing it — a source ref and an npm-name pin are *different resolution mechanisms*. Making the test (and a periodic dogfood) resolve the artifact the way a real consumer does aligns the thing you validate with the thing you ship. It's the packaging analogue of "test the real thing, not the seam."

## Prevention

- **Name the divergence explicitly:** if your dogfood uses a source/file/link ref, write down that it does *not* cover packaging, and own a separate check that does.
- **One packaged-artifact resolution test per public entrypoint** is cheap insurance against a whole class of exports-map / `main` / `types` mistakes.
- **Every src-level contract gate needs a dist-level twin.** If a CI test asserts a property by building from `src/`, add the same assertion against the built `dist/` output — the bundler's target/config can break in the artifact what holds in source.

## Related

- [../integration-issues/opencode-plugin-reserved-subpath-loader-resolution-2026-07-11.md](../integration-issues/opencode-plugin-reserved-subpath-loader-resolution-2026-07-11.md) — the concrete packaging bug this blind spot let through, and the loader-emulation regression guard.
- [../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md](../workflow-issues/orchestrator-verify-claims-not-assertions-2026-07-05.md) — same "verify reality, not the convenient path" discipline: a green source-path dogfood is not proof the published artifact works.
- [../best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md](../best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md) — the sibling "test the real thing, not the seam" lesson in the process-lifecycle domain.
