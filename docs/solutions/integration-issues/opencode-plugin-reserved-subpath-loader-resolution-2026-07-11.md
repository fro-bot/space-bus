---
title: OpenCode resolves exports["./server"] before main, so ./server is a reserved plugin entrypoint
date: 2026-07-11
category: integration-issues
module: space-bus
problem_type: integration_issue
component: packaging
symptoms:
  - '`failed to load plugin path=@fro.bot/space-bus@0.9.0 error="Plugin export is not a function"` in the OpenCode log'
  - "the plugin loads fine from a source-file ref but fails when pinned by npm name"
  - "dist/index.js is a clean single default function, yet the loader still rejects the package"
root_cause: wrong_api
resolution_type: code_fix
severity: high
tags:
  - opencode
  - plugin
  - package-exports
  - subpath-exports
  - loader-resolution
  - regression-guard
---

# OpenCode resolves exports["./server"] before main, so ./server is a reserved plugin entrypoint

## Problem

`@fro.bot/space-bus@0.9.0` failed to load in OpenCode with `error="Plugin export is not a function"` — even though the plugin entry (`dist/index.js`) is a single default plugin function and had not changed. Every npm-loaded version **0.6.0–0.9.0** was broken the same way.

## Symptoms

- Log line on every TUI start: `failed to load plugin path=@fro.bot/space-bus@0.9.0 error="Plugin export is not a function"`.
- The bus tools silently absent from the session (and, downstream, Claude Desktop's board access dead).
- Probing `dist/index.js` directly shows a clean namespace: `[["default","function"]]` — contradicting the error.

## Root Cause

OpenCode's plugin loader resolves a plugin package's entry as **`exports["./server"]` before falling back to `main`**. Since 0.6.0 the package mapped `./server` → `dist/server.js` (the managed-server lifecycle API), so the loader imported *that* module, iterated `Object.values(mod)`, hit the first value — a numeric constant `SUPERVISE_FAILURE_THRESHOLD` — and threw `Plugin export is not a function`. The plugin entry `dist/index.js` was never the module being loaded.

`./server` is effectively a **reserved subpath**: OpenCode treats it as the plugin's server entrypoint, so anything published there must be the single default plugin function.

## What Didn't Work / Wrong Hypotheses

- **"The default export shape is wrong."** The bare `async (input) => ({ tool })` V1 function is accepted by the loader — proven by probing the exact shipped 1.17.12 binary.
- **"index.js exports too much / interop wraps the namespace."** `dist/index.js`'s namespace is exactly `[["default","function"]]`; not the problem, because index.js was never loaded.
- **"Stale or corrupt cache."** Cached-install SHA-256 == npm tarball SHA-256 for package.json, index.js, and server.js.

The contradiction (clean index.js, yet a load failure) is what pointed at *resolution order*: the loader must be importing a different file than `main`.

## Diagnostic Chain

1. Loader error surfaced: `Plugin export is not a function`.
2. npm-tarball probe showed `dist/index.js` was clean: one default export function.
3. That contradicted the failure — so the bad entry wasn't `main`/index.js.
4. Loader-order insight: OpenCode resolves `exports["./server"]` before `main`.
5. Cached-package namespace probe showed `dist/server.js` had the 11-export lifecycle surface (functions + numeric constants).
6. Reproduced in isolation against the shipped loader semantics: `./server` was the wrong subpath; remapping fixed it.

## Solution

Reserve `./server` for the plugin entry and relocate the lifecycle API to a non-reserved subpath (`./managed-server`):

```jsonc
// package.json exports — BEFORE
"./server": {
  "types": "./dist/server.d.ts",
  "import": "./dist/server.js"
}

// AFTER
"./server": {
  "types": "./dist/index.d.ts",
  "import": "./dist/index.js"
},
"./managed-server": {
  "types": "./dist/server.d.ts",
  "import": "./dist/server.js"
}
```

Do **not** "fix" this by stripping the numeric constants from `server.js` — that would leave a namespace of functions, and the loader would then try to execute each lifecycle function as a plugin factory. The subpath, not the exports, is the bug.

## Regression Guard

`src/plugin-entry-guard.test.ts` emulates the loader's resolution order against the real build output, with a negative control:

```ts
// positive: what the loader actually imports must be a single default function
const resolved: string = pkg.exports?.["./server"]?.import ?? pkg.main;
const mod = await import(join(projectRoot, resolved));
const entries = Object.entries(mod);
expect(entries.length).toBe(1);
expect(entries[0]?.[0]).toBe("default");
expect(typeof mod.default).toBe("function");

// negative control: dist/server.js must FAIL that same V1 shape check,
// proving the guard discriminates (re-pointing ./server back turns it red)
const passesV1Shape =
  entries.length === 1 && entries[0]?.[0] === "default" && typeof mod.default === "function";
expect(passesV1Shape).toBe(false);
expect(entries.some(([, v]) => typeof v !== "function")).toBe(true);
```

One-liner to verify a built package:

```sh
bun -e 'const pkg = await Bun.file("package.json").json(); const resolved = pkg.exports?.["./server"]?.import ?? pkg.main; const mod = await import(new URL(resolved, import.meta.url).pathname); console.log(Object.keys(mod), typeof mod.default);'
```

## Why This Works

The failure was a **namespace-collision on a reserved contract**: the operation was internally consistent but published a library surface on the one subpath OpenCode reserves for the plugin factory. Mapping `./server` to the plugin entry makes "load this plugin" import the plugin, and the lifecycle API keeps its own honest subpath. The migration is breaking for direct `/server` importers (they must move to `/managed-server`, and the old import fails *silently* with missing properties, not an error) — so it shipped as a **minor** bump per the package's subpath-stability contract, with a loud migration note.

## Prevention

- **Treat `./server` as reserved** in any OpenCode plugin package — never publish a library surface there. If unsure, map it explicitly to the plugin entry rather than leaving it to `main` fallback.
- **Guard package-entrypoint resolution in CI**, not just source imports — see the companion workflow lesson on why source-ref dogfooding masked this for four releases.

## Related

- [../workflow-issues/source-ref-dogfooding-can-mask-packaged-artifact-failures-2026-07-11.md](../workflow-issues/source-ref-dogfooding-can-mask-packaged-artifact-failures-2026-07-11.md) — why this shipped broken across 0.6.0–0.9.0 unnoticed: the operator dogfood used a source-file plugin ref that bypasses npm entrypoint resolution.
- [../best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md](../best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md) — the plugin registration/packaging companion; plugin registration can be broken by package exports-map choices, not just the tool map.
- [../workflow-issues/npm-trusted-publishing-bootstrap-2026-07-03.md](../workflow-issues/npm-trusted-publishing-bootstrap-2026-07-03.md) — release-path anchor: artifact-level correctness only matters once the package is actually published and resolved by name.
