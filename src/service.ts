/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins `launchd.ts`/`discovery.ts`/`server.ts`'s lane):
 * orchestrates the five `space-bus service` verbs (install/uninstall/
 * status/stop/start) on top of `launchd.ts`'s plist/launchctl primitives.
 * MUST NOT be imported by core.ts, contract.ts, format.ts, or attach.ts —
 * those stay browser-safe.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

import { stateDirFor } from "./discovery";
import {
  bootout,
  bootstrap,
  defaultLaunchctl,
  type ExecResult,
  type ExecSeam,
  kickstart,
  type PrintJobResult,
  plistPath,
  printJob,
  renderPlist,
  serviceLabel,
  verifyPlistSafe,
  writePlistAtomic,
} from "./launchd";
import {
  serverStatus as defaultServerStatus,
  type ServerStatus,
} from "./server";
import { acquireServiceLock } from "./service-lock";

const NOT_SUPPORTED_ERROR =
  "space-bus service is not supported on this platform (v1 supports macOS/launchd)";

/** Path segments that mark a runtime/CLI-entry path as living in an
 * ephemeral package-manager cache — surfaced as an install-time warning
 * recommending a durable install (plan Key Technical Decisions). */
const EPHEMERAL_CACHE_SEGMENTS = [
  "/.bun/install/cache/",
  "/_npx/",
  "/.npm/_npx/",
];

// Must exceed launchd's 10s ThrottleInterval (renderPlist) so a throttled
// restart mid-verification doesn't false-fail a genuinely-healthy install.
const DEFAULT_VERIFY_BUDGET_MS = 20_000;
const DEFAULT_VERIFY_POLL_MS = 200;
/** Short delay + single retry budget for the exit-5 state-aware retry in
 * installService's reinstall-after-bootout path. */
const EXIT5_RETRY_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Injectable seams for the service verbs — mirrors `RunServeDeps`'s
 * pattern in cli.ts. All fields are optional and default to the real
 * implementations. */
export interface ServiceDeps {
  exec?: ExecSeam;
  platform?: NodeJS.Platform;
  uid?: number;
  execPath?: string;
  /** Absolute path of the CLI entry module. Defaults to `process.argv[1]`
   * resolved to absolute — Unit 3 is responsible for wiring a durable
   * resolution (e.g. `fileURLToPath(import.meta.url)`) when invoking these
   * verbs from the running CLI. */
  cliEntryPath?: string;
  serverStatus?: typeof defaultServerStatus;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. */
  now?: () => number;
  /** Bounds the install verification poll loop. Default 10s. */
  verifyBudgetMs?: number;
  /** Poll interval for the install verification loop. Default 200ms. */
  verifyPollMs?: number;
  /**
   * Base directory for the launchd agent plist. Defaults to
   * `~/Library/LaunchAgents`. Tests MUST inject a mkdtemp dir here — never
   * exercise the default against the real filesystem.
   */
  launchAgentsDir?: string;
}

interface ResolvedDeps {
  exec: ExecSeam;
  platform: NodeJS.Platform;
  uid: number;
  execPath: string;
  cliEntryPath: string;
  serverStatus: typeof defaultServerStatus;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  verifyBudgetMs: number;
  verifyPollMs: number;
  launchAgentsDir: string;
}

function defaultCliEntryPath(): string {
  const argv1 = process.argv[1];
  return argv1 ?? process.execPath;
}

function resolveDeps(deps: ServiceDeps): ResolvedDeps {
  return {
    exec: deps.exec ?? defaultLaunchctl,
    platform: deps.platform ?? process.platform,
    uid: deps.uid ?? (process.getuid ? process.getuid() : 0),
    execPath: deps.execPath ?? process.execPath,
    cliEntryPath: deps.cliEntryPath ?? defaultCliEntryPath(),
    serverStatus: deps.serverStatus ?? defaultServerStatus,
    sleep: deps.sleep ?? sleep,
    now: deps.now ?? Date.now,
    verifyBudgetMs: deps.verifyBudgetMs ?? DEFAULT_VERIFY_BUDGET_MS,
    verifyPollMs: deps.verifyPollMs ?? DEFAULT_VERIFY_POLL_MS,
    launchAgentsDir:
      deps.launchAgentsDir ?? join(homedir(), "Library", "LaunchAgents"),
  };
}

function isEphemeralCachePath(path: string): boolean {
  return EPHEMERAL_CACHE_SEGMENTS.some((segment) => path.includes(segment));
}

function stderrDetail(result: ExecResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0
    ? ` — ${stderr}`
    : result.stdout.trim().length > 0
      ? ` — ${result.stdout.trim()}`
      : "";
}

// --- Platform gate -----------------------------------------------------

export type PlatformGate = { ok: true } | { ok: false; error: string };

function platformGate(platform: NodeJS.Platform): PlatformGate {
  if (platform !== "darwin") {
    return { ok: false, error: NOT_SUPPORTED_ERROR };
  }
  return { ok: true };
}

// --- Shared identity/paths ----------------------------------------------

interface ServiceIdentity {
  label: string;
  plistFilePath: string;
  stateDir: string;
}

function identityFor(
  rosterPath: string,
  launchAgentsDir: string,
): ServiceIdentity {
  const label = serviceLabel(rosterPath);
  return {
    label,
    plistFilePath: plistPath(label, launchAgentsDir),
    stateDir: stateDirFor(rosterPath),
  };
}

/** A service identity plus the roster path it is keyed on. */
type ResolvedIdentity = ServiceIdentity & { rosterPath: string };

/** Bounds a symlink chain; a loop exhausts it. */
const MAX_ROSTER_LINK_HOPS = 40;

type PathStep =
  | { kind: "missing" }
  | { kind: "plain" }
  | { kind: "link"; target: string }
  | { kind: "error"; detail: string };

/** One lstat (+ readlink for a symlink). Only ENOENT counts as missing. */
function statStep(path: string): PathStep {
  try {
    return lstatSync(path).isSymbolicLink()
      ? { kind: "link", target: readlinkSync(path) }
      : { kind: "plain" };
  } catch (err) {
    return isEnoent(err)
      ? { kind: "missing" }
      : { kind: "error", detail: `${path}: ${String(err)}` };
  }
}

/** Path components, with `.` and empty segments dropped but `..` kept. */
function splitPath(path: string): string[] {
  return path.split(sep).filter((s) => s !== "" && s !== ".");
}

/**
 * `realpath` that tolerates a missing tail (#81): follows every existing
 * symlink (absolute, or relative to its own physical directory), applies `..`
 * to the physical path, and appends what follows the first missing component
 * lexically — the path `realpathSync` yielded while the roster existed. It
 * never pre-normalizes `input`, so `..` is not collapsed across a symlink.
 * ENOTDIR, ELOOP, EACCES, an unreadable link or a looping chain are errors,
 * never a guessed path.
 */
function realpathLoose(input: string): ResolveResult<string> {
  const fail = (detail: string): ResolveResult<string> => ({
    ok: false,
    error: `cannot resolve roster path ${input}: ${detail}`,
  });
  let pending = splitPath(input);
  let current: string = sep;
  let hops = 0;
  while (pending.length > 0) {
    const [segment = "", ...rest] = pending;
    pending = rest;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = join(current, segment);
    const step = statStep(candidate);
    if (step.kind === "missing") {
      return { ok: true, value: join(candidate, ...rest) };
    }
    if (step.kind === "plain") {
      current = candidate;
      continue;
    }
    if (step.kind === "error") return fail(step.detail);
    hops += 1;
    if (hops > MAX_ROSTER_LINK_HOPS) {
      return fail("roster symlink chain loops or is too long");
    }
    if (isAbsolute(step.target)) current = sep;
    pending = [...splitPath(step.target), ...pending];
  }
  return { ok: true, value: current };
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The identity every verb uses for a roster path (#81). `resolveRosterPath`
 * yields the realpath only while the roster exists, so a roster deleted behind
 * a symlinked alias or directory arrives as a non-canonical path whose hash is
 * not the label install used. Resolve it with `realpathLoose`, then pick
 * between the canonical identity and the path exactly as given, because
 * installs made before this fix are keyed on the latter:
 *  - only one of the two plists exists: use that one (never switch an existing
 *    install to a new label);
 *  - both exist: ambiguous, refuse rather than act on a possibly wrong job;
 *  - neither exists: a symlink roster uses the canonical identity (so an
 *    install through a dangling alias reuses the canonical job); any other
 *    path keeps the given identity, as before.
 * An already-canonical path, and a relative path, take no branch.
 */
function resolveIdentity(
  rosterPath: string,
  launchAgentsDir: string,
): ResolveResult<ResolvedIdentity> {
  const given = identityFor(rosterPath, launchAgentsDir);
  const walked = isAbsolute(rosterPath)
    ? realpathLoose(rosterPath)
    : { ok: true as const, value: rosterPath };
  if (!walked.ok) return walked;
  if (walked.value === rosterPath)
    return { ok: true, value: { ...given, rosterPath } };

  const canonical = identityFor(walked.value, launchAgentsDir);
  const hasCanonical = existsSync(canonical.plistFilePath);
  const hasGiven = existsSync(given.plistFilePath);
  if (hasCanonical && hasGiven) {
    return {
      ok: false,
      error: `ambiguous service identity for roster ${rosterPath}: a plist exists for both ${walked.value} (${canonical.plistFilePath}) and the path as given (${given.plistFilePath}); boot out and remove the stale one by hand`,
    };
  }
  const useCanonical = hasCanonical || (!hasGiven && isSymlink(rosterPath));
  return useCanonical
    ? { ok: true, value: { ...canonical, rosterPath: walked.value } }
    : { ok: true, value: { ...given, rosterPath } };
}

export type PreCreateLogResult = { ok: true } | { ok: false; error: string };

/**
 * Runs a mutating verb under the roster's cross-process service lock (#81).
 * Taken after identity resolution (alias, canonical and dangling-alias paths
 * all reach the same state dir) and BEFORE the first shared operation, held
 * through verification, and released on every exit path including a throw.
 * Fails fast, without mutation, if another operation holds it. `status` never
 * calls this. Public verbs call it exactly once; the `*Locked` bodies they
 * delegate to never call a public verb, so the lock is never taken twice.
 */
async function withServiceLock<T>(
  stateDir: string,
  run: () => Promise<T>,
): Promise<T | { ok: false; error: string }> {
  const dir = ensureStateDir(stateDir);
  if (!dir.ok) return dir;
  const acquired = acquireServiceLock(stateDir);
  if (!acquired.ok) return acquired;
  try {
    return await run();
  } finally {
    acquired.lock.release();
  }
}

/**
 * Ensures a service log file exists and is 0600, refusing a symlink at
 * that path (a symlinked log path must never let install silently write
 * through to an attacker-controlled target). Real IO errors (not just
 * "already exists") fail honestly instead of being swallowed — install
 * should not proceed believing logging is set up when it isn't.
 */
function preCreateLog(path: string): PreCreateLogResult {
  // Open atomically with O_NOFOLLOW so the kernel refuses a symlink at the
  // path (no separate lstat check-then-open — that's a TOCTOU race). O_APPEND
  // preserves an existing log; O_CREAT makes it when absent. Harden the mode
  // via the open fd (fchmod), never by re-resolving the path.
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if (isSymlinkError(err)) {
      return { ok: false, error: `refusing symlinked log path: ${path}` };
    }
    return { ok: false, error: `failed to create log ${path}: ${String(err)}` };
  }
  try {
    fchmodSync(fd, 0o600);
  } catch (err) {
    return { ok: false, error: `failed to chmod log ${path}: ${String(err)}` };
  } finally {
    closeSync(fd);
  }
  return { ok: true };
}

/** ELOOP is what `open(O_NOFOLLOW)` raises when the final path component is a
 * symlink; treat it as the "refusing symlink" case rather than a generic IO
 * failure. */
function isSymlinkError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ELOOP"
  );
}

/**
 * Ensures the roster's state directory exists at 0700, hardening an
 * already-existing directory's mode rather than trusting `mkdirSync`'s
 * `mode` option (which is a no-op when the directory already exists —
 * e.g. left behind from a previous install with a looser umask).
 */
function ensureStateDir(stateDir: string): PreCreateLogResult {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      error: `failed to create state directory ${stateDir}: ${String(err)}`,
    };
  }
  try {
    chmodSync(stateDir, 0o700);
  } catch (err) {
    return {
      ok: false,
      error: `failed to harden state directory ${stateDir}: ${String(err)}`,
    };
  }
  return { ok: true };
}

/** Narrows a `PrintJobResult` for callers that must fail honestly rather
 * than silently treating a probe failure as "job absent". */
type JobProbeResult =
  | { ok: true; loaded: boolean; pid?: number }
  | { ok: false; error: string };

async function probeJob(
  resolved: ResolvedDeps,
  label: string,
): Promise<JobProbeResult> {
  const result: PrintJobResult = await printJob(
    resolved.uid,
    label,
    resolved.exec,
  );
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return result.pid !== undefined
    ? { ok: true, loaded: result.loaded, pid: result.pid }
    : { ok: true, loaded: result.loaded };
}

type ResolveResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * XDG_STATE_HOME split (P1-C): `stateDirFor` resolves under
 * `XDG_STATE_HOME` when the installer's environment set it. If we don't
 * pin the same value into the plist, the launchd-launched process runs
 * under launchd's sparse env (no `XDG_STATE_HOME`) and falls back to
 * `~/.local/state` — silently diverging from the installer's `stateDir`.
 */
function resolveXdgStateHome(): ResolveResult<string | undefined> {
  const xdgStateHomeEnv = process.env["XDG_STATE_HOME"];
  if (xdgStateHomeEnv === undefined) return { ok: true, value: undefined };
  if (!isAbsolute(xdgStateHomeEnv)) {
    return {
      ok: false,
      error: `XDG_STATE_HOME must be an absolute path to pin into the launchd environment, got: ${xdgStateHomeEnv}`,
    };
  }
  return { ok: true, value: xdgStateHomeEnv };
}

type BootstrapOutcome = { ok: true } | { ok: false; error: string };

/**
 * Runs `bootstrap`, applying the exit-5 state-aware retry (Oracle recipe)
 * for the reinstall-after-bootout path ONLY: exit 5 typically means
 * "already bootstrapped". Re-probe rather than blindly retrying — if
 * already loaded, treat as success (kickstart will proceed normally); if
 * confirmed absent (a transient race with launchd's own teardown), wait
 * briefly and retry exactly once; anything ambiguous (probe failure)
 * fails honestly, reporting both attempts.
 */
async function bootstrapWithExit5Retry(
  resolved: ResolvedDeps,
  label: string,
  plistFilePath: string,
): Promise<BootstrapOutcome> {
  const bootstrapResult = await bootstrap(
    resolved.uid,
    plistFilePath,
    resolved.exec,
  );
  if (bootstrapResult.code === 0) return { ok: true };
  if (bootstrapResult.code !== 5) {
    return {
      ok: false,
      error: `launchctl bootstrap failed (exit ${bootstrapResult.code})${stderrDetail(bootstrapResult)}`,
    };
  }

  const reprobe = await probeJob(resolved, label);
  if (!reprobe.ok) {
    return {
      ok: false,
      error: `launchctl bootstrap failed (exit 5)${stderrDetail(bootstrapResult)}; re-probe also failed: ${reprobe.error}`,
    };
  }
  if (reprobe.loaded) return { ok: true };

  await resolved.sleep(EXIT5_RETRY_DELAY_MS);
  const retryResult = await bootstrap(
    resolved.uid,
    plistFilePath,
    resolved.exec,
  );
  if (retryResult.code !== 0) {
    return {
      ok: false,
      error: `launchctl bootstrap failed twice (exit 5, then exit ${retryResult.code})${stderrDetail(bootstrapResult)}; retry: ${stderrDetail(retryResult)}`,
    };
  }
  return { ok: true };
}

/**
 * Prepares install's cold-machine filesystem prerequisites: the
 * LaunchAgents dir, the state dir (hardened 0700), and the two 0600 log
 * files. Extracted purely to keep `installService`'s cognitive complexity
 * under the linter's threshold.
 */
function prepareInstallFilesystem(
  resolved: ResolvedDeps,
  stateDir: string,
): PreCreateLogResult {
  try {
    mkdirSync(resolved.launchAgentsDir, { recursive: true, mode: 0o755 });
  } catch (err) {
    return {
      ok: false,
      error: `failed to create LaunchAgents directory ${resolved.launchAgentsDir}: ${String(err)}`,
    };
  }

  const stateDirResult = ensureStateDir(stateDir);
  if (!stateDirResult.ok) return stateDirResult;

  const outLogResult = preCreateLog(`${stateDir}/service.log`);
  if (!outLogResult.ok) return outLogResult;
  return preCreateLog(`${stateDir}/service.err.log`);
}

function ephemeralCacheWarning(resolved: ResolvedDeps): string | undefined {
  if (
    isEphemeralCachePath(resolved.execPath) ||
    isEphemeralCachePath(resolved.cliEntryPath)
  ) {
    return "space-bus service was installed pointing at an ephemeral package-manager cache path; this may break after the cache is cleared — install space-bus durably and re-run `service install`.";
  }
  return undefined;
}

type BootoutOutcome = { ok: true } | { ok: false; error: string };

/**
 * Runs `bootout` against a loaded job; if it fails, re-probes rather than
 * assuming success or immediately failing — a bootout can report non-zero
 * while the job is actually gone (races with launchd's own teardown), and
 * conversely can report zero while something else keeps the job around.
 * Only a CONFIRMED-absent job after the probe is treated as success; an
 * ambiguous probe failure or a confirmed-still-loaded job fails honestly.
 */
async function bootoutUntilAbsentOrFail(
  resolved: ResolvedDeps,
  label: string,
): Promise<BootoutOutcome> {
  const bootoutResult = await bootout(resolved.uid, label, resolved.exec);
  if (bootoutResult.code === 0) return { ok: true };

  const reprobe = await probeJob(resolved, label);
  if (!reprobe.ok) {
    return {
      ok: false,
      error: `launchctl bootout failed (exit ${bootoutResult.code})${stderrDetail(bootoutResult)}; re-probe to confirm absence also failed: ${reprobe.error}`,
    };
  }
  if (reprobe.loaded) {
    return {
      ok: false,
      error: `launchctl bootout failed (exit ${bootoutResult.code})${stderrDetail(bootoutResult)} and the job is still loaded`,
    };
  }
  return { ok: true };
}

// --- install -------------------------------------------------------------

export type InstallResult =
  | {
      ok: true;
      label: string;
      plistPath: string;
      pid?: number;
      warning?: string;
    }
  | { ok: false; error: string };

export async function installService(
  rosterPath: string,
  deps: ServiceDeps = {},
): Promise<InstallResult> {
  const resolved = resolveDeps(deps);
  const gate = platformGate(resolved.platform);
  if (!gate.ok) return { ok: false, error: gate.error };

  const identity = resolveIdentity(rosterPath, resolved.launchAgentsDir);
  if (!identity.ok) return { ok: false, error: identity.error };
  return withServiceLock(identity.value.stateDir, () =>
    installLocked(resolved, identity.value),
  );
}

async function installLocked(
  resolved: ResolvedDeps,
  identity: ResolvedIdentity,
): Promise<InstallResult> {
  const { label, plistFilePath, stateDir } = identity;
  const roster = identity.rosterPath;

  const warning = ephemeralCacheWarning(resolved);

  const fsResult = prepareInstallFilesystem(resolved, stateDir);
  if (!fsResult.ok) return fsResult;

  const xdgResolved = resolveXdgStateHome();
  if (!xdgResolved.ok) return { ok: false, error: xdgResolved.error };
  const xdgStateHome = xdgResolved.value;

  // R9: refresh — if a job with this label is already loaded, boot it out
  // before reinstalling. A failed bootout of a still-loaded job must NOT
  // be tolerated silently (P1-B): re-probe and only proceed if the job is
  // now confirmed absent.
  const existing = await probeJob(resolved, label);
  if (!existing.ok) {
    return {
      ok: false,
      error: `failed to probe existing job: ${existing.error}`,
    };
  }
  if (existing.loaded) {
    const bootoutOutcome = await bootoutUntilAbsentOrFail(resolved, label);
    if (!bootoutOutcome.ok) return bootoutOutcome;
  }

  const plistXml = renderPlist({
    runtime: resolved.execPath,
    cliEntry: resolved.cliEntryPath,
    rosterPath: roster,
    stateDir,
    label,
    path: process.env["PATH"],
    xdgStateHome,
  });

  const writeResult = writePlistAtomic(plistFilePath, plistXml);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }

  const safety = verifyPlistSafe(plistFilePath);
  if (!safety.safe) {
    return { ok: false, error: `refusing to install: ${safety.reason}` };
  }

  const bootstrapOutcome = await bootstrapWithExit5Retry(
    resolved,
    label,
    plistFilePath,
  );
  if (!bootstrapOutcome.ok) return bootstrapOutcome;

  const kickstartResult = await kickstart(resolved.uid, label, resolved.exec);
  if (kickstartResult.code !== 0) {
    return {
      ok: false,
      error: `launchctl kickstart failed (exit ${kickstartResult.code})${stderrDetail(kickstartResult)}`,
    };
  }

  const verified = await verifyRunning(roster, label, resolved, plistFilePath);
  if (!verified.ok) return verified;

  return {
    ok: true,
    label,
    plistPath: plistFilePath,
    pid: verified.pid,
    warning,
  };
}

type VerifyResult = { ok: true; pid?: number } | { ok: false; error: string };

async function verifyRunning(
  rosterPath: string,
  label: string,
  resolved: ResolvedDeps,
  plistFilePath?: string,
): Promise<VerifyResult> {
  const deadline = resolved.now() + resolved.verifyBudgetMs;
  let lastLoaded = false;
  let lastRunning = false;
  let lastPid: number | undefined;
  let lastProbeError: string | undefined;
  for (;;) {
    const job = await probeJob(resolved, label);
    const status = resolved.serverStatus(rosterPath);
    lastRunning = status.running;
    if (job.ok) {
      lastLoaded = job.loaded;
      lastPid = job.pid ?? status.pid;
      lastProbeError = undefined;
      if (job.loaded && status.running) {
        return { ok: true, pid: lastPid };
      }
    } else {
      lastProbeError = job.error;
    }
    if (resolved.now() >= deadline) break;
    await resolved.sleep(resolved.verifyPollMs);
  }
  const stateDir = stateDirFor(rosterPath);
  const logPath = join(stateDir, "service.log");
  return {
    ok: false,
    error:
      `install did not verify as running within ${resolved.verifyBudgetMs}ms ` +
      `(loaded=${lastLoaded}, running=${lastRunning}` +
      `${lastProbeError ? `, last probe error: ${lastProbeError}` : ""})` +
      ` — label=${label}, plist=${plistFilePath ?? plistPath(label, resolved.launchAgentsDir)}, log=${logPath}`,
  };
}

// --- uninstall -------------------------------------------------------------

export type UninstallResult =
  | { ok: true; removed: { job: boolean; plist: boolean }; label: string }
  | { ok: false; error: string };

export async function uninstallService(
  rosterPath: string,
  deps: ServiceDeps = {},
): Promise<UninstallResult> {
  const resolved = resolveDeps(deps);
  const gate = platformGate(resolved.platform);
  if (!gate.ok) return { ok: false, error: gate.error };

  const identity = resolveIdentity(rosterPath, resolved.launchAgentsDir);
  if (!identity.ok) return { ok: false, error: identity.error };
  return withServiceLock(identity.value.stateDir, () =>
    uninstallLocked(resolved, identity.value),
  );
}

async function uninstallLocked(
  resolved: ResolvedDeps,
  identity: ResolvedIdentity,
): Promise<UninstallResult> {
  const { label, plistFilePath } = identity;

  const job = await probeJob(resolved, label);
  if (!job.ok) {
    return { ok: false, error: `failed to probe job: ${job.error}` };
  }

  let jobRemoved = false;
  if (job.loaded) {
    // P1-B: a failed bootout of a still-loaded job must NOT silently
    // degrade — don't unlink the plist and don't return ok:true unless
    // the job is confirmed absent afterward.
    const outcome = await bootoutUntilAbsentOrFail(resolved, label);
    if (!outcome.ok) return outcome;
    jobRemoved = true;
  }

  let plistRemoved = false;
  try {
    unlinkSync(plistFilePath);
    plistRemoved = true;
  } catch (err) {
    if (!isEnoent(err)) {
      return {
        ok: false,
        error: `failed to remove plist ${plistFilePath}: ${String(err)}`,
      };
    }
  }

  return {
    ok: true,
    removed: { job: jobRemoved, plist: plistRemoved },
    label,
  };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

// --- status ----------------------------------------------------------------

export type StatusResult =
  | {
      ok: true;
      installed: boolean;
      loaded: boolean;
      running: boolean;
      pid?: number;
      label: string;
      plistPath: string;
    }
  | { ok: false; error: string };

export async function serviceStatus(
  rosterPath: string,
  deps: ServiceDeps = {},
): Promise<StatusResult> {
  const resolved = resolveDeps(deps);
  const gate = platformGate(resolved.platform);
  if (!gate.ok) return { ok: false, error: gate.error };

  const identity = resolveIdentity(rosterPath, resolved.launchAgentsDir);
  if (!identity.ok) return { ok: false, error: identity.error };
  const { label, plistFilePath } = identity.value;
  const installed = existsSync(plistFilePath);
  const job = await probeJob(resolved, label);
  if (!job.ok) {
    return { ok: false, error: `failed to probe job: ${job.error}` };
  }
  const status: ServerStatus = resolved.serverStatus(identity.value.rosterPath);

  return {
    ok: true,
    installed,
    loaded: job.loaded,
    running: status.running,
    pid: job.pid ?? status.pid,
    label,
    plistPath: plistFilePath,
  };
}

// --- stop ------------------------------------------------------------------

export type StopResult =
  | { ok: true; label: string; wasLoaded: boolean }
  | { ok: false; error: string };

export async function stopService(
  rosterPath: string,
  deps: ServiceDeps = {},
): Promise<StopResult> {
  const resolved = resolveDeps(deps);
  const gate = platformGate(resolved.platform);
  if (!gate.ok) return { ok: false, error: gate.error };

  const identity = resolveIdentity(rosterPath, resolved.launchAgentsDir);
  if (!identity.ok) return { ok: false, error: identity.error };
  return withServiceLock(identity.value.stateDir, () =>
    stopLocked(resolved, identity.value),
  );
}

async function stopLocked(
  resolved: ResolvedDeps,
  identity: ResolvedIdentity,
): Promise<StopResult> {
  const { label } = identity;
  const job = await probeJob(resolved, label);
  if (!job.ok) {
    return { ok: false, error: `failed to probe job: ${job.error}` };
  }
  if (!job.loaded) {
    return { ok: true, label, wasLoaded: false };
  }

  const outcome = await bootoutUntilAbsentOrFail(resolved, label);
  if (!outcome.ok) return outcome;
  return { ok: true, label, wasLoaded: true };
}

// --- start -----------------------------------------------------------------

export type StartResult =
  | { ok: true; label: string; pid?: number }
  | { ok: false; error: string };

export async function startService(
  rosterPath: string,
  deps: ServiceDeps = {},
): Promise<StartResult> {
  const resolved = resolveDeps(deps);
  const gate = platformGate(resolved.platform);
  if (!gate.ok) return { ok: false, error: gate.error };

  const identity = resolveIdentity(rosterPath, resolved.launchAgentsDir);
  if (!identity.ok) return { ok: false, error: identity.error };
  return withServiceLock(identity.value.stateDir, () =>
    startLocked(resolved, identity.value),
  );
}

async function startLocked(
  resolved: ResolvedDeps,
  identity: ResolvedIdentity,
): Promise<StartResult> {
  const { label, plistFilePath, stateDir } = identity;
  const roster = identity.rosterPath;
  if (!existsSync(plistFilePath)) {
    return {
      ok: false,
      error: `space-bus service is not installed for this roster — run \`space-bus service install\``,
    };
  }

  // P1-D: start is a load path too — must not bootstrap a tampered/stale
  // plist. Re-render from trusted inputs and atomically replace it (same
  // path as install), rather than trusting whatever's currently on disk.
  const xdgResolved = resolveXdgStateHome();
  if (!xdgResolved.ok) return { ok: false, error: xdgResolved.error };
  const xdgStateHome = xdgResolved.value;
  const plistXml = renderPlist({
    runtime: resolved.execPath,
    cliEntry: resolved.cliEntryPath,
    rosterPath: roster,
    stateDir,
    label,
    path: process.env["PATH"],
    xdgStateHome,
  });
  const writeResult = writePlistAtomic(plistFilePath, plistXml);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }
  const safety = verifyPlistSafe(plistFilePath);
  if (!safety.safe) {
    return { ok: false, error: `refusing to start: ${safety.reason}` };
  }

  const bootstrapResult = await bootstrap(
    resolved.uid,
    plistFilePath,
    resolved.exec,
  );
  if (bootstrapResult.code !== 0) {
    return {
      ok: false,
      error: `launchctl bootstrap failed (exit ${bootstrapResult.code})${stderrDetail(bootstrapResult)}`,
    };
  }

  const kickstartResult = await kickstart(resolved.uid, label, resolved.exec);
  if (kickstartResult.code !== 0) {
    return {
      ok: false,
      error: `launchctl kickstart failed (exit ${kickstartResult.code})${stderrDetail(kickstartResult)}`,
    };
  }

  // Use the same bounded verification loop as install — a loaded-but-not-
  // running daemon must not be reported as a successful start.
  const verified = await verifyRunning(roster, label, resolved, plistFilePath);
  if (!verified.ok) return verified;

  return { ok: true, label, pid: verified.pid };
}

// Re-exported for callers that only need identity derivation without
// invoking a verb (e.g. CLI help text or docs generation).
export {
  identityFor as serviceIdentity,
  NOT_SUPPORTED_ERROR as SERVICE_NOT_SUPPORTED_ERROR,
};
