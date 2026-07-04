---
title: 'feat: managed bus server — lifecycle in the plugin'
type: feat
status: active
date: 2026-07-04
origin: docs/brainstorms/2026-07-04-managed-server-requirements.md
---

# feat: managed bus server — lifecycle in the plugin

## Overview

First caller spawns `harness serve` with a generated password recorded in a 0600 discovery file; every consumer attaches through it. New Node-only `/server` subpath (ensure/attach/status/stop), thin `space-bus` CLI, plugin tools ensure-on-demand, MCP attach-only by default. Externally-managed rosters (`baseUrl`) behave exactly as today.

## Requirements Trace

Origin doc R1–R13 (incl. R2 lock bound, R4b pid identity, R5b config drift, R5c bounded readiness, R6b guard-travel, R7b stop authz, R13 stub testability); flows F1–F4; AE1–AE6. Verified live: `harness serve --port` (default 0 = ephemeral), loopback bind, stdout readiness line, Basic-auth enforcement (401/401/200 probe).

## Scope Boundaries

- No crash supervision/auto-restart; no refcounted teardown; no upstream changes; same-user compromise out of scope; no Windows commitment.
- Post-stable revisit tracked (session note): lazy-vs-eager, password-vs-socket, daemon-vs-refcount.

## Context & Research

### Relevant Code and Patterns

- `src/config.ts` — manifestSchema (baseUrl required today), `loadContext` per call, `getCredentials`; the managed/external split lands here; core never learns about modes.
- `src/contract.ts` — rosterSchema/busContextSchema mirror the schema change (baseUrl optional, xor managed).
- Adapters already load context per call after arg validation (pinned) — the ensure hook drops into that seam.
- `build.ts` shebang pattern for `dist/mcp.js`; `bin` map; browser-safety test's config-isolation assertion (extend for server.ts).
- copilot-delegate mechanics to copy: temp-file+rename+chmod 0600 writes (`rpc-server.ts:158-177`), stale cleanup (`:183-203`), `kill(pid,0)` liveness (`orphan-reaper.ts:48-55`), `ps -p PID -o comm=,lstart=` identity (`:122-178`), singleton guard shape (`plugin-singleton.ts:127-167`). Adapt: discovery-file shape (roster identity, password, spawnConfig, log path), per-roster lock (not per-process).

### Institutional Learnings

- `docs/solutions/best-practices/browser-safe-library-boundary-cut-2026-07-04.md` — Node-lane isolation is CI-enforced; server.ts joins config's lane.
- `docs/solutions/best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md` — no ambient cwd; spawn cwd comes from the roster file's directory.

## Key Technical Decisions

- **Module layout**: new `src/discovery.ts` (Node-only: discovery-file read/write/validate, state-dir resolution keyed by roster-path hash, lock primitives, pid identity) imported by BOTH `src/config.ts` (managed loadContext resolves endpoint+credentials from discovery) and new `src/server.ts` (lifecycle: ensure/spawn/status/stop). Direction: `server → discovery ← config`; no cycles; core/contract untouched by Node concerns.
- **Schema split**: the roster FILE schema gets `server` = `{ baseUrl }` XOR `{ managed: { command?, cwd?, port? } }` (zod union with a refine for exclusivity); existing rosters parse unchanged. `BusContext`/`busContextSchema` in contract is UNCHANGED — baseUrl stays required there, because every context carries a concrete resolved endpoint (roster-sourced or discovery-sourced). Core is untouched: `validateContext` runs its loopback guard on every context unconditionally — discovery-sourced contexts get no already-authorized bypass (a tampered discovery file fails core's guard even if config's check is somehow skipped; defense in depth, R6b).
- **Managed loadContext**: for managed rosters, `loadContext` attaches only (reads discovery, validates liveness + loopback guard on the discovered endpoint, returns BusContext with discovery-sourced baseUrl/credentials). It never spawns — spawning is `ensureServer()`'s job, called by adapters before loadContext when the roster is managed. Keeps config read-only and the spawn side effect explicit at the adapter seam.
- **Lock**: `O_EXCL` lockfile beside the discovery file containing `{pid, startTime, since}`. Arbitration rule: a lock is stale ONLY when its owner is dead (identity-checked) — age never preempts a live owner, so double-spawn by steal is impossible. The spawn-timeout budget bounds the WAITERS: losers poll for the discovery file until budget, then fail with an actionable error naming the lock holder. A dead owner's lock is removed and ensure retries — that is R2's bounded recovery.
- **Readiness**: spawn with `--port 0` (native ephemeral — no pre-pick, no TOCTOU bind race), parse the resolved port from the verified stdout readiness line (`opencode server listening on http://127.0.0.1:<port>`), then poll authed `GET /session?limit=1` until 200 — the probe proves auth enforcement AND readiness in one step. Failure classification: connect-refused/timeout during the budget → keep polling; 401/403 with our generated password → fail immediately (auth regression, never retry); budget exhausted → kill child (identity-verified), release lock, error with redacted log tail. Budget default 15s.
- **Spawn**: `node:child_process.spawn` detached, stdio to an opened log file (fd), `unref()`; env = caller env + generated password (32-byte base64url via crypto). Password never argv, never logged by us; surfaced log tails get best-effort literal redaction of the live secret (encoded/split variants are why the password must never be printed at all — redaction is a second net, not the guarantee). Unit 2 STARTS with a spike test proving a detached child outlives its Bun parent (node:child_process under Bun); if semantics are unreliable, fall back to `Bun.spawn` with equivalent detach — the spike gates the approach before the rest of the unit builds on it.
- **Orphan policy (explicit)**: a spawn whose downstream fails (loadContext error after successful ensure) STAYS running — that is the daemon posture, not an accident: the server is valid shared infrastructure and the next caller attaches. Only readiness failure kills a child.
- **Stop**: read discovery → verify pid identity → SIGTERM → remove discovery file. OS-authz only (R7b). Identity = pid + start-time captured at spawn, compared via `LC_ALL=C ps -p PID -o lstart=` (locale-pinned) plus `comm` match — raw-string comparison is fine once the locale is pinned; a recycled pid never matches both.
- **CLI**: `src/cli.ts` → `dist/cli.js` bin `space-bus` (`serve|status|stop`, `--json`), fourth entrypoint with shebang injection like mcp.js. Thin: parses args, calls server.ts, prints.
- **MCP attach-only**: `mcp.ts` never calls ensure unless `SPACE_BUS_MCP_SPAWN=1`. Plugin tools call ensure for managed rosters on every execute (idempotent attach fast-path).
- **Stub server for tests** (R13): `test/fixtures/stub-server.ts` — Bun script binding the given port, honoring `OPENCODE_SERVER_PASSWORD` (401/200), `/session?limit=1` endpoint, killable; lifecycle tests point `managed.command` at `["bun", "test/fixtures/stub-server.ts"]`. Smoke fixture unchanged (externally-managed).

## Open Questions

### Resolved During Planning

- Discovery location: `$XDG_STATE_HOME|~/.local/state`/`space-bus/<sha256(rosterPath) first 16 hex>/` — `discovery.json`, `spawn.lock`, `server.log`.
- CLI packaging: second bin (`space-bus`) beside `space-bus-mcp`; no consolidation.
- Readiness probe: authed request loop (see decisions); stdout line unused.

### Deferred to Implementation

- Exact zod shape for the XOR (union vs superRefine) — whichever gives the better error message.
- Redaction implementation detail (simple replaceAll of the secret in surfaced tails).

## Implementation Units

- [ ] **Unit 1: Schema split + discovery module**

**Goal:** Roster supports `baseUrl` XOR `managed`; `src/discovery.ts` provides state-dir/discovery-file/lock/pid-identity primitives with tests against temp dirs.

**Requirements:** R5 (schema), R4b, R6 (file hygiene), R2 (lock primitive)

**Files:** Create `src/discovery.ts`, `src/discovery.test.ts`; modify `src/config.ts` (schema), `src/contract.ts` (mirror), `src/config.test.ts`.

**Test scenarios:** schema — existing rosters parse; managed-only parses; both/neither rejected with actionable message. discovery — atomic write is 0600/0700, temp-swap; stale detection (dead pid, recycled pid via identity mismatch); lock acquire/contend/stale-recovery (dead owner, over-budget).

- [ ] **Unit 2: server.ts lifecycle (ensure/spawn/status/stop)**

**Goal:** Full lifecycle against the stub server: first-caller spawn with generated password, losers attach, staleness heals, bounded readiness, identity-verified stop, redacted errors.

**Requirements:** R1–R4, R5b, R5c, R6, R6b, R7, R7b, R12, R13

**Dependencies:** Unit 1

**Files:** Create `src/server.ts`, `src/server.test.ts`, `test/fixtures/stub-server.ts` (test-only: `files` whitelist is dist/README/LICENSE, so nothing under test/ ships in the npm pack).

**Test scenarios:** detach spike FIRST (child outlives Bun parent); AE1 (concurrent ensures → one spawn, both attach — real concurrency with the stub), AE2 (dead-pid discovery heals), AE3 (401 without password, 200 with), AE6 (server outlives spawner; stop kills), readiness timeout → killed child + released lock + redacted error (sentinel), auth failure with our password → immediate fail (no retry), live-but-slow lock owner → waiter times out with the holder named (no steal, no double spawn), config-drift surfaced by status (R5b), loopback guard on tampered discovery file (R6b — at config AND core layers), orphan policy (ensure succeeds, downstream fails, server persists).

- [ ] **Unit 3: Consumer wiring (config managed-attach, plugin ensure, MCP attach-only)**

**Goal:** `loadContext` resolves managed rosters from discovery; plugin tools ensure-then-load per call; MCP attach-only with env opt-in; externally-managed path byte-identical to today.

**Requirements:** R5, R10, R11

**Dependencies:** Unit 2

**Files:** Modify `src/config.ts` (loadContext managed branch), `src/tools/bus_*.ts`, `src/index.ts`, `src/mcp.ts`; adapt `src/config.test.ts`, `src/index.test.ts` additions (fail-fast pin stays unmodified).

**Test scenarios:** managed roster + live stub → tools work end-to-end with zero manual setup (AE1 wiring level); baseUrl roster → no spawn ever attempted (spy), env credentials, today's behavior (AE4); MCP without opt-in env → attach-only error when bus down; with opt-in → ensures.

- [ ] **Unit 4: CLI bin**

**Goal:** `space-bus serve|status|stop` (+`--json`) wrapping server.ts; packaged as second bin with shebang; version-injection-style build test.

**Requirements:** R8, R9

**Dependencies:** Unit 2

**Files:** Create `src/cli.ts`, `src/cli.test.ts`; modify `package.json` (bin, exports `/server`), `build.ts` (entrypoints + cli shebang), extend `src/version-injection.test.ts` or fold into cli.test.ts.

**Test scenarios:** status --json shape `{running, port, pid}` truth from discovery (AE5); serve foreground option; stop on nothing → clean message; bin has shebang post-build.

- [ ] **Unit 5: Safety guards + docs + changeset**

**Goal:** Browser-safety test asserts server.ts/discovery.ts unreachable from browser graphs; README managed-server section (roster block, CLI, MCP opt-in, security posture); AGENTS.md invariants; minor changeset.

**Requirements:** R6 (posture docs), R13 (CI story), origin Success Criteria

**Dependencies:** Units 1–4

**Files:** Modify `src/browser-safety.test.ts`, `README.md`, `AGENTS.md`; create `.changeset/managed-server.md`.

**Verification:** full gates — typecheck, 100+ tests green, lint, build (7 entrypoints), smoke PASS (externally-managed fixture unchanged), npm pack dry-run coherent.

## System-Wide Impact

- Externally-managed path (every current consumer) — zero behavior change, pinned by existing suite + smoke.
- New spawn side effect exists only for rosters that opt into `managed` — no current roster does until the operator flips the workspace.
- Browser-safety guard extends to two more Node-only modules; core/contract/format graphs unchanged.
- Error precedence unchanged (arg validation → ensure/context → core).

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Detached-spawn/unref quirks under Bun | Unit 2's opening spike gates the approach; Bun.spawn fallback ready |
| Stub-vs-real-harness fidelity (auth timing, signals) | Live validation step: after release, flip the operator workspace roster to `managed` and run the full delegation loop against real harness before calling it stable |
| Discovery/lock edge cases on shared filesystems | Out of scope (local state dir only, documented) |
| Operator workspace migration | Separate step after release: flip workspace roster to `managed`, delete manual-start habit |

## Sources & References

- Origin: [docs/brainstorms/2026-07-04-managed-server-requirements.md](../brainstorms/2026-07-04-managed-server-requirements.md)
- copilot-delegate runtime study + seam map (this session); live harness probe (401/401/200, readiness line, port default 0)
