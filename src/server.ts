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
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type ManagedServerConfig, manifestSchema } from "./config";
import {
  acquireLock,
  captureIdentity,
  type DiscoveryFile,
  type LockHandle,
  lockFilePath,
  logFilePath,
  readDiscovery,
  readLockFile,
  releaseLock,
  removeDiscovery,
  verifyIdentity,
  writeDiscovery,
} from "./discovery";

const DEFAULT_READINESS_BUDGET_MS = 15_000;
const DEFAULT_LOCK_WAIT_BUDGET_MS = 15_000;
const POLL_INTERVAL_MS = 50;

export interface EnsureServerOptions {
  /** Bounds the readiness probe loop after spawning. Default 15s. */
  readinessBudgetMs?: number;
  /** Bounds how long a lock waiter polls for the winner's discovery file. Default 15s. */
  lockWaitBudgetMs?: number;
}

const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

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

function loopbackOk(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function toHandle(discovery: DiscoveryFile): ServerHandle {
  return {
    baseUrl: discovery.baseUrl,
    credentials: { username: "opencode", password: discovery.password },
    pid: discovery.pid,
    port: discovery.port,
  };
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

function redactedReadinessError(
  rosterPath: string,
  password: string,
  reason: string,
): Error {
  const tail = readLogTail(logFilePath(rosterPath)).replaceAll(
    password,
    "[REDACTED]",
  );
  return new Error(
    `space-bus: managed server for roster ${rosterPath} ${reason}. Log tail:\n${tail}`,
  );
}

function killIdentifiedProcess(pid: number, identity: string | null): void {
  if (identity !== null && verifyIdentity(pid, identity)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already gone — fine.
    }
  }
}

/**
 * Attach-only: reads discovery, verifies the recorded pid is alive with a
 * matching identity, and that the discovered baseUrl passes the loopback
 * guard. Never spawns.
 */
export function attachServer(rosterPath: string): ServerHandle | null {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) return null;
  if (!loopbackOk(discovery.baseUrl)) return null;
  if (!verifyIdentity(discovery.pid, discovery.identity)) return null;
  return toHandle(discovery);
}

async function waitForDiscoveryOrFail(
  rosterPath: string,
  budgetMs: number,
): Promise<ServerHandle> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const handle = attachServer(rosterPath);
    if (handle) return handle;
    await sleep(POLL_INTERVAL_MS);
  }
  const lockInfo = readLockFile(lockFilePath(rosterPath));
  const holder = lockInfo ? `pid ${lockInfo.pid}` : "an unknown holder";
  throw new Error(
    `space-bus: timed out after ${budgetMs}ms waiting for ${holder} to finish starting the managed server for roster ${rosterPath}`,
  );
}

type ProbeOutcome = "ready" | "auth-failure" | "retry";

async function probe(baseUrl: string, password: string): Promise<ProbeOutcome> {
  try {
    const res = await fetch(`${baseUrl}/session?limit=1`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
      },
    });
    if (res.status === 200) return "ready";
    if (res.status === 401 || res.status === 403) return "auth-failure";
    return "retry";
  } catch {
    return "retry";
  }
}

async function waitForReadiness(
  rosterPath: string,
  password: string,
  pid: number,
  identity: string | null,
  budgetMs: number,
): Promise<{ port: number; baseUrl: string }> {
  const deadline = Date.now() + budgetMs;
  const logPath = logFilePath(rosterPath);
  let port: number | null = null;
  let baseUrl: string | null = null;

  // Phase 1: wait for the verified stdout readiness line, extract the port.
  const readinessLine =
    /opencode server listening on (http:\/\/127\.0\.0\.1:(\d+))/;
  while (Date.now() < deadline && port === null) {
    const tail = readLogTail(logPath);
    const match = readinessLine.exec(tail);
    if (match?.[1] && match[2]) {
      baseUrl = match[1];
      port = Number(match[2]);
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (port === null || baseUrl === null) {
    killIdentifiedProcess(pid, identity);
    throw redactedReadinessError(
      rosterPath,
      password,
      `did not print a readiness line within ${budgetMs}ms`,
    );
  }

  // Phase 2: poll the authed endpoint — proves auth AND readiness at once.
  while (Date.now() < deadline) {
    const outcome = await probe(baseUrl, password);
    if (outcome === "ready") return { port, baseUrl };
    if (outcome === "auth-failure") {
      killIdentifiedProcess(pid, identity);
      throw redactedReadinessError(
        rosterPath,
        password,
        "rejected our generated password (401/403) — authentication regression, not retrying",
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }

  killIdentifiedProcess(pid, identity);
  throw redactedReadinessError(
    rosterPath,
    password,
    `did not become ready within ${budgetMs}ms`,
  );
}

async function spawnAndWaitReady(
  rosterPath: string,
  managedConfig: ManagedServerConfig,
  readinessBudgetMs: number,
): Promise<ServerHandle> {
  const password = randomBytes(32).toString("base64url");
  const command =
    managedConfig.command && managedConfig.command.length > 0
      ? managedConfig.command
      : ["harness", "serve"];
  const cwd = managedConfig.cwd ?? dirname(rosterPath);
  const requestedPort = managedConfig.port ?? 0;
  const logPath = logFilePath(rosterPath);

  const logFd = openSync(logPath, "w", 0o600);
  let pid: number | undefined;
  try {
    const child = spawn(
      command[0] as string,
      [...command.slice(1), "--port", String(requestedPort)],
      {
        cwd,
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, OPENCODE_SERVER_PASSWORD: password },
      },
    );
    child.unref();
    pid = child.pid;
  } finally {
    closeSync(logFd);
  }

  if (pid === undefined) {
    throw new Error(
      `space-bus: failed to spawn managed server (command: ${command.join(" ")}) for roster ${rosterPath}`,
    );
  }

  const identity = captureIdentity(pid);
  const { port, baseUrl } = await waitForReadiness(
    rosterPath,
    password,
    pid,
    identity,
    readinessBudgetMs,
  );

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
 * Stops a managed server: identity-verified SIGTERM, then removes the
 * discovery file regardless (cleans up a stale file even if the pid was
 * already dead). OS-authz only (R7b) — no additional permission model.
 */
export function stopServer(rosterPath: string): { stopped: boolean } {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) return { stopped: false };

  if (!verifyIdentity(discovery.pid, discovery.identity)) {
    removeDiscovery(rosterPath);
    return { stopped: false };
  }

  try {
    process.kill(discovery.pid, "SIGTERM");
  } catch {
    removeDiscovery(rosterPath);
    return { stopped: false };
  }

  removeDiscovery(rosterPath);
  return { stopped: true };
}
