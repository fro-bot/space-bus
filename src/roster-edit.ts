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
 */
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Manifest, manifestSchema, type ServerConfig } from "./config";
import { loopbackOk } from "./contract";
import { registerRoster } from "./registry";

export type Result = { ok: true } | { ok: false; error: string };

export interface RosterProjectInput {
  name: string;
  path: string;
  description: string;
}

export type ProjectPatch = Partial<RosterProjectInput>;

export interface CreateRosterOpts {
  name: string;
  rosterPath: string;
  /** Reserved for future use (e.g. seeding a default project); unused today — createRoster always starts from an empty projects array. */
  workspaceDir?: string;
  server?: ServerConfig;
}

// --- Internal helpers --------------------------------------------------

/** Validates a full manifest document: schema shape, then the loopback
 * guard on `baseUrl` when present (serverConfigSchema itself only enforces
 * the baseUrl-XOR-managed shape, not the hostname allowlist). */
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
 * Atomic write: temp file in the same directory, then rename over the
 * target. Mode 0644, not 0600 like registry.ts's writer — spacebus.json is
 * user-authored, human-edited config (not a credentials store; credentials
 * live in env vars / the managed discovery file), so group/world-readable
 * is the appropriate default here, mirroring the plist writer's 0644
 * rationale in launchd.ts rather than the registry's owner-only 0600.
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
  const tempPath = join(dir, `.spacebus.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2));
    renameSync(tempPath, rosterPath);
  } catch (err) {
    return {
      ok: false,
      error: `space-bus: failed to write roster at ${rosterPath}: ${String(err)}`,
    };
  }
  return { ok: true };
}

/** Read-validate-mutate-validate-write: shared by every project/server
 * edit below. `mutate` receives the currently-valid manifest and returns
 * the candidate next document; if the candidate fails re-validation, the
 * file is left byte-identical (AE4) — no write is attempted. */
function editManifest(
  rosterPath: string,
  mutate: (current: Manifest) => Manifest | Result,
): Result {
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
 * `registry.registerRoster`. Refuses to overwrite an existing file. If the
 * file write succeeds but registration fails, the file is NOT deleted —
 * the error names both facts so the caller can decide (e.g. register
 * manually with a different name).
 */
export function createRoster(opts: CreateRosterOpts): Result {
  if (existsSync(opts.rosterPath)) {
    return {
      ok: false,
      error: `space-bus: refusing to overwrite existing roster file at ${opts.rosterPath}`,
    };
  }

  const candidate: Manifest = {
    server: opts.server ?? { managed: {} },
    projects: [],
  };
  const validated = validateManifest(candidate);
  if (!validated.ok) return validated;

  const written = writeManifestAtomic(opts.rosterPath, validated.manifest);
  if (!written.ok) return written;

  const registered = registerRoster(opts.name, opts.rosterPath);
  if (!registered.ok) {
    return {
      ok: false,
      error: `space-bus: roster file was created at ${opts.rosterPath}, but registering it as "${opts.name}" failed: ${registered.error}`,
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
 * known project names. */
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
 */
export function editServer(rosterPath: string, server: ServerConfig): Result {
  return editManifest(rosterPath, (current) => ({ ...current, server }));
}
