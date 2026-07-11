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
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  discoveryFileSchema,
  loopbackOk,
  managedSpawnConfigSchema,
} from "./contract";

// Re-exported for existing Node-side importers (config.ts, server.ts) — the
// canonical definitions now live in contract.ts (zod-only, browser-safe) so
// attach.ts (browser-safe) can share them without pulling in this module's
// node:fs/os/path/crypto/child_process imports.
export { discoveryFileSchema, managedSpawnConfigSchema };

// --- State dir resolution ---------------------------------------------------

/**
 * First 16 hex chars of sha256(roster path) — the shared per-roster
 * identity key used by both `stateDirFor` (filesystem layout) and
 * `launchd.ts`'s `serviceLabel` (launchd label/plist filename), so the two
 * stay in lockstep without duplicating the hash derivation.
 */
export function rosterKey(rosterPath: string): string {
  return createHash("sha256").update(rosterPath).digest("hex").slice(0, 16);
}

/**
 * Per-roster state directory: `$XDG_STATE_HOME|~/.local/state`/
 * `space-bus/<first 16 hex of sha256(absolute roster path)>/`. Keying by a
 * hash of the roster path keeps concurrent workspaces from colliding
 * without leaking the roster path itself into the filesystem layout.
 */
export function stateDirFor(rosterPath: string): string {
  const base =
    process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state");
  return join(base, "space-bus", rosterKey(rosterPath));
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
// Schemas moved to contract.ts (see re-export above); DiscoveryFile stays
// here for existing Node-side consumers.

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

/**
 * Compare-and-delete: re-reads the record and unlinks only if the on-disk
 * pid+identity still match the ones passed in, so a fresh record written
 * by a concurrent respawn is (practically) preserved. A vanishingly small
 * window remains between the re-read and the unlink; a respawn's atomic
 * rename landing in that window could still be removed — accepted as
 * best-effort, consistent with the discovery layer's other best-effort
 * operations, and self-heals (the orphaned daemon is reaped on the next
 * ensure).
 */
export function removeDiscoveryIfMatches(
  rosterPath: string,
  expected: { pid: number; identity: string },
): void {
  try {
    const current = readDiscovery(rosterPath);
    if (
      current &&
      current.pid === expected.pid &&
      current.identity === expected.identity
    ) {
      removeDiscovery(rosterPath);
    }
  } catch {
    // Swallows all errors — cleanup is best-effort and must never
    // propagate over the caller's dead-pid handling. (Broader than
    // removeDiscovery's ENOENT-only swallow: a stale-record cleanup
    // failure, e.g. EACCES, must not turn a not-running result into a
    // throw.)
  }
}

// --- Live endpoint attach (pure read-path, used by config.ts and server.ts) --

// Re-exported for existing Node-side importers (config.ts, server.ts) — the
// canonical definition now lives in contract.ts (zod-only, browser-safe).
export { loopbackOk };

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
  if (!verifyIdentity(discovery.pid, discovery.identity)) {
    removeDiscoveryIfMatches(rosterPath, {
      pid: discovery.pid,
      identity: discovery.identity,
    });
    return null;
  }
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
 * Best-effort within the same-user trust boundary: `lstart` is
 * second-granularity, so a pid recycled by a different process within the
 * same second and matching `comm` could in principle collide — not a
 * "never" guarantee, just a strong practical deterrent. Returns null if
 * the process cannot be inspected (e.g. already exited, or on a platform
 * without `ps`).
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
 * time/command) fails this check in practice. Best-effort, not a formal
 * guarantee: `lstart` is second-granularity, so a pid recycled within the
 * same second by a process sharing `comm` could theoretically pass. This
 * is acceptable within the documented same-user trust boundary.
 */
export function verifyIdentity(pid: number, storedIdentity: string): boolean {
  if (!isAlive(pid)) return false;
  const current = captureIdentity(pid);
  return current !== null && current === storedIdentity;
}

// --- Spawn lock ------------------------------------------------------------

export const lockFileSchema = z.object({
  // min(2), not .positive(): see discoveryFileSchema in contract.ts — a
  // pid of 0/1 must never reach a process-group signal.
  pid: z.number().int().min(2),
  startTime: z.string(),
  since: z.number(),
});

export type LockFile = z.infer<typeof lockFileSchema>;

export interface LockHandle {
  rosterPath: string;
}

/**
 * Grace window (ms) before a null/corrupt lock file is eligible for
 * reclaim. A winner of the O_EXCL race can be preempted between creating
 * the file and writing its contents, leaving a momentarily empty/unparsable
 * file that belongs to a live writer — treating that as "stale" immediately
 * would let a contender steal the lock out from under them. Only a lock
 * file older than this grace, and still null/corrupt, is reclaimed as
 * genuinely abandoned (e.g. a winner that crashed before finishing the
 * write). Dead-owner reclaim (valid, parseable lock; owner pid confirmed
 * dead) is unaffected — that stays immediate.
 */
const CORRUPT_LOCK_GRACE_MS = 2_000;

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

  // Contended — inspect the existing lock. Reclaim it if its recorded
  // owner is dead (immediate — a valid, parseable lock with a confirmed-
  // dead owner is unambiguously abandoned), or if it's corrupt/unparseable
  // AND older than CORRUPT_LOCK_GRACE_MS (a fresh null/corrupt lock may
  // belong to a live winner preempted between O_EXCL create and
  // writeFileSync — reclaiming it immediately would steal the lock out
  // from under them; only reclaim once it's old enough to be genuinely
  // abandoned).
  const existing = readLockFile(target);
  if (existing) {
    if (verifyIdentity(existing.pid, existing.startTime)) return null;
  } else if (!isOlderThan(target, CORRUPT_LOCK_GRACE_MS)) {
    return null;
  }

  try {
    unlinkSync(target);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  if (tryCreateLockFile(target, lock)) {
    return { rosterPath };
  }

  return null;
}

/**
 * True if the file's mtime is older than `ageMs`. Used to gate reclaim of
 * a null/corrupt lock file — treats a stat failure (file vanished between
 * the read and the stat, e.g. the live writer finished and released it) as
 * "not old enough to reclaim", which is safe: the caller's next
 * `tryCreateLockFile` attempt will simply succeed against the now-absent
 * file.
 */
function isOlderThan(path: string, ageMs: number): boolean {
  try {
    return Date.now() - statSync(path).mtimeMs > ageMs;
  } catch {
    return false;
  }
}

/**
 * Releases the spawn lock. Swallows ALL unlink errors (not just ENOENT) —
 * this typically runs in a `finally` after spawning/readiness work, and a
 * failure here (e.g. permissions, race with an external cleanup) must
 * never replace or mask a primary error already in flight.
 */
export function releaseLock(handle: LockHandle): void {
  try {
    unlinkSync(lockFilePath(handle.rosterPath));
  } catch {
    // best-effort — never throw over a caller's primary error.
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

export function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best-effort
  }
}

// --- Provisional spawn record (orphan mitigation) ---------------------------
//
// Written immediately after spawn+identity-capture, BEFORE the readiness
// wait — narrows (does not eliminate) the window where a parent process
// dies before the full discovery record (port/baseUrl known only after the
// child prints its readiness line) can be written, which would otherwise
// leave a detached, untracked child running with an unknown password. The
// next `ensureServer` call checks for a leftover provisional record with no
// corresponding live discovery and, if the recorded identity still
// verifies, kills and cleans up the orphan before respawning.

export function provisionalFilePath(rosterPath: string): string {
  return join(stateDirFor(rosterPath), "spawn.provisional.json");
}

export const provisionalFileSchema = z.object({
  // min(2), not .positive(): see discoveryFileSchema in contract.ts — a
  // pid of 0/1 must never reach a process-group signal.
  pid: z.number().int().min(2),
  identity: z.string(),
  password: z.string(),
  since: z.number(),
});

export type ProvisionalFile = z.infer<typeof provisionalFileSchema>;

export function writeProvisional(
  rosterPath: string,
  data: ProvisionalFile,
): void {
  const dir = stateDirFor(rosterPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const target = provisionalFilePath(rosterPath);
  const fd = openSync(
    target,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_TRUNC,
    0o600,
  );
  try {
    writeFileSync(fd, JSON.stringify(data));
  } finally {
    closeQuietly(fd);
  }
  chmodSync(target, 0o600);
}

/** Reads the provisional spawn record, or null if absent/corrupt. */
export function readProvisional(rosterPath: string): ProvisionalFile | null {
  const target = provisionalFilePath(rosterPath);
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
  const parsed = provisionalFileSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/**
 * Removes the provisional spawn record. Swallows ALL unlink errors (not
 * just ENOENT) — this runs in `spawnAndWaitReady`'s `finally`, after a
 * readiness/spawn error may already be in flight, and a cleanup failure
 * here (e.g. permissions, a race with external cleanup) must never replace
 * or mask that primary error. Mirrors `releaseLock`'s swallow-all
 * best-effort semantics.
 */
export function removeProvisional(rosterPath: string): void {
  try {
    unlinkSync(provisionalFilePath(rosterPath));
  } catch {
    // best-effort — never throw over a caller's primary error.
  }
}
