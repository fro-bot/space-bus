---
module: space-bus
category: best-practices
date: 2026-07-11
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - generating a launchd plist (or systemd unit) for a managed service
  - the managed command is resolved via PATH-injected toolchain shims (mise/asdf/nvm)
  - installer verification and the runtime daemon must resolve the same env-derived state paths
tags:
  - launchd
  - environment-variables
  - path
  - xdg-state-home
  - plist
  - service-install
  - sparse-env
---

# Pin ambient environment into a generated launchd/systemd unit

## Context

A macOS launchd agent starts with a **sparse environment**: `PATH` is only `/usr/bin:/bin:/usr/sbin:/sbin`, and none of the user's shell env (`XDG_*`, toolchain shim dirs, etc.) is inherited. A unit generated from an interactive install context therefore runs in a *different reality* than the installer that created it. Two concrete failures hit `space-bus service install` (0.11.0):

1. **Binary not found.** The managed command is `["harness", "serve"]`, and `harness` is a mise-installed shim resolvable only via the user's `PATH`. Under launchd's sparse `PATH`, the daemon can't find it — the service loads but the process never starts.
2. **State-root split.** `space-bus` derives its state dir from `XDG_STATE_HOME` (falling back to `~/.local/state`). If the *installer* ran with `XDG_STATE_HOME` set but the launchd process doesn't inherit it, the daemon writes discovery/locks under `~/.local/state` while the installer's verification and log paths used the XDG root. They diverge silently: install verification can falsely time out (it polls the wrong state dir), and later clients resolve a different lifecycle state → competing supervisors.

## Guidance

When you generate an OS service unit, **pin the environment the runtime actually needs** into the unit's `EnvironmentVariables` — don't assume the login shell's env survives:

- `PATH` — so a toolchain-resolved binary (mise/asdf/nvm shim) is findable.
- Any env var the process derives paths or identity from (`XDG_STATE_HOME` here) — so the installer and the spawned daemon resolve the **same** paths.

**Validate the pinned values are absolute** before writing them. A relative path in the unit's env is worse than useless — launchd resolves it against an unpredictable working directory.

## Why This Matters

The whole point of a persistence unit is that it runs unattended after a reboot, in an environment nobody is watching. If it can't find its binary, or it splits its runtime state across two roots, the failure is invisible until something downstream breaks (a dead board; two supervisors fighting over a port). Pinning the env closes the gap between "works when I run it in my shell" and "works when launchd runs it at login."

This is the **sibling of a test-time lesson**: [`test-isolation-xdg-state-home`](./test-isolation-xdg-state-home-2026-07-05.md) isolates `XDG_STATE_HOME` so tests don't write into the real state dir. Same env var, opposite direction — there you *override* it to redirect writes away; here you *pin* it so a spawned process writes where the installer expects. Both are about the base path being env-derived and therefore fragile across a process boundary.

## When to Apply

- Generating any launchd plist or systemd unit that wraps a command resolved through a version-manager shim or a non-system `PATH`.
- The wrapped process derives file paths, state dirs, or identity from environment variables.
- Any time an installer verifies a spawned service's health — the verifier and the service must resolve the same paths, which means the same env.

## Examples

Rendering the plist env — pin `PATH` and `XDG_STATE_HOME` alongside the roster config (`src/launchd.ts`):

```ts
const envEntries: string[] = [
  `    <key>SPACE_BUS_CONFIG</key>\n    <string>${xmlEscape(rosterPath)}</string>`,
];
if (opts.path !== undefined) {
  envEntries.push(`    <key>PATH</key>\n    <string>${xmlEscape(opts.path)}</string>`);
}
if (opts.xdgStateHome !== undefined) {
  envEntries.push(
    `    <key>XDG_STATE_HOME</key>\n    <string>${xmlEscape(opts.xdgStateHome)}</string>`,
  );
}
// ... <key>EnvironmentVariables</key><dict>${envEntries.join("\n")}</dict>
```

Absolute-path validation gate before pinning (`src/service.ts`) — a relative `XDG_STATE_HOME` is rejected, not silently written:

```ts
function resolveXdgStateHome(): ResolveResult<string | undefined> {
  const env = process.env["XDG_STATE_HOME"];
  if (env === undefined) return { ok: true, value: undefined };
  if (!isAbsolute(env)) {
    return {
      ok: false,
      error: `XDG_STATE_HOME must be an absolute path to pin into the launchd environment, got: ${env}`,
    };
  }
  return { ok: true, value: env };
}
```

Proven live: after this fix, `space-bus service install` for the real operator roster resolved `harness` under launchd's sparse env, and the launchd-spawned daemon + the installer both resolved the same `stateDirFor` — the plist's `EnvironmentVariables` carried the full mise `PATH` and `XDG_STATE_HOME=/Users/…/.local/state`.

Credentials are **never** pinned — only `SPACE_BUS_CONFIG`, `PATH`, and `XDG_STATE_HOME`. The discovery password stays in the 0600 discovery file, never in the plist.

## Related

- [./test-isolation-xdg-state-home-2026-07-05.md](./test-isolation-xdg-state-home-2026-07-05.md) — the same env var (`XDG_STATE_HOME`) in the opposite direction: isolate it in tests vs pin it in production units.
- [./managed-server-lifecycle-first-caller-spawns-2026-07-05.md](./managed-server-lifecycle-first-caller-spawns-2026-07-05.md) — the managed-daemon lifecycle this service unit supervises.
- [../security-issues/launchd-log-symlink-toctou-2026-07-11.md](../security-issues/launchd-log-symlink-toctou-2026-07-11.md) — a sibling hardening finding from the same `space-bus service` feature.
