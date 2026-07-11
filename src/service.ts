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
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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

export type PreCreateLogResult = { ok: true } | { ok: false; error: string };

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

  const { label, plistFilePath, stateDir } = identityFor(
    rosterPath,
    resolved.launchAgentsDir,
  );

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
    rosterPath,
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

  const verified = await verifyRunning(
    rosterPath,
    label,
    resolved,
    plistFilePath,
  );
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

  const { label, plistFilePath } = identityFor(
    rosterPath,
    resolved.launchAgentsDir,
  );

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

  const { label, plistFilePath } = identityFor(
    rosterPath,
    resolved.launchAgentsDir,
  );
  const installed = existsSync(plistFilePath);
  const job = await probeJob(resolved, label);
  if (!job.ok) {
    return { ok: false, error: `failed to probe job: ${job.error}` };
  }
  const status: ServerStatus = resolved.serverStatus(rosterPath);

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

  const { label } = identityFor(rosterPath, resolved.launchAgentsDir);
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

  const { label, plistFilePath, stateDir } = identityFor(
    rosterPath,
    resolved.launchAgentsDir,
  );
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
    rosterPath,
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
  const verified = await verifyRunning(
    rosterPath,
    label,
    resolved,
    plistFilePath,
  );
  if (!verified.ok) return verified;

  return { ok: true, label, pid: verified.pid };
}

// Re-exported for callers that only need identity derivation without
// invoking a verb (e.g. CLI help text or docs generation).
export {
  identityFor as serviceIdentity,
  NOT_SUPPORTED_ERROR as SERVICE_NOT_SUPPORTED_ERROR,
};
