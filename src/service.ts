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
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { stateDirFor } from "./discovery";
import {
  bootout,
  bootstrap,
  defaultLaunchctl,
  type ExecResult,
  type ExecSeam,
  kickstart,
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

const DEFAULT_VERIFY_BUDGET_MS = 10_000;
const DEFAULT_VERIFY_POLL_MS = 200;

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

function preCreateLog(path: string): void {
  try {
    // Append mode creates the file if absent (mode applied at creation)
    // without truncating an existing one.
    const fd = openSync(path, "a", 0o600);
    closeSync(fd);
  } catch {
    // best-effort — install verification below will surface real failures.
  }
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

  let warning: string | undefined;
  if (
    isEphemeralCachePath(resolved.execPath) ||
    isEphemeralCachePath(resolved.cliEntryPath)
  ) {
    warning =
      "space-bus service was installed pointing at an ephemeral package-manager cache path; this may break after the cache is cleared — install space-bus durably and re-run `service install`.";
  }

  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      error: `failed to create state directory ${stateDir}: ${String(err)}`,
    };
  }
  preCreateLog(`${stateDir}/service.log`);
  preCreateLog(`${stateDir}/service.err.log`);

  // R9: refresh — if a job with this label is already loaded, boot it out
  // before reinstalling. Tolerate bootout failure of a half-dead job.
  const existing = await printJob(resolved.uid, label, resolved.exec);
  if (existing.loaded) {
    await bootout(resolved.uid, label, resolved.exec);
  }

  const plistXml = renderPlist({
    runtime: resolved.execPath,
    cliEntry: resolved.cliEntryPath,
    rosterPath,
    stateDir,
    label,
  });

  const writeResult = writePlistAtomic(plistFilePath, plistXml);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }

  const safety = verifyPlistSafe(plistFilePath);
  if (!safety.safe) {
    return { ok: false, error: `refusing to install: ${safety.reason}` };
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

  const verified = await verifyRunning(rosterPath, label, resolved);
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
): Promise<VerifyResult> {
  const deadline = resolved.now() + resolved.verifyBudgetMs;
  let lastLoaded = false;
  let lastRunning = false;
  let lastPid: number | undefined;
  for (;;) {
    const job = await printJob(resolved.uid, label, resolved.exec);
    const status = resolved.serverStatus(rosterPath);
    lastLoaded = job.loaded;
    lastRunning = status.running;
    lastPid = job.pid ?? status.pid;
    if (job.loaded && status.running) {
      return { ok: true, pid: lastPid };
    }
    if (resolved.now() >= deadline) break;
    await resolved.sleep(resolved.verifyPollMs);
  }
  return {
    ok: false,
    error: `install did not verify as running within ${resolved.verifyBudgetMs}ms (loaded=${lastLoaded}, running=${lastRunning})`,
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

  const job = await printJob(resolved.uid, label, resolved.exec);
  let jobRemoved = false;
  if (job.loaded) {
    const bootoutResult = await bootout(resolved.uid, label, resolved.exec);
    jobRemoved = bootoutResult.code === 0;
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
  const job = await printJob(resolved.uid, label, resolved.exec);
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
  const job = await printJob(resolved.uid, label, resolved.exec);
  if (!job.loaded) {
    return { ok: true, label, wasLoaded: false };
  }

  const bootoutResult = await bootout(resolved.uid, label, resolved.exec);
  if (bootoutResult.code !== 0) {
    return {
      ok: false,
      error: `launchctl bootout failed (exit ${bootoutResult.code})${stderrDetail(bootoutResult)}`,
    };
  }
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

  const { label, plistFilePath } = identityFor(
    rosterPath,
    resolved.launchAgentsDir,
  );
  if (!existsSync(plistFilePath)) {
    return {
      ok: false,
      error: `space-bus service is not installed for this roster — run \`space-bus service install\``,
    };
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

  const job = await printJob(resolved.uid, label, resolved.exec);
  if (!job.loaded) {
    return {
      ok: false,
      error: "launchctl reported the job as not loaded after start",
    };
  }

  return { ok: true, label, pid: job.pid };
}

// Re-exported for callers that only need identity derivation without
// invoking a verb (e.g. CLI help text or docs generation).
export {
  identityFor as serviceIdentity,
  NOT_SUPPORTED_ERROR as SERVICE_NOT_SUPPORTED_ERROR,
};
