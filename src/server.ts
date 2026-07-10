/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins `discovery.ts`/`config.ts`'s lane): managed-server
 * lifecycle — ensure (attach-or-spawn), attach-only, status, stop. MUST NOT
 * be imported by core.ts, contract.ts, or format.ts — those stay
 * browser-safe.
 *
 * Detach note: a spike (see src/server.test.ts) confirmed
 * `node:child_process.spawn({ detached: true }).unref()` produces a child
 * that outlives its Bun parent process, so that's the spawn primitive used
 * here (no Bun.spawn fallback needed).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { type ManagedServerConfig, manifestSchema } from "./config";
import {
  acquireLock,
  attachLive,
  captureIdentity,
  closeQuietly,
  isAlive,
  type LockHandle,
  lockFilePath,
  logFilePath,
  readDiscovery,
  readLockFile,
  readProvisional,
  releaseLock,
  removeDiscovery,
  removeDiscoveryIfMatches,
  removeProvisional,
  verifyIdentity,
  writeDiscovery,
  writeProvisional,
} from "./discovery";

const DEFAULT_READINESS_BUDGET_MS = 15_000;
const DEFAULT_LOCK_WAIT_BUDGET_MS = 15_000;
const POLL_INTERVAL_MS = 50;
/** Minimum time reserved for the HTTP readiness probe phase, carved out of
 * the overall readiness budget so a slow log-poll phase can't starve it. */
const MIN_PROBE_PHASE_MS = 3_000;
/** Per-fetch timeout for the HTTP readiness probe — a stalled response must
 * not block for the platform's TCP default. */
const PROBE_FETCH_TIMEOUT_MS = 2_000;
/** Bounded window for stopServer's SIGTERM->SIGKILL escalation. */
const STOP_GRACE_MS = 2_000;
/** Interval between supervision liveness ticks. */
export const SUPERVISE_INTERVAL_MS = 5_000;
/** Consecutive unreachable-probe failures (pid still alive) before the
 * supervisor declares the daemon hung and kills it. */
export const SUPERVISE_FAILURE_THRESHOLD = 3;
/** Absolute-lifetime watchdog: how long the daemon may go without a
 * genuinely-"ready" probe before it's declared hung, regardless of whether
 * failures ever hit 3-in-a-row. Bounds two cases the consecutive-failure
 * counter can't catch: a FLAPPING daemon (retry, ready, retry, ready, ...
 * never 3 consecutive) and a persistent auth-failure (server answers but
 * never actually serves, looping "silently" forever). Tunable; 60s gives
 * ~12 ticks at the default 5s interval to recover before being killed. */
export const SUPERVISE_UNHEALTHY_BUDGET_MS = 60_000;

export interface EnsureServerOptions {
  /** Bounds the readiness probe loop after spawning. Default 15s. */
  readinessBudgetMs?: number;
  /** Bounds how long a lock waiter polls for the winner's discovery file. Default 15s. */
  lockWaitBudgetMs?: number;
}

export interface ServerHandle {
  baseUrl: string;
  credentials: { username?: string; password?: string };
  pid: number;
  port: number;
}

export interface ServerStatus {
  running: boolean;
  port?: number;
  pid?: number;
  configDrift?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifest(rosterPath: string) {
  const raw = readFileSync(rosterPath, "utf8");
  const json = JSON.parse(raw);
  return manifestSchema.parse(json);
}

function readLogTail(logPath: string, maxChars = 4000): string {
  try {
    const content = readFileSync(logPath, "utf8");
    return content.length > maxChars ? content.slice(-maxChars) : content;
  } catch {
    return "";
  }
}

function basicAuthToken(password: string): string {
  return Buffer.from(`opencode:${password}`).toString("base64");
}

/**
 * Redacts the raw password AND the exact base64 Basic-auth token payload
 * from a log tail. The readiness probe sends
 * `Authorization: Basic base64("opencode:"+password)`; if the child
 * happens to log request headers, the raw-password redaction alone would
 * miss the still-sensitive base64 encoding of it. Redaction here is a
 * backup — the primary guarantee is that we never log the password
 * ourselves.
 */
export function redactSensitive(tail: string, password: string): string {
  return tail
    .replaceAll(basicAuthToken(password), "[REDACTED]")
    .replaceAll(password, "[REDACTED]");
}

function redactedReadinessError(
  rosterPath: string,
  password: string,
  reason: string,
): Error {
  const tail = redactSensitive(readLogTail(logFilePath(rosterPath)), password);
  return new Error(
    `space-bus: managed server for roster ${rosterPath} ${reason}. Log tail:\n${tail}`,
  );
}

/**
 * Signals a spawned managed server's whole process GROUP, not just the
 * recorded pid. `harness serve` (and `opencode serve`) is a thin wrapper
 * process that spawns the real opencode server as a CHILD — the child, not
 * the wrapper, holds the port. Because spawnAndWaitReady spawns with
 * `detached: true`, the wrapper becomes a process-group LEADER (its pgid
 * equals its pid) and the child inherits that same pgid. Signaling only the
 * bare wrapper pid kills the wrapper while the child survives as an
 * untracked orphan still holding the port. Signaling the negative pid
 * (`-pid`) targets the entire process group, cascading to the child too.
 *
 * Returns whether the GROUP form actually applied (true) or it fell back to
 * a bare-pid signal (false) — callers need this to know whether polling
 * group-liveness (`waitForGroupDeath`) or single-pid liveness
 * (`waitForDeath`) is the correct completion check.
 *
 * Error handling is deliberately asymmetric:
 * - ESRCH on the group form means "no such process group" (e.g. a
 *   non-detached spawn where the pid isn't a group leader, or the group is
 *   already gone) — falling back to a bare-pid signal is safe and correct
 *   here, since there's no group to have signaled in the first place.
 * - EPERM on the group form means the group EXISTS but we lack permission
 *   to signal it. Falling back to bare-pid here would silently kill only
 *   the wrapper while masking the fact that the group signal failed —
 *   worse than doing nothing, since it'd look like a successful group
 *   signal to the caller. Rethrow so the caller's try/catch treats it as a
 *   genuine failure instead of a false "handled" state.
 * - ESRCH on the bare-pid fallback means "already gone" — a no-op.
 *
 * Belt-and-suspenders pid guard: `process.kill(-1, sig)` signals EVERY
 * process the caller can signal, and `process.kill(-0, sig)` signals the
 * caller's own whole process group — either is catastrophic. The schemas
 * feeding this function already reject pid<2 at parse time, but this guard
 * makes the function itself safe even if a caller is ever added that
 * bypasses that validation: pid<=1 skips the group form entirely and goes
 * straight to a bare-pid signal.
 */
/** Robust EPERM check for a caught value that may or may not be a real
 * Node errno error (e.g. it could be a non-Error thrown value). */
function isEpermError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EPERM"
  );
}

function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) {
    try {
      process.kill(pid, sig);
    } catch {
      // Already gone — fine.
    }
    return false;
  }
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") {
      // Group exists, we can't signal it — surface this, don't degrade to
      // a bare-pid kill that would mask the failure.
      throw err;
    }
    // ESRCH: not a group leader, or the group is already gone — fall back
    // to signaling the bare pid.
  }
  try {
    process.kill(pid, sig);
  } catch {
    // Already gone — fine.
  }
  return false;
}

/**
 * Signals ONLY the process group (`-pid`), never the bare pid. Unlike
 * signalGroup, it does NOT fall back to a bare-pid kill on ESRCH — in the
 * reaper, the bare pid may have been recycled to an unrelated process, so a
 * fallback could signal a stranger. Returns true if the group signal was
 * delivered, false on ESRCH (group gone) or EPERM (exists but not signalable
 * — fail closed, do not signal).
 */
function signalGroupOnly(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) return false;
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

function killIdentifiedProcess(
  pid: number,
  identity: string | null | undefined,
): void {
  try {
    // Empty-string identity happens when captureIdentity failed at spawn
    // time (e.g. `ps` unavailable) and the provisional/discovery record
    // stored "" as a placeholder — treat it the same as null (no identity
    // to verify) rather than failing verifyIdentity and silently skipping
    // the kill.
    if (identity !== null && identity !== undefined && identity !== "") {
      if (verifyIdentity(pid, identity)) signalGroup(pid, "SIGTERM");
      return;
    }
    // No identity to verify — this pid might be a RECYCLED one now
    // belonging to an unrelated process. Group-signaling it would risk
    // SIGTERM-ing that unrelated process's entire subtree (worse blast
    // radius than the old bare-pid kill). Fall back to a narrow bare-pid
    // signal instead — only safe for a pid the caller knows is fresh (see
    // doc comment above), and even then the blast radius stays bounded to
    // the single pid.
    process.kill(pid, "SIGTERM");
  } catch {
    // Best-effort: already gone, or signalGroup rethrew EPERM (group
    // exists but we lack permission to signal it) — either way this is a
    // fire-and-forget cleanup path (readiness-failure/orphan-reap), not
    // somewhere a throw is appropriate.
  }
}

/**
 * Attach-only: reads discovery, verifies the recorded pid is alive with a
 * matching identity, and that the discovered baseUrl passes the loopback
 * guard. Never spawns. Delegates to discovery.ts's pure read-path (also
 * used directly by config.ts's managed loadContext, to avoid a
 * config->server->config cycle since server.ts imports config.ts already).
 */
export function attachServer(rosterPath: string): ServerHandle | null {
  return attachLive(rosterPath);
}

async function waitForDiscoveryOrFail(
  rosterPath: string,
  budgetMs: number,
): Promise<ServerHandle> {
  const deadline = Date.now() + budgetMs;
  const lockPath = lockFilePath(rosterPath);
  while (Date.now() < deadline) {
    // Check discovery first: the winner writes discovery BEFORE releasing
    // the lock on the success path (see spawnAndWaitReady/ensureServer), so
    // checking discovery ahead of the lock-liveness check below can't
    // false-fast-fail a winner that just succeeded.
    const handle = attachServer(rosterPath);
    if (handle) return handle;

    const lockInfo = readLockFile(lockPath);
    const winnerAlive =
      lockInfo !== null && verifyIdentity(lockInfo.pid, lockInfo.startTime);
    if (!winnerAlive) {
      // The lock is gone (winner released it, e.g. after a failed spawn or
      // readiness timeout) or its recorded owner is dead, and still no
      // discovery file appeared — the winner failed. Don't wait out the
      // full budget for something that will never arrive.
      throw new Error(
        `space-bus: the process starting the managed server for roster ${rosterPath} failed before it could finish (lock released without a discovery file) — check its log for details`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
  const lockInfo = readLockFile(lockPath);
  const holder = lockInfo ? `pid ${lockInfo.pid}` : "an unknown holder";
  throw new Error(
    `space-bus: timed out after ${budgetMs}ms waiting for ${holder} to finish starting the managed server for roster ${rosterPath}`,
  );
}

export type ProbeOutcome = "ready" | "auth-failure" | "retry";

export async function probe(
  baseUrl: string,
  password: string,
): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`${baseUrl}/session?limit=1`, {
      headers: { authorization: `Basic ${basicAuthToken(password)}` },
      signal: AbortSignal.timeout(PROBE_FETCH_TIMEOUT_MS),
    });
    if (res.status === 200) return "ready";
    if (res.status === 401 || res.status === 403) return "auth-failure";
    return "retry";
  } catch {
    return "retry";
  }
}

/** True if the spawned child has already died — a stalled/never-arriving
 * readiness line should fail fast rather than burn the full budget. */
function childDied(child: ChildProcess, pid: number): boolean {
  return child.exitCode !== null || child.signalCode !== null || !isAlive(pid);
}

async function waitForReadinessLine(
  logPath: string,
  child: ChildProcess,
  pid: number,
  deadline: number,
): Promise<{ port: number; baseUrl: string } | null> {
  // Capture ONLY the port digits from the log line; the host is a hardcoded
  // literal. This keeps file-derived data out of the outbound request URL
  // (CodeQL js/file-access-to-http) — the parsed integer port is the only
  // value that crosses from the log into the readiness probe.
  const readinessLine =
    /opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/;
  while (Date.now() < deadline) {
    if (childDied(child, pid)) return null;
    const tail = readLogTail(logPath);
    const match = readinessLine.exec(tail);
    if (match?.[1]) {
      const port = Number.parseInt(match[1], 10);
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        return { port, baseUrl: `http://127.0.0.1:${port}` };
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function pollAuthedEndpoint(
  baseUrl: string,
  password: string,
  child: ChildProcess,
  pid: number,
  deadline: number,
): Promise<"ready" | "died" | "auth-failure" | "timeout"> {
  while (Date.now() < deadline) {
    if (childDied(child, pid)) return "died";
    const outcome = await probe(baseUrl, password);
    if (outcome === "ready") return "ready";
    if (outcome === "auth-failure") return "auth-failure";
    await sleep(POLL_INTERVAL_MS);
  }
  return "timeout";
}

async function waitForReadiness(
  rosterPath: string,
  password: string,
  pid: number,
  identity: string | null,
  child: ChildProcess,
  budgetMs: number,
): Promise<{ port: number; baseUrl: string }> {
  const deadline = Date.now() + budgetMs;
  const logPath = logFilePath(rosterPath);

  // Phase 1: wait for the verified stdout readiness line, extract the port.
  // Reserve a slice of the budget for phase 2 so a starved log-poll phase
  // can't consume the entire budget and leave phase 2 with zero time — but
  // for small budgets, reserving a flat MIN_PROBE_PHASE_MS would instead
  // starve phase 1 (e.g. a 2000ms budget would give phase 1 ~0ms). Reserve
  // whichever is smaller: the flat minimum, or half the budget, so phase 1
  // always gets a fair share regardless of budget size.
  const phase2Reserve = Math.min(MIN_PROBE_PHASE_MS, budgetMs / 2);
  const phase1Deadline = Math.max(Date.now(), deadline - phase2Reserve);
  const lineResult = await waitForReadinessLine(
    logPath,
    child,
    pid,
    phase1Deadline,
  );

  if (lineResult === null) {
    const diedEarly = childDied(child, pid);
    killIdentifiedProcess(pid, identity);
    throw redactedReadinessError(
      rosterPath,
      password,
      diedEarly
        ? "exited before printing a readiness line"
        : `did not print a readiness line within ${budgetMs}ms`,
    );
  }
  const { port, baseUrl } = lineResult;

  // Phase 2: poll the authed endpoint — proves auth AND readiness at once.
  // Gets whatever remains of the overall budget, floored at
  // phase2Reserve regardless of how much phase 1 consumed.
  const phase2Deadline = Math.max(deadline, Date.now() + phase2Reserve);
  const outcome = await pollAuthedEndpoint(
    baseUrl,
    password,
    child,
    pid,
    phase2Deadline,
  );

  if (outcome === "ready") return { port, baseUrl };

  killIdentifiedProcess(pid, identity);
  if (outcome === "died") {
    throw redactedReadinessError(
      rosterPath,
      password,
      "exited before becoming ready",
    );
  }
  if (outcome === "auth-failure") {
    throw redactedReadinessError(
      rosterPath,
      password,
      "rejected our generated password (401/403) — authentication regression, not retrying",
    );
  }
  throw redactedReadinessError(
    rosterPath,
    password,
    `did not become ready within ${budgetMs}ms`,
  );
}

// A provisional record with an empty/missing identity is only safe to
// direct-kill (no identity to verify) if it's fresh enough that the pid is
// still overwhelmingly likely to be the process we spawned, not something
// the OS recycled the pid to later. A just-spawned child that failed
// readiness is always well under this window; a provisional record left
// behind by a long-dead parent and reaped much later may not be.
const PROVISIONAL_FRESH_WINDOW_MS = 5_000;

/**
 * Reaps a leftover provisional-spawn record left by a parent that died
 * between spawn and writing full discovery (finding 7). If the recorded
 * pid+identity still verifies live, it's killed (best-effort) before we
 * proceed to spawn a fresh child; either way the stale provisional record
 * is removed so it can't wedge future ensures.
 *
 * Safety: an empty/missing identity means we can't verify the pid before
 * killing it. That's acceptable for a pid known to be fresh (see
 * killIdentifiedProcess's readiness-path caller) but not here — this
 * record may be arbitrarily old (parent died, and reaping happens on the
 * next ensure, possibly much later), so an unverifiable pid is skipped
 * unless `since` shows it's still within the fresh window. Leaking a rare
 * orphan process is safer than killing a recycled, unrelated one.
 */
function reapOrphanedProvisional(rosterPath: string): void {
  const provisional = readProvisional(rosterPath);
  if (!provisional) return;
  // A discovery record sharing this pid is only "legitimate ownership" (as
  // opposed to a stale/corrupt discovery left behind by something else) if
  // it's actually live/attachable — checking pid equality alone would skip
  // the kill for an orphan whose discovery record happens to share a pid
  // without being verifiably that same live process.
  const discovery = readDiscovery(rosterPath);
  if (
    discovery &&
    discovery.pid === provisional.pid &&
    verifyIdentity(discovery.pid, discovery.identity)
  ) {
    removeProvisional(rosterPath);
    return;
  }
  const hasIdentity =
    provisional.identity !== null &&
    provisional.identity !== undefined &&
    provisional.identity !== "";
  const isFresh = Date.now() - provisional.since < PROVISIONAL_FRESH_WINDOW_MS;
  if (hasIdentity || isFresh) {
    killIdentifiedProcess(provisional.pid, provisional.identity);
  }
  removeProvisional(rosterPath);
}

async function spawnAndWaitReady(
  rosterPath: string,
  managedConfig: ManagedServerConfig,
  readinessBudgetMs: number,
): Promise<ServerHandle> {
  reapOrphanedProvisional(rosterPath);

  const password = randomBytes(32).toString("base64url");
  const command =
    managedConfig.command && managedConfig.command.length > 0
      ? managedConfig.command
      : ["harness", "serve"];
  const cwd = managedConfig.cwd ?? dirname(rosterPath);
  const requestedPort = managedConfig.port ?? 0;
  const logPath = logFilePath(rosterPath);

  const logFd = openSync(logPath, "w", 0o600);
  let child: ChildProcess;
  let pid: number | undefined;
  let spawnError: Error | undefined;
  try {
    child = spawn(
      command[0] as string,
      [...command.slice(1), "--port", String(requestedPort)],
      {
        cwd,
        // Lifecycle-critical: makes this child a process-group LEADER
        // (pgid == pid), so signalGroup's `process.kill(-pid, sig)` can
        // reach it and any children it spawns (e.g. the real opencode
        // server under `harness serve`'s wrapper). Do not remove.
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      },
    );
    // child_process reports spawn failures (e.g. ENOENT for a bad command)
    // asynchronously via the child's 'error' event — with no listener that
    // becomes an unhandled error in the plugin host. Capture it so it can
    // be raced against the readiness wait below instead.
    child.on("error", (err) => {
      spawnError = err;
    });
    child.unref();
    pid = child.pid;
  } finally {
    closeQuietly(logFd);
  }

  if (pid === undefined) {
    throw new Error(
      `space-bus: failed to spawn managed server (command: ${command.join(" ")}, cwd: ${cwd}, roster: ${rosterPath}, log: ${logPath})${spawnError ? `: ${spawnError.message}` : ""}`,
    );
  }

  const identity = captureIdentity(pid);
  // Write a provisional record before the readiness wait — narrows the
  // orphan window described in finding 7 (parent dies before full
  // discovery is written).
  writeProvisional(rosterPath, {
    pid,
    identity: identity ?? "",
    password,
    since: Date.now(),
  });

  let port: number;
  let baseUrl: string;
  try {
    // Race the spawn 'error' event against the readiness wait: a bad
    // command surfaces here promptly instead of only via readiness
    // timeout (or an unhandled 'error' event with no listener).
    const readiness = waitForReadiness(
      rosterPath,
      password,
      pid,
      identity,
      child,
      readinessBudgetMs,
    );
    const spawnErrorWatch = new Promise<never>((_resolve, reject) => {
      const check = setInterval(() => {
        if (spawnError) {
          clearInterval(check);
          reject(
            new Error(
              `space-bus: failed to spawn managed server (command: ${command.join(" ")}, cwd: ${cwd}, roster: ${rosterPath}, log: ${logPath}): ${spawnError.message}`,
            ),
          );
        }
      }, POLL_INTERVAL_MS);
      // .finally() re-throws readiness's rejection into a NEW promise chain
      // — attach a no-op .catch so that chain can't become an unhandled
      // rejection (the original `readiness` promise is still properly
      // awaited/handled via Promise.race below).
      readiness.finally(() => clearInterval(check)).catch(() => {});
    });
    const result = await Promise.race([readiness, spawnErrorWatch]);
    port = result.port;
    baseUrl = result.baseUrl;
  } finally {
    removeProvisional(rosterPath);
  }

  const finalIdentity = identity ?? captureIdentity(pid) ?? "";
  writeDiscovery(rosterPath, {
    port,
    pid,
    identity: finalIdentity,
    password,
    spawnConfig: { command, cwd, port: requestedPort },
    baseUrl,
  });

  return {
    baseUrl,
    credentials: { username: "opencode", password },
    pid,
    port,
  };
}

/**
 * Ensures a managed server is running for the roster and returns a handle
 * to it. Fast-paths to an existing live discovery; otherwise races for the
 * spawn lock — the winner spawns, losers poll for the discovery file until
 * `LOCK_WAIT_BUDGET_MS`. Never steals a live owner's lock. Throws on
 * externally-managed rosters (nothing to ensure).
 */
export async function ensureServer(
  rosterPath: string,
  options: EnsureServerOptions = {},
): Promise<ServerHandle> {
  const readinessBudgetMs =
    options.readinessBudgetMs ?? DEFAULT_READINESS_BUDGET_MS;
  const lockWaitBudgetMs =
    options.lockWaitBudgetMs ?? DEFAULT_LOCK_WAIT_BUDGET_MS;

  const fastPath = attachServer(rosterPath);
  if (fastPath) return fastPath;

  const manifest = readManifest(rosterPath);
  if (manifest.server.managed === undefined) {
    throw new Error(
      `space-bus: ensureServer called on an externally-managed roster (server.baseUrl) at ${rosterPath} — nothing to spawn`,
    );
  }

  const lock = acquireLock(rosterPath);
  if (lock === null) {
    return await waitForDiscoveryOrFail(rosterPath, lockWaitBudgetMs);
  }

  try {
    // Re-check under the lock: another process may have finished spawning
    // between our fast-path miss and acquiring the lock.
    const attached = attachServer(rosterPath);
    if (attached) return attached;
    return await spawnAndWaitReady(
      rosterPath,
      manifest.server.managed,
      readinessBudgetMs,
    );
  } finally {
    releaseLock(lock as LockHandle);
  }
}

/**
 * Reports whether a managed server is currently live for the roster, plus
 * whether the roster's `managed` config has drifted from the spawnConfig
 * recorded at spawn time (R5b) — surfaced, not auto-corrected.
 */
export function serverStatus(rosterPath: string): ServerStatus {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) {
    return { running: false };
  }
  if (!verifyIdentity(discovery.pid, discovery.identity)) {
    removeDiscoveryIfMatches(rosterPath, {
      pid: discovery.pid,
      identity: discovery.identity,
    });
    return { running: false };
  }

  let configDrift: boolean | undefined;
  try {
    const manifest = readManifest(rosterPath);
    if (manifest.server.managed) {
      const current = manifest.server.managed;
      const currentCommand = current.command ?? ["harness", "serve"];
      const currentCwd = current.cwd ?? dirname(rosterPath);
      const currentPort = current.port ?? 0;
      const storedCommand = discovery.spawnConfig.command ?? [
        "harness",
        "serve",
      ];
      const storedCwd = discovery.spawnConfig.cwd ?? dirname(rosterPath);
      const storedPort = discovery.spawnConfig.port ?? 0;
      configDrift =
        JSON.stringify(currentCommand) !== JSON.stringify(storedCommand) ||
        currentCwd !== storedCwd ||
        currentPort !== storedPort;
    }
  } catch {
    // Roster unreadable/invalid at status-check time — skip drift, still
    // report liveness from discovery.
  }

  return {
    running: true,
    port: discovery.port,
    pid: discovery.pid,
    configDrift,
  };
}

export async function stopServer(
  rosterPath: string,
): Promise<{ stopped: boolean }> {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) return { stopped: false };

  if (!verifyIdentity(discovery.pid, discovery.identity)) {
    // The recorded wrapper pid is gone/recycled. If the wrapper was a
    // group leader whose port-holder child survived (wrapper died alone),
    // the child would otherwise leak, orphaned and still holding the
    // port — dead-wrapper parity with the supervision died-path reap.
    await reapSurvivingGroup(discovery.pid);
    removeDiscovery(rosterPath);
    return { stopped: false };
  }

  const { pid } = discovery;

  let groupSignaled: boolean;
  // Which completion check applies depends on whether signalGroup actually
  // applied the GROUP form. If it fell back to a bare-pid signal (no group
  // to signal — ESRCH on the group form), polling group liveness
  // (`process.kill(-pid, 0)`) would throw ESRCH immediately even though the
  // bare pid may still be alive, falsely reporting death.
  const waitForCompletion = (budgetMs: number) =>
    groupSignaled
      ? waitForGroupDeath(pid, budgetMs)
      : waitForDeath(pid, budgetMs);

  try {
    groupSignaled = signalGroup(pid, "SIGTERM");
  } catch (err) {
    if (isEpermError(err)) {
      // The group EXISTS (server is ALIVE and may still hold the port) but
      // we lack permission to signal it — this is NOT a successful stop.
      // Leave the discovery file (and its credentials) intact rather than
      // discarding them for a server we never actually stopped.
      //
      // Test gap: reliably forcing a real EPERM here (e.g. signaling
      // another user's process group) needs privilege manipulation not
      // available in this test environment, and signalGroup isn't
      // separately exported/injectable for a stub. Covered by manual
      // reasoning + this comment rather than a brittle/over-engineered
      // test harness; the ESRCH ("already gone") and success paths below
      // are covered by the existing group-stop tests.
      return { stopped: false };
    }
    // signalGroup only rethrows EPERM; any other throw is unexpected here —
    // treat as already-gone (safe fallback). The genuine "already gone
    // between verify and signal" case is absorbed inside signalGroup and
    // surfaces as a dead read from waitForCompletion below, not here.
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  if (await waitForCompletion(STOP_GRACE_MS)) {
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  try {
    groupSignaled = signalGroup(pid, "SIGKILL");
  } catch (err) {
    if (isEpermError(err)) {
      return { stopped: false };
    }
    // Unexpected non-EPERM throw (see the SIGTERM branch above).
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  if (await waitForCompletion(STOP_GRACE_MS)) {
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  // Survived SIGKILL too (shouldn't happen) — leave the discovery file so
  // credentials aren't lost while the server may still be reachable.
  return { stopped: false };
}

/**
 * Best-effort reap of a surviving process group whose leader has died —
 * the died-path fix for the wrapper-only-death orphan (issue #49 Layer B
 * follow-up). Guarded so it can NEVER signal a process that recycled the
 * leader's pid:
 *
 *  - If `pid` is still alive, do nothing. Either it's still our (running)
 *    wrapper — shouldn't happen on the died path — or it's an unrelated
 *    process that recycled the pid. Never signal a live leader here.
 *  - If `pid` is dead, check group liveness (`process.kill(-pid, 0)`). If
 *    the whole group is already gone (ESRCH), it's a clean crash — no-op.
 *  - If the leader is dead but the group still has live members, so this
 *    is, in practice, still our group (a live group's pgid is not reused
 *    while any member holds it — a strong practical guard, not an absolute
 *    proof: a narrow TOCTOU remains if the whole original group exits and
 *    the pgid is recycled between this check and the signal, the same
 *    residual race stopServer's verify→signal path carries): SIGTERM the
 *    group via `signalGroupOnly` (never falls back to a bare-pid signal —
 *    the recycled bare pid could be a stranger), wait a bounded grace,
 *    escalate to SIGKILL if members survive.
 *
 * Known limitation (zombie leader): the `isAlive(pid)` guard above is
 * deliberately safe-biased — it errs toward NOT reaping. On Linux, a
 * freshly-exited-but-unreaped ZOMBIE leader still passes `isAlive`
 * (`kill(pid, 0)` succeeds for a zombie until reaped by its parent), so if
 * the died path is ever reached while our wrapper is a zombie with a
 * still-live child, the reap is skipped and the child leaks until a later
 * tick observes the pid absent. This is a narrow race — normally the
 * zombie's identity still matches, so `serverStatus` reports running and
 * the died path isn't reached at all — accepted as a known limitation
 * under the same-user trust boundary; tracked as a follow-up.
 *
 * Never throws — this runs on the fail-closed exit path and must not break
 * it (mirrors the swallow style of `stopForHung`/`removeDiscoveryIfMatches`).
 */
export async function reapSurvivingGroup(pid: number): Promise<void> {
  try {
    if (isAlive(pid)) return;

    let groupAlive: boolean;
    try {
      process.kill(-pid, 0);
      groupAlive = true;
    } catch {
      groupAlive = false;
    }
    if (!groupAlive) return;

    if (!signalGroupOnly(pid, "SIGTERM")) return;
    if (await waitForGroupDeath(pid, STOP_GRACE_MS)) return;

    signalGroupOnly(pid, "SIGKILL");
    await waitForGroupDeath(pid, STOP_GRACE_MS);
  } catch {
    // Best-effort — never throw into the died-path exit.
  }
}

export type SuperviseOutcome =
  | { reason: "signal" }
  | { reason: "died" }
  | { reason: "hung" };

export interface SuperviseServerOptions {
  /** Interval between liveness ticks. Default `SUPERVISE_INTERVAL_MS`. */
  intervalMs?: number;
  /** Consecutive `retry` probes (pid alive) before declaring the daemon
   * hung. Default `SUPERVISE_FAILURE_THRESHOLD`. */
  threshold?: number;
  /** Absolute-lifetime watchdog budget. Default
   * `SUPERVISE_UNHEALTHY_BUDGET_MS`. */
  unhealthyBudgetMs?: number;
  /** Injectable sleep, for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Injectable serverStatus, for deterministic tests. */
  status?: typeof serverStatus;
  /** Injectable probe, for deterministic tests. */
  probe?: typeof probe;
  /** Injectable stopServer, for deterministic tests. */
  stop?: typeof stopServer;
  /** Checked at the top of every tick; returning true breaks the loop with
   * `{ reason: "signal" }` before any liveness work happens on that tick. */
  shouldStop?: () => boolean;
  /** Resolves to break the inter-tick sleep immediately (e.g. wired to a
   * signal handler) instead of waiting out the full `intervalMs`. If
   * undefined, the loop just sleeps the full interval. */
  interrupt?: Promise<void>;
}

/**
 * Active supervision loop for `--foreground`: polls pid-identity liveness
 * (`serverStatus`) and an authenticated HTTP probe, and returns a
 * fail-closed outcome once death is confirmed. Never restarts the daemon
 * in-process — callers (the CLI) act on the outcome (e.g. exit non-zero
 * so an external process manager can restart `space-bus serve`).
 *
 * Liveness rules:
 * - pid gone (`serverStatus().running === false`) is immediate death — no
 *   grace period, the process is already gone. `serverStatus` itself runs
 *   Layer A compare-and-delete cleanup on this path, so no stale record
 *   remains.
 * - pid alive but the authenticated probe returns `"retry"` (unreachable/
 *   timeout/5xx) increments a failure counter; `"ready"` or
 *   `"auth-failure"` (server is up and answering — a password mismatch is
 *   config, not death) resets it to 0.
 * - Once the counter reaches `threshold` with the pid still alive, the
 *   daemon is treated as hung: `stop` (group-aware `stopServer`) is
 *   invoked to kill it and clean up the record, and the loop returns
 *   `{ reason: "hung" }`.
 *
 * Fully seam-driven (injectable `sleep`/`status`/`probe`/`stop`/
 * `shouldStop`) so it's unit-testable without real timers or a real
 * daemon; defaults to the real implementations.
 */
interface SuperviseTick {
  rosterPath: string;
  handle: ServerHandle;
  password: string;
  threshold: number;
  unhealthyBudgetMs: number;
  now: () => number;
  status: typeof serverStatus;
  probe: typeof probe;
  stop: typeof stopServer;
}

interface SuperviseLoopState {
  failures: number;
  lastReadyAt: number;
}

type SuperviseTickResult =
  | { kind: "outcome"; outcome: SuperviseOutcome }
  | ({ kind: "tick" } & SuperviseLoopState);

/** Attempts the hung-path stop once, swallowing any rejection (e.g.
 * stopServer -> removeDiscovery rethrowing a non-ENOENT error such as
 * EACCES) — a failed cleanup attempt must not reject the supervise
 * promise; the "hung" outcome is returned either way. */
async function stopForHung(
  tick: SuperviseTick,
): Promise<{ kind: "outcome"; outcome: SuperviseOutcome }> {
  try {
    await tick.stop(tick.rosterPath);
  } catch {
    // Best-effort cleanup on the hung path — see doc comment above.
  }
  return { kind: "outcome", outcome: { reason: "hung" } };
}

/** One liveness check. Returns a terminal outcome ("died"/"hung") once
 * confirmed, or the updated loop state to continue. Split out of
 * `superviseServer` to keep the loop's cognitive complexity low.
 *
 * Two independent hung triggers: the consecutive-failure counter (fast
 * path, unchanged) OR the absolute-lifetime watchdog — `lastReadyAt` only
 * advances on a genuinely-"ready" probe, so a flapping daemon (ready often
 * enough) or persistent auth-failure (never ready) is bounded even when
 * the consecutive counter never fires. */
async function superviseTick(
  tick: SuperviseTick,
  state: SuperviseLoopState,
): Promise<SuperviseTickResult> {
  const st = tick.status(tick.rosterPath);
  if (!st.running) {
    // serverStatus already ran Layer A compare-and-delete cleanup on this
    // pid-gone path — no stale record remains. Best-effort reap of a
    // surviving group (wrapper died, child orphaned) before exiting
    // fail-closed; guarded against pid recycling (see reapSurvivingGroup).
    await reapSurvivingGroup(tick.handle.pid);
    return { kind: "outcome", outcome: { reason: "died" } };
  }

  const probeOutcome = await tick.probe(tick.handle.baseUrl, tick.password);
  const failures = probeOutcome === "retry" ? state.failures + 1 : 0;
  const lastReadyAt = probeOutcome === "ready" ? tick.now() : state.lastReadyAt;

  if (failures >= tick.threshold) {
    return stopForHung(tick);
  }
  if (tick.now() - lastReadyAt >= tick.unhealthyBudgetMs) {
    return stopForHung(tick);
  }
  return { kind: "tick", failures, lastReadyAt };
}

function makeSuperviseTick(
  rosterPath: string,
  handle: ServerHandle,
  opts: SuperviseServerOptions,
): SuperviseTick {
  return {
    rosterPath,
    handle,
    // A missing/empty password yields 401 -> "auth-failure" on every
    // probe, which used to loop silently forever; the watchdog now bounds
    // that case (killed after unhealthyBudgetMs).
    password: handle.credentials.password ?? "",
    threshold: opts.threshold ?? SUPERVISE_FAILURE_THRESHOLD,
    unhealthyBudgetMs: opts.unhealthyBudgetMs ?? SUPERVISE_UNHEALTHY_BUDGET_MS,
    now: opts.now ?? Date.now,
    status: opts.status ?? serverStatus,
    probe: opts.probe ?? probe,
    stop: opts.stop ?? stopServer,
  };
}

/** Sleeps `intervalMs`, but resolves immediately if `interrupt` settles
 * first (e.g. a signal handler waking the loop) instead of waiting out the
 * full interval. */
async function interruptibleSleep(
  doSleep: (ms: number) => Promise<void>,
  intervalMs: number,
  interrupt: Promise<void> | undefined,
): Promise<void> {
  if (!interrupt) {
    await doSleep(intervalMs);
    return;
  }
  // Own the timer so it can be cancelled when the interrupt wins the race.
  // A bare setTimeout (as in `sleep`) would otherwise stay registered and
  // hold the event loop open up to intervalMs after shutdown, delaying real
  // process exit even though the logical await already resolved.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, intervalMs);
  });
  try {
    await Promise.race([timed, interrupt]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function superviseServer(
  rosterPath: string,
  handle: ServerHandle,
  opts: SuperviseServerOptions = {},
): Promise<SuperviseOutcome> {
  const intervalMs = opts.intervalMs ?? SUPERVISE_INTERVAL_MS;
  const tick = makeSuperviseTick(rosterPath, handle, opts);
  const doSleep = opts.sleep ?? sleep;
  const shouldStop = opts.shouldStop ?? (() => false);

  // The daemon was just confirmed ready by ensureServer, so start the
  // watchdog clock now rather than at epoch 0 (which would immediately
  // exceed the budget).
  let state: SuperviseLoopState = { failures: 0, lastReadyAt: tick.now() };
  for (;;) {
    if (shouldStop()) return { reason: "signal" };

    const result = await superviseTick(tick, state);
    if (result.kind === "outcome") return result.outcome;
    state = { failures: result.failures, lastReadyAt: result.lastReadyAt };

    if (shouldStop()) return { reason: "signal" };
    await interruptibleSleep(doSleep, intervalMs, opts.interrupt);
  }
}

async function waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}

/**
 * Polls for the death of an entire process GROUP (not just the recorded
 * wrapper pid) — used after a group signal to confirm the wrapper AND its
 * children are all gone, not just the wrapper. `process.kill(-pid, 0)` is
 * a liveness probe with no signal delivered: on POSIX it succeeds (no
 * throw) while ANY process in the group still exists, and throws ESRCH
 * only once the whole group is gone. Only meaningful when the prior signal
 * actually applied the group form (see signalGroup's return value) — for
 * a non-leader pid, `process.kill(-pid, 0)` throws ESRCH immediately
 * regardless of whether the bare pid is alive, which would falsely report
 * "dead". Assumes children stay in the spawned process group (true for
 * harness/opencode); a child that re-`setpgid`'s itself out of the group
 * would escape this liveness check — not handled, not expected in practice.
 */
async function waitForGroupDeath(
  pid: number,
  budgetMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  const groupAlive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (Date.now() < deadline) {
    if (!groupAlive()) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !groupAlive();
}
