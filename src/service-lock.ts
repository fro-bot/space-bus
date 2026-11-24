/**
 * @experimental
 * Per-roster lifecycle lock for the `space-bus service` mutating verbs
 * (install/start/stop/uninstall). Node-only lane, like `service.ts`.
 *
 * Distinct from `discovery.ts`'s daemon spawn lock (`spawn.lock`): that one
 * serializes spawning the daemon; this one (`service.lock`) serializes the
 * launchd lifecycle (print -> bootout -> plist write -> bootstrap -> verify).
 *
 * It deliberately does NOT reuse `acquireLock`/`releaseLock`:
 *  - `acquireLock` reclaims a dead owner's lock with read -> unlink -> create.
 *    Two contenders can both read the same dead lock; the slower one then
 *    unlinks the faster one's NEW, live lock. Here reclaim runs under a short
 *    mutex and re-reads the lock to confirm it is unchanged before unlinking.
 *  - `releaseLock` unlinks unconditionally. Here release only unlinks a lock
 *    whose token is still ours.
 *  - `acquireLock` records an empty start time when `ps` fails and then treats
 *    that live owner as dead, treats any `kill(pid, 0)` error (including EPERM)
 *    as "dead", keys identity on `comm` (which can change) and reclaims an
 *    unparsable lock by age. Here, an owner is dead only when its pid is
 *    provably gone (ESRCH) or provably a different process (its start time is
 *    readable and differs); anything uncertain counts as live. A malformed or
 *    incomplete lock is NEVER reclaimed automatically: age is not evidence of
 *    death (a writer paused between create and write can resume later).
 *
 * Semantics: fail-fast (never waits), cross-process (an O_EXCL file under the
 * roster's state dir), and not re-entrant (a second acquire in the same
 * process is refused like any other contender; the verbs take it exactly once).
 *
 * Limitations: same-user trust boundary only; liveness is `kill -0` plus the
 * process start time from `ps` (second granularity). A malformed lock, or a
 * `service.lock.reclaim` left by a process that crashed inside the reclaim
 * window, makes acquisition fail closed until an operator removes the file;
 * automatic cleanup of either would be racy.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const lockSchema = z.object({
  pid: z.number().int().min(2),
  /** `ps` start time of `pid` at acquire time; "" if `ps` could not read it. */
  startTime: z.string(),
  since: z.number(),
  /** Unguessable per-acquisition id: release unlinks only a lock carrying it. */
  token: z.string().min(16),
});
type LockContent = z.infer<typeof lockSchema>;

export type ServiceLock = { release: () => void };
export type AcquireResult =
  | { ok: true; lock: ServiceLock }
  | { ok: false; error: string };

export function serviceLockPath(stateDir: string): string {
  return join(stateDir, "service.lock");
}

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

/** O_EXCL create (never follows a pre-planted symlink). false => already exists. */
function createExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    if (isErrno(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Raw file text, or undefined if the file is absent. */
function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if (isErrno(err, "ENOENT")) return undefined;
    throw err;
  }
}

function parseLock(raw: string): LockContent | null {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Process start time (`ps lstart`, second granularity) or null if it cannot be
 * read. Start time only: unlike `comm` it cannot change while the process runs.
 */
export function processStartTime(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Only ESRCH proves a pid is gone; EPERM and anything else means "may exist". */
function pidMayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !isErrno(err, "ESRCH");
  }
}

/**
 * Conservative: false only when the owner's pid is gone, or the pid is now a
 * different process (start time readable and different). If we cannot tell,
 * the owner is treated as live and its lock is never reclaimed.
 */
function ownerMayBeLive(lock: LockContent): boolean {
  if (!pidMayExist(lock.pid)) return false;
  if (lock.startTime === "") return true;
  const current = processStartTime(lock.pid);
  return current === null || current === lock.startTime;
}

function busy(lockPath: string, lock: LockContent): AcquireResult {
  return {
    ok: false,
    error: `another space-bus service operation is in progress for this roster (held by pid ${lock.pid}; lock ${lockPath}) — retry when it finishes`,
  };
}

/** Fail closed: a lock we cannot attribute to a dead owner is never removed by us. */
function unattributable(lockPath: string): AcquireResult {
  return {
    ok: false,
    error: `the service lock ${lockPath} exists but is incomplete or unreadable, so its owner cannot be identified; it may belong to a command that is still starting. Do not remove it unless every space-bus service command for this roster has stopped, then delete the file and retry`,
  };
}

/** Releases only a lock that still carries our token. Never throws. */
function makeRelease(lockPath: string, token: string): () => void {
  return () => {
    try {
      const raw = readRaw(lockPath);
      if (raw !== undefined && parseLock(raw)?.token === token) {
        unlinkSync(lockPath);
      }
    } catch {
      // best-effort: never mask the verb's own result or error.
    }
  };
}

/**
 * Replaces an abandoned lock. Runs under the reclaim mutex so exactly one
 * contender reclaims, and re-reads the lock to prove it is still the very file
 * judged abandoned before unlinking it.
 */
function reclaim(
  lockPath: string,
  seenRaw: string,
  mine: string,
  token: string,
): AcquireResult {
  const mutex = `${lockPath}.reclaim`;
  if (!createExclusive(mutex, String(process.pid))) {
    return {
      ok: false,
      error: `another process is reclaiming the service lock (${mutex}). Do not remove that file unless every space-bus service command for this roster has stopped, then delete it and retry`,
    };
  }
  try {
    const nowRaw = readRaw(lockPath);
    if (nowRaw !== undefined && nowRaw !== seenRaw) {
      return contended(lockPath, nowRaw); // replaced by another acquirer
    }
    if (nowRaw !== undefined) unlinkSync(lockPath);
    if (!createExclusive(lockPath, mine)) {
      return contended(lockPath, readRaw(lockPath));
    }
    return { ok: true, lock: { release: makeRelease(lockPath, token) } };
  } finally {
    try {
      unlinkSync(mutex);
    } catch {
      // best-effort
    }
  }
}

/** Busy if the file now holds a parseable lock, otherwise fail closed. */
function contended(lockPath: string, raw: string | undefined): AcquireResult {
  const held = raw === undefined ? null : parseLock(raw);
  return held ? busy(lockPath, held) : unattributable(lockPath);
}

function tryAcquire(stateDir: string): AcquireResult {
  const lockPath = serviceLockPath(stateDir);
  const token = randomBytes(16).toString("hex");
  const mine = JSON.stringify({
    pid: process.pid,
    startTime: processStartTime(process.pid) ?? "",
    since: Date.now(),
    token,
  } satisfies LockContent);
  const won = (): AcquireResult => ({
    ok: true,
    lock: { release: makeRelease(lockPath, token) },
  });

  if (createExclusive(lockPath, mine)) return won();

  const seenRaw = readRaw(lockPath);
  if (seenRaw === undefined) {
    // Released between our create and our read: one more clean attempt.
    return createExclusive(lockPath, mine)
      ? won()
      : contended(lockPath, readRaw(lockPath));
  }
  const held = parseLock(seenRaw);
  if (held === null) return unattributable(lockPath);
  if (ownerMayBeLive(held)) return busy(lockPath, held);
  return reclaim(lockPath, seenRaw, mine, token);
}

/**
 * Takes the roster's service lock, or fails fast. `stateDir` must already
 * exist at 0700 (the caller hardens it). Never blocks, never steals a lock
 * whose owner may be live, never reclaims a malformed lock, and reports I/O
 * failures as `ok:false` rather than throwing.
 */
export function acquireServiceLock(stateDir: string): AcquireResult {
  try {
    return tryAcquire(stateDir);
  } catch (err) {
    return {
      ok: false,
      error: `failed to acquire the service lock ${serviceLockPath(stateDir)}: ${String(err)}`,
    };
  }
}
