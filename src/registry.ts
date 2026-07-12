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
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/**
 * Reads and validates the registry file. An absent file is a valid, empty
 * registry (not an error) — nothing has been registered yet. Unparseable
 * JSON or a schema-invalid document is reported as `ok:false` with an
 * actionable message; this function never throws.
 */
export function readRegistry():
  | { ok: true; registry: RegistryFile }
  | { ok: false; error: string } {
  const target = registryPath();
  let raw: string;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return { ok: true, registry: EMPTY_REGISTRY };
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
  return { ok: true, registry: parsed.data };
}

/**
 * Atomic write: temp file in the same directory, then rename over the
 * target — a local helper rather than an extraction from launchd.ts's
 * `writePlistAtomic`, since the two writers have different mode
 * requirements (registry is 0600 owner-only vs. plist's 0644
 * launchd-readable) and extracting a one-parameter-different shared helper
 * across the launchd/registry modules would cost more coupling than the
 * ~15 lines it saves. Config dir is created 0700 recursive first; final
 * file mode is 0600 (registry has no credentials but stays owner-only by
 * default, consistent with the rest of the Node-only lane).
 */
function writeRegistryAtomic(data: RegistryFile): Result {
  const target = registryPath();
  const dir = join(target, "..");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to create registry dir ${dir}: ${String(err)}`,
    };
  }
  const tempPath = join(dir, `.rosters.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, target);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to write registry at ${target}: ${String(err)}`,
    };
  }
  return { ok: true };
}

/**
 * Registers a roster under `name` -> canonicalized `rosterPath`. Validates
 * the name charset via the shared schema, enforces case-insensitive
 * uniqueness, requires the roster file to exist (canonicalized via
 * `realpathSync`), and rejects a `rosterPath` whose final path component is
 * itself a symlink (R15 hardening — same-user trust boundary, but a
 * symlinked registry entry could be swapped out from under a caller
 * between registration and use).
 */
export function registerRoster(name: string, rosterPath: string): Result {
  const nameCheck = registryEntrySchema.shape.name.safeParse(name);
  if (!nameCheck.success) {
    return {
      ok: false,
      error: `space-bus: invalid roster name "${name}": ${nameCheck.error.issues[0]?.message ?? "must be 1-64 lowercase letters, digits, or hyphens"}`,
    };
  }

  let lstat: ReturnType<typeof lstatSync>;
  try {
    lstat = lstatSync(rosterPath);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: roster path ${rosterPath} does not exist: ${String(err)}`,
    };
  }
  if (lstat.isSymbolicLink()) {
    return {
      ok: false,
      error: `space-bus: roster path ${rosterPath} is a symlink — refusing to register a symlinked roster file`,
    };
  }

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(rosterPath);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to canonicalize roster path ${rosterPath}: ${String(err)}`,
    };
  }

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
}

/**
 * Removes the named entry (and clears the default pointer if it pointed to
 * that name). Never touches the roster file itself on disk.
 */
export function unregisterRoster(name: string): Result {
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
}

/** Sets the default roster by name; the name must already be registered. */
export function setDefaultRoster(name: string): Result {
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
}

/**
 * Resolves a registered roster name to its canonical path. On a miss, the
 * error lists all known names (groundwork for R12's actionable
 * unknown-roster errors at the addressing layer).
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
  return { ok: true, path: entry.path };
}
