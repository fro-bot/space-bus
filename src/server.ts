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
 * Kills a spawned child. Prefers identity-verified signaling; if identity
 * capture failed (e.g. `ps` unavailable on this platform), falls back to
 * signaling the pid directly. That direct-kill fallback is only safe when
 * the caller can vouch the pid is fresh (e.g. a child we just spawned
 * ourselves moments ago) — callers dealing with older/persisted records
 * (see reapOrphanedProvisional) must not rely on this fallback, since the
 * pid may have been recycled to an unrelated process by the time we get
 * to it.
 */
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
      if (verifyIdentity(pid, identity)) process.kill(pid, "SIGTERM");
      return;
    }
    // No identity available — best-effort direct kill. Only safe for a
    // pid the caller knows is fresh (see doc comment above).
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone — fine.
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

type ProbeOutcome = "ready" | "auth-failure" | "retry";

async function probe(baseUrl: string, password: string): Promise<ProbeOutcome> {
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
  if (!discovery || !verifyIdentity(discovery.pid, discovery.identity)) {
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

/**
 * Stops a managed server: identity-verified SIGTERM, then polls for actual
 * death (bounded by STOP_GRACE_MS) before escalating to SIGKILL and polling
 * again. The discovery file is removed ONLY once the process is confirmed
 * dead (or was never verified-live/already gone) — a process that ignores
 * both signals is reported as not stopped and the discovery file is left in
 * place, so credentials aren't silently discarded while the server still
 * holds the port. OS-authz only (R7b) — no additional permission model.
 */
export async function stopServer(
  rosterPath: string,
): Promise<{ stopped: boolean }> {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) return { stopped: false };

  if (!verifyIdentity(discovery.pid, discovery.identity)) {
    removeDiscovery(rosterPath);
    return { stopped: false };
  }

  const { pid } = discovery;

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone between verify and signal — treat as stopped.
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  if (await waitForDeath(pid, STOP_GRACE_MS)) {
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  if (await waitForDeath(pid, STOP_GRACE_MS)) {
    removeDiscovery(rosterPath);
    return { stopped: true };
  }

  // Survived SIGKILL too (shouldn't happen) — leave the discovery file so
  // credentials aren't lost while the server may still be reachable.
  return { stopped: false };
}

async function waitForDeath(pid: number, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await sleep(POLL_INTERVAL_MS);
  }
  return !isAlive(pid);
}
