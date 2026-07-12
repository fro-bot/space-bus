/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins config.ts's/discovery.ts's lane): per-user roster
 * registry — list/register/unregister/set-default/resolve-name. MUST NOT be
 * imported by core.ts, contract.ts, format.ts, or attach.ts — those stay
 * browser-safe.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { manifestSchema } from "./config";
import {
  type RegistryEntry,
  type RegistryFile,
  registryEntrySchema,
  registryFileSchema,
} from "./contract";

export type Result = { ok: true } | { ok: false; error: string };

const EMPTY_REGISTRY: RegistryFile = { version: 1, rosters: [] };

/**
 * `$XDG_CONFIG_HOME/space-bus/rosters.json`, falling back to
 * `~/.config/space-bus/rosters.json`. Config lane (durable, user-editable),
 * distinct from the daemon-owned state lane (`~/.local/state/space-bus`,
 * see discovery.ts's `stateDirFor`).
 */
export function registryPath(): string {
  const base = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
  return join(base, "space-bus", "rosters.json");
}

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

/**
 * Reads and validates the registry file. An absent file (ENOENT) is a
 * valid, empty registry (not an error) — nothing has been registered yet.
 * Every OTHER read failure (permission denied, target is a directory,
 * etc.) is reported as `ok:false` rather than silently treated as empty —
 * a masked read failure could otherwise cause a registration to appear to
 * "lose" existing entries. Unparseable JSON or a schema-invalid document
 * is likewise `ok:false` with an actionable message. After schema parse,
 * every entry's `path` must be absolute — the schema itself stays
 * platform-agnostic (just non-empty); absolute-path enforcement is a
 * Node-boundary concern. This function never throws.
 */
export function readRegistry():
  | { ok: true; registry: RegistryFile }
  | { ok: false; error: string } {
  const target = registryPath();
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: true, registry: EMPTY_REGISTRY };
    }
    return {
      ok: false,
      error: `space-bus: cannot read registry at ${target}: ${String(err)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: registry at ${target} is not valid JSON: ${String(err)}`,
    };
  }
  const parsed = registryFileSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: `space-bus: registry at ${target} failed schema validation: ${parsed.error.message}`,
    };
  }
  const nonAbsolute = parsed.data.rosters.find(
    (entry) => !isAbsolute(entry.path),
  );
  if (nonAbsolute) {
    return {
      ok: false,
      error: `space-bus: registry at ${target} contains a non-absolute path for roster "${nonAbsolute.name}": ${nonAbsolute.path}`,
    };
  }
  return { ok: true, registry: parsed.data };
}

/**
 * Atomic write: exclusive-create temp file (0600) in the same directory
 * via openSync+writeSync+closeSync (not writeFileSync, so a partial write
 * can't silently succeed against an unexpectedly-existing temp path), then
 * rename over the target. On any failure the temp file is unlinked so
 * failures don't accumulate orphan `.tmp` files. Config dir is created
 * 0700 recursive first; final file mode is 0600 (registry has no
 * credentials but stays owner-only by default, consistent with the rest
 * of the Node-only lane).
 */
function writeRegistryAtomic(data: RegistryFile): Result {
  const target = registryPath();
  const dir = join(target, "..");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to create registry dir ${dir}: ${String(err)}`,
    };
  }
  const tempPath = join(dir, `.rosters.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
    writeSync(fd, JSON.stringify(data, null, 2));
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, target);
  } catch (err) {
    if (fd !== undefined) closeQuietly(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort — nothing to clean up if the temp file was never created.
    }
    return {
      ok: false,
      error: `space-bus: failed to write registry at ${target}: ${String(err)}`,
    };
  }
  return { ok: true };
}

// --- Advisory write lock -----------------------------------------------
//
// Mirrors the spirit of discovery.ts's spawn lock: an O_EXCL-created lock
// file, bounded retry, and stale-lock breaking so a crashed holder can't
// wedge every future registry mutation forever. Simpler than the spawn
// lock (no pid-identity verification) since registry mutations are quick,
// in-process critical sections rather than long-lived daemon ownership —
// age-based staleness alone is an adequate, much simpler bar here.

function registryLockPath(): string {
  return join(registryPath(), "..", "rosters.lock");
}

const LOCK_RETRY_COUNT = 10;
const LOCK_RETRY_DELAY_MS = 50;
const LOCK_STALE_MS = 10_000;

function sleepSync(ms: number): void {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

function tryCreateRegistryLock(target: string): boolean {
  let fd: number;
  try {
    fd = openSync(
      target,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o600,
    );
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) return false;
    throw err;
  }
  try {
    writeSync(fd, String(process.pid));
  } finally {
    closeQuietly(fd);
  }
  return true;
}

function isRegistryLockStale(target: string): boolean {
  try {
    return Date.now() - statSync(target).mtimeMs > LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Acquires the advisory registry write lock, retrying up to
 * `LOCK_RETRY_COUNT` times with `LOCK_RETRY_DELAY_MS` between attempts,
 * breaking a stale lock (older than `LOCK_STALE_MS`) once encountered.
 * Returns true on success. This is a same-process, same-machine advisory
 * lock (no pid-identity verification, unlike discovery.ts's spawn lock) —
 * adequate for serializing this module's quick read-modify-write sections.
 */
/** Breaks a stale lock file if it qualifies, then retries the create once. */
function breakStaleAndRetry(target: string): boolean {
  if (!isRegistryLockStale(target)) return false;
  try {
    unlinkSync(target);
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }
  return tryCreateRegistryLock(target);
}

function acquireRegistryLock(): boolean {
  const dir = join(registryPath(), "..");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = registryLockPath();

  for (let attempt = 0; attempt <= LOCK_RETRY_COUNT; attempt++) {
    if (tryCreateRegistryLock(target)) return true;
    if (breakStaleAndRetry(target)) return true;
    if (attempt < LOCK_RETRY_COUNT) sleepSync(LOCK_RETRY_DELAY_MS);
  }
  return false;
}

function releaseRegistryLock(): void {
  try {
    unlinkSync(registryLockPath());
  } catch {
    // best-effort — never mask a primary error already in flight.
  }
}

/**
 * Runs `mutate` under the advisory registry lock. `mutate` re-reads the
 * registry itself (inside the lock) so it always sees the latest
 * on-disk state, not a snapshot taken before the lock was acquired —
 * required for the lost-update race this lock exists to close.
 */
function withRegistryLock(mutate: () => Result): Result {
  if (!acquireRegistryLock()) {
    return {
      ok: false,
      error:
        "space-bus: timed out waiting for the registry lock (another process is mutating rosters.json) — try again",
    };
  }
  try {
    return mutate();
  } finally {
    releaseRegistryLock();
  }
}

/**
 * Registers a roster under `name` -> canonicalized `rosterPath`. Validates
 * the name charset via the shared schema, enforces case-insensitive
 * uniqueness, and requires the roster file to actually exist and be a
 * valid spacebus.json — the file must BE a valid roster document to
 * register.
 *
 * TOCTOU + type hardening: opens with O_NOFOLLOW so a symlink swapped in
 * between any earlier check and the open can't be silently followed
 * (ELOOP -> "symlink" error); requires the open fd to be a regular file
 * (fstatSync); reads and validates its contents through the same manifest
 * schema roster-edit.ts uses, so a non-roster JSON file is rejected with
 * an actionable error rather than registered as garbage. The fd is closed
 * in a finally regardless of outcome. Only after all of that does it
 * realpathSync for canonical storage.
 */
function openAndValidateRosterFile(rosterPath: string): Result {
  let fd: number;
  try {
    fd = openSync(rosterPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    if (isErrnoCode(err, "ELOOP")) {
      return {
        ok: false,
        error: `space-bus: roster path ${rosterPath} is a symlink — refusing to register a symlinked roster file`,
      };
    }
    if (isEnoent(err)) {
      return {
        ok: false,
        error: `space-bus: roster path ${rosterPath} does not exist: ${String(err)}`,
      };
    }
    return {
      ok: false,
      error: `space-bus: failed to open roster path ${rosterPath}: ${String(err)}`,
    };
  }

  try {
    let stat: ReturnType<typeof fstatSync>;
    try {
      stat = fstatSync(fd);
    } catch (err) {
      return {
        ok: false,
        error: `space-bus: failed to stat roster path ${rosterPath}: ${String(err)}`,
      };
    }
    if (!stat.isFile()) {
      return {
        ok: false,
        error: `space-bus: roster path ${rosterPath} is not a regular file — refusing to register`,
      };
    }

    let raw: string;
    try {
      raw = readFileSync(fd, "utf8");
    } catch (err) {
      return {
        ok: false,
        error: `space-bus: failed to read roster path ${rosterPath}: ${String(err)}`,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        error: `space-bus: roster path ${rosterPath} is not valid JSON: ${String(err)}`,
      };
    }

    const parsed = manifestSchema.safeParse(json);
    if (!parsed.success) {
      return {
        ok: false,
        error: `space-bus: roster path ${rosterPath} is not a valid spacebus.json — refusing to register: ${parsed.error.message}`,
      };
    }
  } finally {
    closeQuietly(fd);
  }
  return { ok: true };
}

export function registerRoster(name: string, rosterPath: string): Result {
  const nameCheck = registryEntrySchema.shape.name.safeParse(name);
  if (!nameCheck.success) {
    return {
      ok: false,
      error: `space-bus: invalid roster name "${name}": ${nameCheck.error.issues[0]?.message ?? "must be 1-64 lowercase letters, digits, or hyphens"}`,
    };
  }

  const validated = openAndValidateRosterFile(rosterPath);
  if (!validated.ok) return validated;

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(rosterPath);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to canonicalize roster path ${rosterPath}: ${String(err)}`,
    };
  }

  return withRegistryLock(() => {
    const readResult = readRegistry();
    if (!readResult.ok) return readResult;
    const registry = readResult.registry;

    const collision = registry.rosters.find(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (collision) {
      return {
        ok: false,
        error: `space-bus: a roster named "${collision.name}" is already registered`,
      };
    }

    const entry: RegistryEntry = { name, path: canonicalPath };
    const next: RegistryFile = {
      ...registry,
      rosters: [...registry.rosters, entry],
    };
    return writeRegistryAtomic(next);
  });
}

/**
 * Removes the named entry (and clears the default pointer if it pointed to
 * that name). Never touches the roster file itself on disk.
 */
export function unregisterRoster(name: string): Result {
  return withRegistryLock(() => {
    const readResult = readRegistry();
    if (!readResult.ok) return readResult;
    const registry = readResult.registry;

    const exists = registry.rosters.some(
      (entry) => entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (!exists) {
      return {
        ok: false,
        error: `space-bus: no roster named "${name}" is registered`,
      };
    }

    const rosters = registry.rosters.filter(
      (entry) => entry.name.toLowerCase() !== name.toLowerCase(),
    );
    const next: RegistryFile = {
      ...registry,
      rosters,
      default:
        registry.default !== undefined &&
        registry.default.toLowerCase() === name.toLowerCase()
          ? undefined
          : registry.default,
    };
    return writeRegistryAtomic(next);
  });
}

/** Sets the default roster by name; the name must already be registered. */
export function setDefaultRoster(name: string): Result {
  return withRegistryLock(() => {
    const readResult = readRegistry();
    if (!readResult.ok) return readResult;
    const registry = readResult.registry;

    const entry = registry.rosters.find(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
    if (!entry) {
      return {
        ok: false,
        error: `space-bus: no roster named "${name}" is registered`,
      };
    }

    const next: RegistryFile = { ...registry, default: entry.name };
    return writeRegistryAtomic(next);
  });
}

/**
 * Resolves a registered roster name to its canonical path, revalidating
 * the target at resolution time rather than trusting the stored path
 * blindly: the roster file must still exist, its final path component
 * must not be a symlink, and it must be a regular file — then it is
 * realpathSync'd fresh (not just returned from storage) so a moved/
 * replaced target is caught rather than silently trusted. On a name miss,
 * the error lists all known names.
 */
export function resolveRosterByName(
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const readResult = readRegistry();
  if (!readResult.ok) return readResult;
  const registry = readResult.registry;

  const entry = registry.rosters.find(
    (r) => r.name.toLowerCase() === name.toLowerCase(),
  );
  if (!entry) {
    const known = registry.rosters.map((r) => r.name);
    return {
      ok: false,
      error:
        known.length > 0
          ? `space-bus: no roster named "${name}" is registered (known: ${known.join(", ")})`
          : `space-bus: no roster named "${name}" is registered (no rosters are registered)`,
    };
  }

  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(entry.path);
  } catch {
    return {
      ok: false,
      error: `space-bus: registered roster file no longer exists at ${entry.path} (name "${entry.name}") — was it moved or deleted?`,
    };
  }
  if (stat.isSymbolicLink()) {
    return {
      ok: false,
      error: `space-bus: registered roster path ${entry.path} (name "${entry.name}") is now a symlink — refusing to resolve a symlinked roster file`,
    };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: `space-bus: registered roster path ${entry.path} (name "${entry.name}") is no longer a regular file`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(entry.path);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to canonicalize registered roster path ${entry.path} (name "${entry.name}"): ${String(err)}`,
    };
  }

  return { ok: true, path: canonicalPath };
}
