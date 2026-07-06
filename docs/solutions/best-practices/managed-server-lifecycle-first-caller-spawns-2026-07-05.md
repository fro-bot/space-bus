---
title: Managed local-server lifecycle — first-caller-spawns, everyone-attaches
date: 2026-07-05
category: docs/solutions/best-practices/
module: space-bus
problem_type: best_practice
component: tooling
severity: high
applies_when:
  - a library, plugin, or CLI must spawn and supervise one shared long-lived local server it does not own the lifecycle of
  - multiple independent consumers may each race to be the first to need the server
  - the server uses an ephemeral port and callers must attach via a discovery handshake without double-spawning
tags:
  - managed-server
  - local-daemon
  - spawn-lock
  - pid-identity
  - readiness
  - stop-escalation
  - orphan-reaping
  - credential-hygiene
---

# Managed local-server lifecycle — first-caller-spawns, everyone-attaches

## Context

space-bus manages a local `harness serve` / `opencode serve` process from plugin code. Multiple independent consumers may each need it — OpenCode session tools, the MCP facade, the `space-bus` CLI, an external webview — and none of them owns "start the server." The naive shapes all break:

- **Eager spawn at plugin load** — racey (every session that loads the plugin spawns), wrong lifetime, idle servers.
- **Every caller spawns** — double-starts, port conflicts.
- **Kill by pid** — can SIGTERM an unrelated process after the pid is recycled.

The working shape: **lazy first-caller ensure → 0600 discovery-file handshake → persistent daemon**. The first caller wins a lock and spawns; everyone else attaches to the discovery file; the daemon outlives the caller that started it; staleness heals on the next `ensureServer`. No auto-restart — the next `ensure` is the recovery path.

This is the **writer/lifecycle** side of the discovery file. The **reader** side (a browser-safe attacher) is its companion — see the Related section.

## Guidance

A checklist for a shared local-server supervisor. Each item was a real hole caught across three review rounds (ce:review + two Oracle passes), not a hypothetical.

1. **Spawn race → `O_EXCL` lock.** Concurrent first-callers resolve to exactly one spawn; losers wait for the winner's discovery file. **Age never preempts a live owner** (no steal → no double-spawn). A **dead** owner's lock is reclaimed immediately (identity-checked); a **corrupt/empty** lock is reclaimed only after a grace window (protects a live writer mid-write). Losers **fast-fail** when the lock is released without a discovery file appearing — the winner's spawn failed, so don't wait out the full budget.
2. **Verify pid identity before any signal.** Capture start-time + `comm` at spawn (`ps -o lstart=,comm=`, locale-pinned `LC_ALL=C`); verify before every kill. A bare pid is reusable garbage — signaling on pid alone can kill an innocent recycled process. Applies to staleness reaping, `stop`, and orphan reaping.
3. **Two-phase readiness.** Parse the resolved ephemeral port from the server's stdout line, then poll an **authenticated** endpoint. Classify: `401/403` → fail immediately (auth regression, never retry), connection-refused/timeout → retry to budget, child-process-died → fast-fail. Per-request `AbortSignal` timeout on the probe; split the overall budget so the log-read phase can't starve the HTTP-probe phase.
4. **Escalated, confirmed stop.** SIGTERM → bounded poll for death → SIGKILL → confirm dead → **then** remove the discovery file. Never report `stopped: true` on a still-alive process; leave discovery intact if it somehow survives SIGKILL.
5. **Keep credentials out of argv and logs.** Generate a per-spawn password, pass it in the child **env** (never argv, never logged). Redact **both** the raw password **and** its base64 Basic-auth token from any surfaced log tail — the encoded form leaks just as badly.
6. **Write provisional state before the readiness wait.** Record `{pid, identity, password}` immediately after spawn, before waiting for readiness, so a parent death in that window leaves a reapable trace. The next `ensure` identity-verifies and reaps the orphan before respawning.
7. **Prove the detached spawn.** `node:child_process` `spawn(..., { detached: true }).unref()` is not a vibe — verify the child outlives the parent with a spike test before building the rest on it (Bun's process semantics in particular warrant the check).

## Why This Matters

Each safeguard maps to a concrete failure the naive version hits:

| Safeguard | Failure it prevents |
|---|---|
| `O_EXCL` lock, no steal | double-spawn / port conflict |
| dead-owner-only reclaim + corrupt-lock grace | wedged lock (a crashed mid-write spawner freezing every future ensure) |
| pid-identity verification | SIGTERM to a recycled, unrelated pid |
| authenticated two-phase readiness | false "ready" on a stale/wrong password |
| SIGTERM→SIGKILL + confirm-dead | false "stopped" on a live server; deleted discovery + orphaned daemon |
| env password + dual redaction | credential (raw or base64) leaked in a surfaced log tail |
| provisional record + reap | orphaned, untracked daemon after a parent death |
| detached-spawn spike test | parent exit silently killing the "persistent" child |

The theme: every failure is silent-until-later. A double-spawn, a wedged lock, a recycled-pid kill, a false-ready, a false-stopped — none of them throw at the moment they happen. The safeguards convert latent corruption into an immediate, correct outcome.

## When to Apply

Any library, plugin, or CLI that spawns and supervises a **shared long-lived local process** whose lifecycle it doesn't own — especially with multiple independent consumers and ephemeral ports, where staleness must self-heal on the next attach/ensure rather than via a supervisor loop.

## Examples

**Lock reclaim guard** — live owner is untouchable; dead owner reclaimed now; corrupt lock only after grace:

```ts
const existing = readLockFile(lockPath);
if (existing) {
  if (verifyIdentity(existing.pid, existing.identity)) return null; // live owner — never steal
} else if (!olderThan(lockPath, CORRUPT_LOCK_GRACE_MS)) {
  return null; // empty/corrupt but fresh — a writer may be mid-write
}
// dead owner or aged-out corrupt lock — reclaim
```

**Identity capture / verify** — a recycled pid never matches both start-time and comm:

```ts
export function captureIdentity(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], {
      env: { ...process.env, LC_ALL: "C" }, // locale-pinned so the string compares stably
      encoding: "utf8",
    });
    return out.split("\n")[1]?.trim() || null;
  } catch {
    return null;
  }
}

export function verifyIdentity(pid: number, storedIdentity: string): boolean {
  return isAlive(pid) && captureIdentity(pid) === storedIdentity;
}
```

**Readiness classification** — auth failure is terminal, not retryable:

```ts
const res = await fetch(`${baseUrl}/session?limit=1`, {
  headers: { authorization: `Basic ${basicAuthToken(password)}` },
  signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
});
if (res.status === 200) return "ready";
if (res.status === 401 || res.status === 403) return "auth-failure"; // stop now, don't burn the budget
return "retry";
```

**Stop escalation** — discovery removed only after confirmed death:

```ts
process.kill(pid, "SIGTERM");
if (await waitForDeath(pid, STOP_GRACE_MS)) { removeDiscovery(rosterPath); return { stopped: true }; }
process.kill(pid, "SIGKILL");
if (await waitForDeath(pid, STOP_GRACE_MS)) { removeDiscovery(rosterPath); return { stopped: true }; }
return { stopped: false }; // survived SIGKILL — leave discovery intact, don't lie
```

**Redaction covering both forms** of the secret:

```ts
export function redactSensitive(tail: string, password: string): string {
  return tail
    .replaceAll(basicAuthToken(password), "[REDACTED]") // base64 "opencode:<pw>"
    .replaceAll(password, "[REDACTED]");                // raw
}
```

Naive → hardened, at a glance:

- pid-only kill → identity-gated kill (`pid + lstart + comm`)
- retry `/session` forever on a bad password → `401/403` fails immediately
- remove discovery on SIGTERM *send* → remove only after confirmed death
- log the raw readiness tail → redact raw secret **and** its Basic token

## Related

- [browser-safe-discovery-contract-parity-2026-07-05.md](./browser-safe-discovery-contract-parity-2026-07-05.md) — the **reader-side companion**: a browser-safe attacher reads the same discovery file this lifecycle writes, reimplementing the path convention across the browser/Node boundary and pinning it with a parity test.
- [test-isolation-xdg-state-home-2026-07-05.md](./test-isolation-xdg-state-home-2026-07-05.md) — how this feature's tests leaked state into the real home, and the `XDG_STATE_HOME` preload that isolates them.
- [opencode-plugin-tool-registration-directory-scoping-2026-07-03.md](./opencode-plugin-tool-registration-directory-scoping-2026-07-03.md) — `ctx.directory` per-call scoping; the roster path that keys each managed server's discovery state.
