---
title: "feat: space-bus service — reboot-persistent managed daemon (launchd v1)"
type: feat
status: active
date: 2026-07-11
origin: docs/brainstorms/2026-07-11-service-persistence-requirements.md
---

# feat: `space-bus service` — reboot-persistent managed daemon (launchd v1)

## Overview

Add `space-bus service install|uninstall|status|stop|start`: generates and manages a per-user launchd agent that wraps the existing `serve --foreground` supervisor, so a roster's managed daemon survives reboots and crashes. macOS/launchd only in v1, behind a platform seam; systemd is an additive fast-follow.

## Problem Frame

The managed daemon has no persistence story: the operator workspace daemon died silently across a multi-day gap (host reboot), killing Claude Desktop's board access until a live dogfood happened to notice. The issue #49 Layer B supervisor was built to be consumed by a process manager (exit 0 deliberate stop / exit 1 death-for-restart) — this plan ships the supported way to register one. (see origin: docs/brainstorms/2026-07-11-service-persistence-requirements.md)

## Requirements Trace

R1–R16 and AE1–AE8 in the origin doc are the authoritative contract. Highlights: five verbs with `--json` parity (R1–R5); wraps `serve --foreground` consuming the exit-code contract (R6); one service per roster keyed like the state dir (R7); RunAtLoad + restart-on-abnormal-exit with throttle (R8); idempotent install (R9); 0600 logs in the state dir (R10); explicit-action-only (R11); no credentials in the plist (R12); full uninstall reversal (R13); fail loudly on launchctl errors (R14); atomic owner-only plist write with tamper refusal (R15); platform seam with fail-fast on unsupported platforms (R16).

## Scope Boundaries

Per origin: no systemd in v1 (seam only), no auto-install, no Windows, no alerting layer, no changes to existing `serve`/`stop`/`status` semantics.

### Deferred to Separate Tasks

- systemd generator behind the same seam: future PR, after it can be dogfooded on Linux.
- Log rotation for service logs: launchd appends; state-dir logs are small. Revisit if they grow.

## Context & Research

### Relevant Code and Patterns

- `src/cli.ts` — subcommand dispatch in `main` (223–262), `parseArgs`/`consumeArg` arg handling, `resolveRoster`, `printJson` dual plain/JSON convention, `runServe`/`runStatus`/`runStop` verb shape. `RunServeDeps` (103–120) is the injectable-seams pattern for testability.
- `src/discovery.ts` — `stateDirFor` (roster-identity keying: sha256 of realpath'd roster path, first 12 hex), `logFilePath`, atomic write pattern in `writeDiscovery` (temp + rename, 0600), `isErrnoCode`/`isEnoent` error helpers.
- `src/server.ts` — `ensureServer`/`serverStatus`/`stopServer`; `serverStatus` is the "running" probe `service status` reuses.
- `src/server.test.ts` — real-subprocess test conventions, `spawnedPids` cleanup, `waitUntilDead`.
- `src/browser-safety.test.ts` — the new module must join the Node-only lane (unreachable from browser-safe bundles).

### Institutional Learnings

- `docs/solutions/best-practices/managed-server-lifecycle-first-caller-spawns-2026-07-05.md` — lifecycle safeguards the service wraps.
- `docs/solutions/best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md` — seam-injected tests alone can't prove launchctl interactions; keep the seam thin and verify live at AE time.
- `docs/solutions/workflow-issues/source-ref-dogfooding-can-mask-packaged-artifact-failures-2026-07-11.md` — verify the released artifact path (the plist pins real binaries; dogfood the installed form).

### External References

- `launchd.plist(5)`, `launchctl(1)`: `KeepAlive {SuccessfulExit:false}` restarts only on non-zero exit and implies RunAtLoad; default `ThrottleInterval` 10s is the anti-hot-loop; modern verbs are `bootstrap gui/$UID <plist>`, `bootout gui/$UID/<label>`, `kickstart -k gui/$UID/<label>`, `print gui/$UID/<label>` (exit code = existence; parse only `pid =`); `load`/`unload` deprecated; gui-domain agents start at login; StandardOut/ErrorPath parent dir must exist.

## Key Technical Decisions

- **Wrap `serve --foreground`; no new supervision logic** — launchd consumes the existing 0/1 exit contract via `KeepAlive {SuccessfulExit:false}` (origin Key Decision).
- **Pin absolute paths at install time**: ProgramArguments = `[<absolute bun/node runtime>, <absolute CLI entry>, "serve", "--foreground"]`, resolved from the currently executing process (`process.execPath` + the CLI script path). No bunx/npx at service start (network/cold-cache at login). Version bumps = re-run `install` (R9 idempotent refresh). If the resolved entry lives in an ephemeral cache (path contains bunx/npx cache segments), `install` warns and recommends a durable install. (confirmed at synthesis)
- **`service stop` = `bootout` (plist stays); `service start` = `bootstrap` + `kickstart`** — bootout deregisters, so start must re-register, not just kick. Accepted consequence: logout/login after `stop` re-registers via RunAtLoad (no `disable` latch in v1). (confirmed at synthesis)
- **Label/filename**: `bot.fro.space-bus.<rosterKey>` where rosterKey is the existing `stateDirFor` hash prefix (first 16 hex of sha256(roster path)) — per-roster identity (R7), reverse-DNS, filename = `<label>.plist`.
- **Logs in the roster state dir** (`stateDirFor(...)/service.log`, `.err.log`), created 0600 by `install` before load (launchd needs the parent to exist; pre-creating pins permissions) (R10).
- **Status = three independent probes**: plist existence (fs), loaded (`launchctl print` exit code), running (existing `serverStatus`, plus `pid =` parse as the launchd view). No `launchctl list` scraping.
- **Platform seam = module boundary, not abstraction layer**: `service.ts` owns verb orchestration and delegates platform specifics to a `launchd.ts`-shaped provider; on `process.platform !== "darwin"` every verb fails fast (R16). No generic interface gymnastics for a single implementation — the seam is the file split.
- **Env**: plist carries `EnvironmentVariables { SPACE_BUS_CONFIG: <resolved roster path> }` — the one env var, no credentials (R12).

## Open Questions

### Resolved During Planning

- Plist invocation model: absolute pinned paths, refresh on reinstall (was deferred in origin).
- Throttle: default 10s `ThrottleInterval`, explicit in the plist for documentation value (was deferred).
- Status query: `print` exit code + `pid =` line only (was deferred).

### Deferred to Implementation

- Exact `launchctl print` output parsing tolerance (line format drift across macOS versions): implement permissive regex, treat parse failure as "loaded, pid unknown" rather than error.
- Whether `bootstrap` of an already-loaded job needs a preceding `bootout` in the R9 refresh path on the target macOS version — verify live during AE6.

## Implementation Units

- [ ] **Unit 1: launchd provider — plist generation + launchctl runner (`src/launchd.ts`)**

**Goal:** Pure-ish Node-only module: generate the plist XML for a roster, derive label/paths, and wrap `launchctl` invocations behind an injectable exec seam.

**Requirements:** R6, R7, R8, R10, R12, R15

**Dependencies:** none

**Files:**
- Create: `src/launchd.ts`
- Test: `src/launchd.test.ts`

**Approach:**
- `serviceLabel(rosterPath)` / `plistPath(label)` — label from `stateDirFor`'s hash-prefix keying; plist under `~/Library/LaunchAgents/<label>.plist`.
- `renderPlist({runtime, cliEntry, rosterPath, stateDir})` — returns the XML string: Label, ProgramArguments, KeepAlive dict, RunAtLoad, ThrottleInterval 10, EnvironmentVariables, StandardOut/ErrorPath into the state dir. XML-escape all interpolated paths.
- `writePlistAtomic(path, content)` — temp+rename, 0600→0644 owner-only (launchd requires readable; must not be group/world-writable), mirror `writeDiscovery`.
- `verifyPlistSafe(path)` — owner is current uid, mode has no group/world write; used by install to refuse/rewrite tampered plists (R15).
- `launchctl(args, exec)` — exec seam returning `{code, stdout, stderr}`; helpers `bootstrap`/`bootout`/`kickstart`/`printJob` built on it. `printJob` returns `{loaded, pid?}` from exit code + permissive `pid = (\d+)` match.

**Test scenarios:**
- Happy path: rendered plist contains pinned absolute ProgramArguments, KeepAlive SuccessfulExit=false, RunAtLoad, throttle, SPACE_BUS_CONFIG, log paths; label derivation stable per roster and distinct across rosters.
- Edge case: paths with spaces/ampersands XML-escaped; two rosters → distinct labels/plists (AE5 seed).
- Error path: `verifyPlistSafe` rejects group/world-writable and foreign-owner plists; `printJob` on non-zero exit → `{loaded:false}`; unparsable print output → `{loaded:true, pid:undefined}`.
- Security: rendered plist never contains password/credential material even when the roster file carries credentials (R12 negative probe).

**Verification:** unit tests green; rendered plist validates with `plutil -lint` (test shells out when darwin).

- [ ] **Unit 2: service verbs orchestration (`src/service.ts`)**

**Goal:** The five verbs as Node-only functions consuming Unit 1, with the platform gate and discriminated-union results matching repo conventions.

**Requirements:** R1, R2, R3, R4, R9, R11, R13, R14, R16

**Dependencies:** Unit 1

**Files:**
- Create: `src/service.ts`
- Test: `src/service.test.ts`

**Approach:**
- `installService(rosterPath, seams)`: platform gate → resolve runtime+entry (warn on ephemeral-cache path) → ensure state dir + pre-create 0600 logs → bootout existing job if loaded (R9) → write plist atomically → verifyPlistSafe → bootstrap → kickstart → verify via printJob + `serverStatus` (bounded wait) → `{ok:true, ...}` or `{ok:false, error}` with the launchctl stderr surfaced (R14). Never report success on partial install.
- `uninstallService`: bootout (tolerate not-loaded) → remove plist → report what was removed (R13; state dir untouched beyond service artifacts).
- `serviceStatus`: `{installed, loaded, running, pid?, label, plistPath}` — three independent probes (R3).
- `stopService` = bootout-only (plist stays); `startService` = bootstrap (+kickstart) (R4).
- All functions return unions, never throw across the boundary (repo invariant); seams injectable for tests (exec, fs, platform, execPath) following `RunServeDeps`.

**Test scenarios:**
- Happy path (seam-injected): install sequences bootout?→write→verify→bootstrap→kickstart and reports ok; status maps the three probes into distinct fields; stop issues bootout only and leaves plist; start re-bootstraps.
- Edge case: install on already-installed roster boots out first, exactly one plist after (AE6/R9); uninstall when not loaded still removes plist and succeeds; status with plist absent → all-false without probing launchctl errors as failures.
- Error path: bootstrap non-zero → `{ok:false}` with stderr in message, no success report, plist state reported honestly (AE7/R14); non-darwin platform → fail-fast "not supported on this platform (v1 supports macOS/launchd)" for every verb (AE8/R16); tampered plist (verifyPlistSafe fail) → refuse+rewrite path exercised.
- Integration: none at this layer — live launchctl behavior is AE-time (see Verification).

**Verification:** unit tests green; the verb set compiles against the CLI without touching browser-safe modules (browser-safety suite still green).

- [ ] **Unit 3: CLI wiring + docs surface (`src/cli.ts`)**

**Goal:** `space-bus service <verb>` in the CLI with `--config`/`--json` parity, USAGE text, and exit codes.

**Requirements:** R1–R5

**Dependencies:** Unit 2

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts` (extend)

**Approach:** `main` dispatches `service` → sub-verb; reuse `parseArgs`/`resolveRoster`/`printJson`; plain output mirrors existing verbs' concise style; non-zero exit on `{ok:false}`. USAGE block gains the service verbs.

**Test scenarios:**
- Happy path: each verb routes to its `service.ts` function with resolved roster; `--json` emits stable field names (R5).
- Edge case: unknown sub-verb → usage + non-zero; missing verb → usage.
- Error path: `{ok:false}` from service layer → message on stderr + exit 1.

**Verification:** CLI tests green; `space-bus service` verbs appear in `--help`.

- [ ] **Unit 4: guards, docs, changeset**

**Goal:** Node-only lane enforcement, README/AGENTS docs, minor changeset.

**Requirements:** R11, R16 (documentation of posture); release packaging

**Dependencies:** Units 1–3

**Files:**
- Modify: `src/browser-safety.test.ts` (assert `launchd.ts`/`service.ts` unreachable from browser-safe bundles)
- Modify: `README.md` (service section: verbs, launchd behavior, login-not-boot note, logs location, upgrade = reinstall)
- Modify: `AGENTS.md` (structure map: launchd.ts/service.ts in the Node-only lane)
- Create: `.changeset/<name>.md` (minor: new `service` subcommand)

**Test scenarios:** Test expectation: none — docs/guard wiring; the browser-safety assertion is itself the test.

**Verification:** full gates green (`build`, `typecheck`, `test`, `check`); changeset status shows minor.

## System-Wide Impact

- **Interaction graph:** service layer sits strictly above `server.ts` (calls `serverStatus` only) and beside `cli.ts`; no changes to core/contract/format/attach or the tool/MCP surfaces — two-surface parity untouched.
- **Error propagation:** launchctl failures surface as `{ok:false, error}` → CLI exit 1; partial installs report honestly (R14).
- **State lifecycle risks:** stale launchd job vs plist drift handled by R9 bootout-first refresh and three-field status; the daemon's own stale-discovery cleanup (issue #49 Layer A) is unchanged and complementary.
- **API surface parity:** CLI-only feature; no plugin/MCP tool changes, no library subpath changes (nothing new exported from `package.json`).
- **Integration coverage:** seam tests prove sequencing; real launchd behavior (bootstrap/bootout/kickstart/RunAtLoad/restart-on-kill) is proven live at AE time on the operator machine — AE1–AE8 from the origin doc are the acceptance run.
- **Unchanged invariants:** `serve`/`stop`/`status` semantics untouched (origin scope boundary); discovery-file contract untouched; localhost guard untouched.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Pinned runtime path breaks after runtime upgrade/move (bun relocated) | Documented upgrade story: re-run `service install` (idempotent); `status` exposes running=false so the failure is visible; install warns when pinning ephemeral cache paths |
| `launchctl` output/behavior drift across macOS versions | Logic keys off exit codes only; `pid =` parse is permissive and non-fatal; deferred-to-implementation note pins AE6 live check |
| Live AE testing perturbs the operator board | Run AEs against a throwaway roster + isolated XDG_STATE_HOME first (test-isolation lesson); the workspace roster install is the final dogfood step, gated on the throwaway pass |
| launchd restarts a failing daemon into a crash loop writing logs | Default 10s throttle + fail-closed supervisor exit; logs live in the bounded state dir |

## Sources & References

- **Origin document:** [docs/brainstorms/2026-07-11-service-persistence-requirements.md](../brainstorms/2026-07-11-service-persistence-requirements.md)
- Related code: `src/cli.ts` (`runServe` exit contract), `src/server.ts` (`superviseServer`), `src/discovery.ts` (`stateDirFor`)
- Related PRs: #59 (Layer B supervision), #62/#66 (reap lineage)
- External: `launchd.plist(5)`, `launchctl(1)` man pages
