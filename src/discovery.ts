/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins `config.ts`'s lane): discovery-file read/write,
 * per-roster state-dir resolution, spawn lock primitives, and pid identity
 * verification for the managed-server feature. MUST NOT be imported by
 * core.ts, contract.ts, or format.ts — those stay browser-safe.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

// --- State dir resolution ---------------------------------------------------

/**
 * Per-roster state directory: `$XDG_STATE_HOME|~/.local/state`/
 * `space-bus/<first 16 hex of sha256(absolute roster path)>/`. Keying by a
 * hash of the roster path keeps concurrent workspaces from colliding
 * without leaking the roster path itself into the filesystem layout.
 */
export function stateDirFor(rosterPath: string): string {
  const base =
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  const hash = createHash("sha256")
    .update(rosterPath)
    .digest("hex")
    .slice(0, 16);
  return join(base, "space-bus", hash);
}

export function discoveryFilePath(rosterPath: string): string {
  return join(stateDirFor(rosterPath), "discovery.json");
}

export function lockFilePath(rosterPath: string): string {
  return join(stateDirFor(rosterPath), "spawn.lock");
}

export function logFilePath(rosterPath: string): string {
  return join(stateDirFor(rosterPath), "server.log");
}

// --- Discovery file ----------------------------------------------------------

export const managedSpawnConfigSchema = z.object({
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  port: z.number().int().nonnegative().optional(),
});

export const discoveryFileSchema = z.object({
  port: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  identity: z.string(),
  password: z.string(),
  spawnConfig: managedSpawnConfigSchema,
  baseUrl: z.url(),
});

export type DiscoveryFile = z.infer<typeof discoveryFileSchema>;

/**
 * Writes the discovery file atomically: a temp file (0600) in the same
 * directory, then rename over the target (rename is atomic within a
 * filesystem). The state dir itself is created 0700. Mirrors the
 * temp+rename+chmod mechanics used for copilot-delegate's port/pid files.
 */
export function writeDiscovery(rosterPath: string, data: DiscoveryFile): void {
  const dir = stateDirFor(rosterPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);

  const target = discoveryFilePath(rosterPath);
  const tempPath = `${target}.tmp.${randomBytes(8).toString("hex")}`;
  const fd = openSync(
    tempPath,
    fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(data));
  } finally {
    closeQuietly(fd);
  }
  renameSync(tempPath, target);
  chmodSync(target, 0o600);
}

/** Reads and validates the discovery file; returns null if absent or corrupt. */
export function readDiscovery(rosterPath: string): DiscoveryFile | null {
  const target = discoveryFilePath(rosterPath);
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = discoveryFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function removeDiscovery(rosterPath: string): void {
  try {
    unlinkSync(discoveryFilePath(rosterPath));
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

// --- Live endpoint attach (pure read-path, used by config.ts and server.ts) --

const ALLOWED_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function loopbackOk(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export interface LiveEndpoint {
  baseUrl: string;
  credentials: { username?: string; password?: string };
  pid: number;
  port: number;
}

/**
 * Attach-only: reads the discovery file, verifies the recorded pid is alive
 * with a matching identity, and that the discovered baseUrl passes the
 * loopback guard. Never spawns. Lives here (not server.ts) so `config.ts`
 * can attach to a managed roster without importing `server.ts` — server.ts
 * already imports config.ts (for manifestSchema), so config->server would
 * be a cycle. `config.ts` and `server.ts` both import this instead.
 */
export function attachLive(rosterPath: string): LiveEndpoint | null {
  const discovery = readDiscovery(rosterPath);
  if (!discovery) return null;
  if (!loopbackOk(discovery.baseUrl)) return null;
  if (!verifyIdentity(discovery.pid, discovery.identity)) return null;
  return {
    baseUrl: discovery.baseUrl,
    credentials: { username: "opencode", password: discovery.password },
    pid: discovery.pid,
    port: discovery.port,
  };
}

// --- PID identity --------------------------------------------------------

/**
 * Captures a locale-pinned `lstart,comm` identity string for a pid, used to
 * distinguish a live process from a recycled pid reusing the same number.
 * Returns null if the process cannot be inspected (e.g. already exited, or
 * on a platform without `ps`).
 */
export function captureIdentity(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], {
      env: { ...process.env, LC_ALL: "C" },
      encoding: "utf8",
    });
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** True if a process with the given pid currently exists (signal 0 probe). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A pid is verified only if it is BOTH alive and its captured identity
 * matches the stored one — a recycled pid (alive, different start
 * time/command) fails this check.
 */
export function verifyIdentity(pid: number, storedIdentity: string): boolean {
  if (!isAlive(pid)) return false;
  const current = captureIdentity(pid);
  return current !== null && current === storedIdentity;
}

// --- Spawn lock ------------------------------------------------------------

export const lockFileSchema = z.object({
  pid: z.number().int().positive(),
  startTime: z.string(),
  since: z.number(),
});

export type LockFile = z.infer<typeof lockFileSchema>;

export interface LockHandle {
  rosterPath: string;
}

/**
 * Acquires the per-roster spawn lock via O_EXCL create. Arbitration: a
 * lock is stale ONLY when its owner is dead (identity-checked) — age never
 * preempts a live owner. Returns a handle on success, or null if the lock
 * is currently held by a verified-live owner.
 */
export function acquireLock(rosterPath: string): LockHandle | null {
  const dir = stateDirFor(rosterPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = lockFilePath(rosterPath);

  const identity = captureIdentity(process.pid) ?? "";
  const lock: LockFile = {
    pid: process.pid,
    startTime: identity,
    since: Date.now(),
  };

  if (tryCreateLockFile(target, lock)) {
    return { rosterPath };
  }

  // Contended — inspect the existing lock. If its owner is dead, reclaim it.
  const existing = readLockFile(target);
  if (existing && !verifyIdentity(existing.pid, existing.startTime)) {
    try {
      unlinkSync(target);
    } catch (err) {
      if (!isEnoent(err)) throw err;
    }
    if (tryCreateLockFile(target, lock)) {
      return { rosterPath };
    }
  }

  return null;
}

export function releaseLock(handle: LockHandle): void {
  try {
    unlinkSync(lockFilePath(handle.rosterPath));
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
}

/** Reads the current lock holder, or null if no lock file / it's corrupt. */
export function readLockFile(target: string): LockFile | null {
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = lockFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

function tryCreateLockFile(target: string, lock: LockFile): boolean {
  let fd: number;
  try {
    fd = openSync(
      target,
      fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeFileSync(fd, JSON.stringify(lock));
  } finally {
    closeQuietly(fd);
  }
  return true;
}

// --- Helpers -----------------------------------------------------------

function isEnoent(err: unknown): boolean {
  return isErrnoCode(err, "ENOENT");
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best-effort
  }
}
