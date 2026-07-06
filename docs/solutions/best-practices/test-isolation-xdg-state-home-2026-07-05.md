---
title: Isolate env/home-derived filesystem paths in tests, not just the hashed input
date: 2026-07-05
category: best-practices
module: space-bus
problem_type: best_practice
component: testing_framework
severity: medium
applies_when:
  - code under test derives filesystem write paths from environment variables (XDG_*, HOME, APPDATA) or homedir()
  - tests randomize the input that gets hashed into a path but leave the base env var unset
  - leaked state would land in the developer's real home directory
symptoms:
  - all tests pass but stray state directories accumulate in the developer's real ~/.local/state
  - randomized input paths hash into unique real state-dir paths that are never cleaned up
root_cause: test_isolation
tags:
  - test-isolation
  - xdg-state-home
  - preload
  - environment-setup
  - filesystem
---

# Isolate env/home-derived filesystem paths in tests, not just the hashed input

## Context

space-bus's managed-server tests write discovery, lock, and provisional files. Their location comes from `stateDirFor` in `src/discovery.ts`:

```ts
const base = process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
// then: join(base, "space-bus", sha256(rosterPath).slice(0, 16))
```

The tests randomized the **roster path** (via `mkdtemp`) so each test hashed a unique value — which *looks* like isolation. But they never set `XDG_STATE_HOME`. So every run that wrote state hashed its unique temp roster into a brand-new directory under the developer's **real** `~/.local/state/space-bus/` and never cleaned it up. **791 stray directories** accumulated across one session's test runs.

Nothing failed. CI stayed green. It was found only when a human ran `ls ~/.local/state/space-bus | wc -l` during unrelated live validation.

## Guidance

When code under test derives a filesystem **write** path from the environment (`XDG_*`, `HOME`, `APPDATA`) or `homedir()`, isolate the **output base** at the test-harness level — override the env var globally, before any test runs, to a temp dir, and clean it up.

Randomizing the input that gets hashed into the path is **false isolation**: the base directory is what the code actually writes to, and the base comes from the env/home, not the input.

The fix — a Bun test preload:

```ts
// test/setup.ts
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalXdgStateHome = process.env["XDG_STATE_HOME"];
const tempRoot = mkdtempSync(join(tmpdir(), "space-bus-xdg-state-"));
process.env["XDG_STATE_HOME"] = tempRoot; // set BEFORE any test module loads

function cleanup(): void {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort
  }
  if (originalXdgStateHome === undefined) delete process.env["XDG_STATE_HOME"];
  else process.env["XDG_STATE_HOME"] = originalXdgStateHome;
}

afterAll(cleanup);
process.on("exit", cleanup); // fallback for a killed/crashed run
```

Wired globally so it applies to every test file:

```toml
# bunfig.toml
[test]
preload = ["./test/setup.ts"]
```

Proof it holds: `ls ~/.local/state/space-bus | wc -l` stays `0` before and after a full `bun test` run.

## Why This Matters

Leaking is not failing. A test that writes to the wrong directory still asserts correctly and still passes — so green CI and a green local run are both blind to it. The damage accumulates silently in the developer's home and only surfaces via manual inspection or dogfooding, if at all. Per-test input randomization gives a false sense of isolation precisely because the tests *pass*; the leak is in the un-randomized base.

## When to Apply

Any test suite exercising code that reads `XDG_*` / `HOME` / `APPDATA`, calls `homedir()`, or otherwise derives real filesystem write paths (state, cache, config, lock, temp) from the environment. If the code has a `stateDirFor`-like resolver with an `env ?? homedir()` base, its tests need a global env override.

## Examples

False vs real isolation, at a glance:

- **False:** randomize `rosterPath` (the hashed input) → each run still writes under the real `~/.local/state`.
- **Real:** override `XDG_STATE_HOME` (the output base) to a temp dir in a global preload → nothing touches the real home.

The general rule generalizes past `XDG_STATE_HOME`: whatever env var or home lookup forms the **base** of a write path is what a test must override — overriding or randomizing anything downstream of it is not enough.

## Related

- [managed-server-lifecycle-first-caller-spawns-2026-07-05.md](./managed-server-lifecycle-first-caller-spawns-2026-07-05.md) — the runtime lifecycle whose tests leaked; `stateDirFor` keys each managed server's discovery state.
- [browser-safe-discovery-contract-parity-2026-07-05.md](./browser-safe-discovery-contract-parity-2026-07-05.md) — shares the same `XDG_STATE_HOME | ~/.local/state` → `space-bus/<hash>` path convention on the browser-safe reader side.
