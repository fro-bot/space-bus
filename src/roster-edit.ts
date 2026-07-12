/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins config.ts's/registry.ts's lane): programmatic
 * spacebus.json creation and editing — createRoster (write + register in
 * one op), add/remove/update project, edit server block. MUST NOT be
 * imported by core.ts, contract.ts, format.ts, or attach.ts — those stay
 * browser-safe.
 *
 * Validation reuse note: the file-shape schema validated here is
 * config.ts's `manifestSchema` (server: baseUrl XOR managed; projects:
 * name/path/description only) — NOT contract.ts's `rosterSchema`, which
 * models the in-memory BusContext roster (mandatory baseUrl, projects with
 * computed `expandedPath`/`exists` flags) and would reject every
 * managed-mode file and every freshly-added project. The loopback guard
 * (`loopbackOk`/`LOOPBACK_HOSTS`) IS reused verbatim from contract.ts — the
 * single source of truth also used by config.ts and discovery.ts.
 *
 * NOTE: this module's `validateManifest` additionally enforces
 * project-name uniqueness on every mutation path (create/add/update),
 * over and above config.ts's `manifestSchema` shape check — config.ts's
 * load-path schema is deliberately left unchanged so existing deployed
 * rosters (which may predate this rule) keep loading at read time; the
 * stronger check only gates writes made through this module.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { type Manifest, manifestSchema, type ServerConfig } from "./config";
import { loopbackOk } from "./contract";
import { attachLive } from "./discovery";
import { readRegistry, registerRoster } from "./registry";

export type Result =
  | { ok: true }
  | { ok: false; error: string; fileCreated?: boolean };

export interface RosterProjectInput {
  name: string;
  path: string;
  description: string;
}

export type ProjectPatch = Partial<RosterProjectInput>;

export interface CreateRosterOpts {
  name: string;
  rosterPath: string;
  server?: ServerConfig;
}

// --- Internal helpers --------------------------------------------------

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best-effort
  }
}

function isErrnoCode(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === code
  );
}

function duplicateProjectName(projects: RosterProjectInput[]): string | null {
  const seen = new Set<string>();
  for (const p of projects) {
    if (seen.has(p.name)) return p.name;
    seen.add(p.name);
  }
  return null;
}

/** Validates a full manifest document: schema shape, loopback guard on
 * `baseUrl` when present, and project-name uniqueness (mutation-path-only
 * hardening — see module doc comment). */
function validateManifest(
  data: unknown,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  const parsed = manifestSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      error: `space-bus: roster document failed schema validation: ${parsed.error.message}`,
    };
  }
  const baseUrl = parsed.data.server.baseUrl;
  if (baseUrl !== undefined && !loopbackOk(baseUrl)) {
    return {
      ok: false,
      error: `space-bus: roster's server.baseUrl must point to localhost (got ${baseUrl}) — refusing to send credentials off-machine`,
    };
  }
  const dup = duplicateProjectName(parsed.data.projects);
  if (dup !== null) {
    return {
      ok: false,
      error: `space-bus: roster document has duplicate project name "${dup}"`,
    };
  }
  return { ok: true, manifest: parsed.data };
}

/** Reads and validates the roster file at `rosterPath`. Never throws. */
function readManifest(
  rosterPath: string,
): { ok: true; manifest: Manifest } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(rosterPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: cannot read roster at ${rosterPath}: ${String(err)}`,
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: roster at ${rosterPath} is not valid JSON: ${String(err)}`,
    };
  }
  return validateManifest(json);
}

/**
 * Atomic write for an EXISTING roster (edit path): exclusive-create temp
 * file (0644 default) via openSync+writeSync+closeSync, then rename over
 * the target. Mode is preserved from the existing target file when one
 * exists (fchmodSync the temp fd before rename) — an edit must not
 * silently change a roster's permissions. On failure the temp file is
 * unlinked. Mode contract: CREATE (writeRosterExclusive below) always
 * produces 0644; EDIT (this function) preserves whatever mode the target
 * already had.
 */
function writeManifestAtomic(rosterPath: string, data: Manifest): Result {
  const dir = join(rosterPath, "..");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to create directory ${dir}: ${String(err)}`,
    };
  }

  let existingMode: number | undefined;
  try {
    existingMode = statSync(rosterPath).mode & 0o777;
  } catch {
    existingMode = undefined;
  }

  const tempPath = join(dir, `.spacebus.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      0o644,
    );
    writeSync(fd, JSON.stringify(data, null, 2));
    if (existingMode !== undefined) {
      chmodSync(tempPath, existingMode);
    }
    closeSync(fd);
    fd = undefined;
    renameSync(tempPath, rosterPath);
  } catch (err) {
    if (fd !== undefined) closeQuietly(fd);
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: `space-bus: failed to write roster at ${rosterPath}: ${String(err)}`,
    };
  }
  return { ok: true };
}

/**
 * Exclusive-create write for a NEW roster file (create path). Unlike
 * writeManifestAtomic's temp+rename (which can't itself be O_EXCL against
 * the final target — the rename would silently clobber a file created by
 * a concurrent racer), this writes DIRECTLY to `rosterPath` with
 * O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW so two concurrent createRoster calls
 * targeting the same path race safely: exactly one open succeeds, the
 * other gets EEXIST and reports failure. Mode 0644.
 */
function writeRosterExclusive(rosterPath: string, data: Manifest): Result {
  const dir = join(rosterPath, "..");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to create directory ${dir}: ${String(err)}`,
    };
  }

  let fd: number;
  try {
    fd = openSync(
      rosterPath,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    if (isErrnoCode(err, "EEXIST")) {
      return {
        ok: false,
        error: `space-bus: refusing to overwrite existing roster file at ${rosterPath}`,
      };
    }
    return {
      ok: false,
      error: `space-bus: failed to create roster file at ${rosterPath}: ${String(err)}`,
    };
  }
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
  } catch (err) {
    closeQuietly(fd);
    try {
      unlinkSync(rosterPath);
    } catch {
      // best-effort
    }
    return {
      ok: false,
      error: `space-bus: failed to write roster file at ${rosterPath}: ${String(err)}`,
    };
  }
  closeQuietly(fd);
  return { ok: true };
}

/** Read-validate-mutate-validate-write: shared by every project/server
 * edit below. `mutate` receives the currently-valid manifest and returns
 * the candidate next document; if the candidate fails re-validation, the
 * file is left byte-identical (AE4) — no write is attempted. Refuses to
 * edit a symlinked roster file (checked via lstatSync before any read) —
 * both the link and its target are left untouched. */
function editManifest(
  rosterPath: string,
  mutate: (current: Manifest) => Manifest | Result,
): Result {
  try {
    if (lstatSync(rosterPath).isSymbolicLink()) {
      return {
        ok: false,
        error: `space-bus: refusing to edit a symlinked roster file at ${rosterPath}`,
      };
    }
  } catch {
    // lstat failure (e.g. ENOENT) is handled uniformly by readManifest below.
  }

  const current = readManifest(rosterPath);
  if (!current.ok) return current;

  const mutated = mutate(current.manifest);
  if ("ok" in mutated) return mutated; // mutate short-circuited with an error

  const revalidated = validateManifest(mutated);
  if (!revalidated.ok) return revalidated;

  return writeManifestAtomic(rosterPath, revalidated.manifest);
}

// --- Public API ----------------------------------------------------------

/**
 * Writes a schema-valid spacebus.json at `rosterPath` (default server mode
 * `{ managed: {} }`; empty projects array unless `opts.server` overrides
 * the server block) and registers it under `opts.name` via
 * `registry.registerRoster`.
 *
 * Preflight (before any write): name charset validity, registry
 * readability, and no name collision — every preflight failure returns
 * `ok:false` with NO file created. The write itself is an exclusive
 * create (`writeRosterExclusive`) so two concurrent `createRoster` calls
 * targeting the same path can't silently clobber each other — exactly one
 * wins.
 *
 * If the file write succeeds but registration fails (a rare race: the
 * registry write lost a concurrent contention window or is corrupt), the
 * file is NOT deleted — the returned error names both facts and sets
 * `fileCreated: true` so a caller can recover programmatically (retrying
 * `registerRoster` directly is the recovery op).
 */
export function createRoster(opts: CreateRosterOpts): Result {
  const nameCheck = /^[a-z0-9-]{1,64}$/.test(opts.name);
  if (!nameCheck) {
    return {
      ok: false,
      error: `space-bus: invalid roster name "${opts.name}": must be 1-64 lowercase letters, digits, or hyphens`,
    };
  }

  const readResult = readRegistry();
  if (!readResult.ok) return readResult;
  const collision = readResult.registry.rosters.find(
    (entry) => entry.name.toLowerCase() === opts.name.toLowerCase(),
  );
  if (collision) {
    return {
      ok: false,
      error: `space-bus: a roster named "${collision.name}" is already registered — refusing to create "${opts.name}"`,
    };
  }

  const candidate: Manifest = {
    server: opts.server ?? { managed: {} },
    projects: [],
  };
  const validated = validateManifest(candidate);
  if (!validated.ok) return validated;

  const written = writeRosterExclusive(opts.rosterPath, validated.manifest);
  if (!written.ok) return written;

  const registered = registerRoster(opts.name, opts.rosterPath);
  if (!registered.ok) {
    return {
      ok: false,
      fileCreated: true,
      error: `space-bus: roster file was created at ${opts.rosterPath}, but registering it as "${opts.name}" failed: ${registered.error} — retry registerRoster("${opts.name}", "${opts.rosterPath}") to recover`,
    };
  }
  return { ok: true };
}

/** Adds a project. Duplicate `project.name` (exact match) is rejected. */
export function addProject(
  rosterPath: string,
  project: RosterProjectInput,
): Result {
  return editManifest(rosterPath, (current) => {
    if (current.projects.some((p) => p.name === project.name)) {
      return {
        ok: false,
        error: `space-bus: a project named "${project.name}" already exists in ${rosterPath}`,
      };
    }
    return { ...current, projects: [...current.projects, project] };
  });
}

/** Removes a project by name. Unknown name → ok:false listing known
 * project names (an empty resulting `projects` array is still valid). */
export function removeProject(rosterPath: string, projectName: string): Result {
  return editManifest(rosterPath, (current) => {
    const exists = current.projects.some((p) => p.name === projectName);
    if (!exists) {
      const known = current.projects.map((p) => p.name);
      return {
        ok: false,
        error:
          known.length > 0
            ? `space-bus: no project named "${projectName}" in ${rosterPath} (known: ${known.join(", ")})`
            : `space-bus: no project named "${projectName}" in ${rosterPath} (no projects defined)`,
      };
    }
    return {
      ...current,
      projects: current.projects.filter((p) => p.name !== projectName),
    };
  });
}

/** Patches an existing project's fields. Unknown name → ok:false listing
 * known project names. A `patch.name` that collides with another existing
 * project (exact match, mirroring addProject) is rejected without
 * mutating the file. */
export function updateProject(
  rosterPath: string,
  projectName: string,
  patch: ProjectPatch,
): Result {
  return editManifest(rosterPath, (current) => {
    const index = current.projects.findIndex((p) => p.name === projectName);
    if (index === -1) {
      const known = current.projects.map((p) => p.name);
      return {
        ok: false,
        error:
          known.length > 0
            ? `space-bus: no project named "${projectName}" in ${rosterPath} (known: ${known.join(", ")})`
            : `space-bus: no project named "${projectName}" in ${rosterPath} (no projects defined)`,
      };
    }
    if (
      patch.name !== undefined &&
      patch.name !== projectName &&
      current.projects.some((p) => p.name === patch.name)
    ) {
      return {
        ok: false,
        error: `space-bus: cannot rename project "${projectName}" to "${patch.name}" in ${rosterPath} — a project with that name already exists`,
      };
    }
    const projects = [...current.projects];
    const existing = projects[index];
    if (!existing) {
      return {
        ok: false,
        error: `space-bus: internal error locating project "${projectName}"`,
      };
    }
    projects[index] = { ...existing, ...patch };
    return { ...current, projects };
  });
}

/**
 * Replaces the roster's `server` block wholesale (`baseUrl` XOR `managed`,
 * enforced by re-validation). A non-loopback `baseUrl` is rejected and the
 * file is left byte-identical (AE4).
 *
 * Live-daemon guard: if a managed daemon is currently live for this
 * roster (per `discovery.ts`'s `attachLive`), server-block edits are
 * rejected — changing `server` out from under a running daemon would
 * leave the on-disk roster and the live discovery record pointing at
 * different worlds (split-brain). Project edits are unaffected; only
 * `editServer` carries this guard.
 */
export function editServer(rosterPath: string, server: ServerConfig): Result {
  if (attachLive(rosterPath) !== null) {
    return {
      ok: false,
      error: `space-bus: a managed daemon is running for roster ${rosterPath} — run \`space-bus stop\` first before editing its server block`,
    };
  }
  return editManifest(rosterPath, (current) => ({ ...current, server }));
}
