/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BusContext } from "./contract";
import { LOOPBACK_HOSTS } from "./contract";
import { attachLive } from "./discovery";

export const managedServerConfigSchema = z.object({
  command: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  port: z.number().int().nonnegative().optional(),
});

export type ManagedServerConfig = z.infer<typeof managedServerConfigSchema>;

/**
 * Roster `server` block: exactly one of `baseUrl` (externally-managed,
 * today's behavior) or `managed` (plugin-spawned lifecycle) must be
 * present. Modeled as both-optional plus a superRefine (rather than a
 * z.union of strict variants) so both/neither present yields one clear,
 * actionable message instead of zod's generic union-mismatch error.
 */
export const serverConfigSchema = z
  .object({
    baseUrl: z.url().optional(),
    managed: managedServerConfigSchema.optional(),
  })
  .superRefine((val, ctx) => {
    const hasBaseUrl = val.baseUrl !== undefined;
    const hasManaged = val.managed !== undefined;
    if (hasBaseUrl && hasManaged) {
      ctx.addIssue({
        code: "custom",
        message:
          "space-bus: roster's server block must specify exactly one of `baseUrl` or `managed`, not both",
      });
    } else if (!hasBaseUrl && !hasManaged) {
      ctx.addIssue({
        code: "custom",
        message:
          "space-bus: roster's server block must specify one of `baseUrl` (externally-managed) or `managed` (plugin-spawned) — neither was present",
      });
    }
  });

export type ServerConfig = z.infer<typeof serverConfigSchema>;

export const manifestSchema = z.object({
  server: serverConfigSchema,
  projects: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      description: z.string(),
    }),
  ),
});

export type Manifest = z.infer<typeof manifestSchema>;

export function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Resolves the path to spacebus.json for a given workspace directory.
 *
 * Resolution order:
 *   1. SPACE_BUS_CONFIG env var (must be absolute or start with ~; URLs and
 *      bare-relative paths are rejected with an actionable error).
 *   2. `<directory>/spacebus.json`.
 *   3. Throws, naming both mechanisms.
 *
 * Exact-path discovery only — no upward directory walk. When the resolved
 * file exists, the path is canonicalized with realpathSync; when it's
 * missing, the un-canonicalized (but expanded/joined) path is used in the
 * error message.
 */
export function resolveRosterPath(directory?: string): string {
  const override = process.env["SPACE_BUS_CONFIG"];
  if (override) {
    if (override.includes("://")) {
      throw new Error(
        `space-bus: SPACE_BUS_CONFIG must be an absolute path or start with ~ (got a URL: ${override})`,
      );
    }
    const expanded = expandHome(override);
    if (!expanded.startsWith("/")) {
      throw new Error(
        `space-bus: SPACE_BUS_CONFIG must be an absolute path or start with ~ (got: ${override})`,
      );
    }
    return existsSync(expanded) ? realpathSync(expanded) : expanded;
  }

  if (directory) {
    const candidate = join(directory, "spacebus.json");
    return existsSync(candidate) ? realpathSync(candidate) : candidate;
  }

  throw new Error(
    "space-bus: cannot locate spacebus.json — pass a directory containing spacebus.json, or set SPACE_BUS_CONFIG to an absolute path (or ~-prefixed path) to the roster file",
  );
}

/** Reads, validates, and expands the roster for a given workspace directory. No caching — reads per call. */
export function getRoster(directory?: string): Manifest {
  const manifestPath = resolveRosterPath(directory);
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(
      `space-bus: cannot read roster at ${manifestPath}: ${(err as Error).message} (set SPACE_BUS_CONFIG or ensure spacebus.json exists in the workspace directory)`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `space-bus: roster at ${manifestPath} is not valid JSON: ${(err as Error).message}`,
    );
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `space-bus: roster at ${manifestPath} failed schema validation: ${parsed.error.message}`,
    );
  }
  if (parsed.data.server.baseUrl !== undefined) {
    const url = new URL(parsed.data.server.baseUrl);
    const hostname = url.hostname;
    if (!LOOPBACK_HOSTS.has(hostname)) {
      throw new Error(
        `space-bus: spacebus.json baseUrl must point to localhost (got ${hostname}) — refusing to send credentials off-machine`,
      );
    }
  }
  return parsed.data;
}

export type Project = Manifest["projects"][number] & {
  expandedPath: string;
  exists: boolean;
};

export function getProjects(manifest: Manifest): Project[] {
  return manifest.projects.map((p) => {
    const expandedPath = expandHome(p.path);
    return { ...p, expandedPath, exists: existsSync(expandedPath) };
  });
}

/**
 * Reads env-derived credentials for the Node path. Core never reads
 * `process.env` directly — this is the one place that boundary crosses.
 */
export function getCredentials(): { username?: string; password?: string } {
  const password = process.env["OPENCODE_SERVER_PASSWORD"];
  if (!password) return {};
  const username = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";
  return { username, password };
}

/**
 * Node-side loader producing a `BusContext` (see contract.ts) for a given
 * workspace directory: roster with `exists`-flagged projects, plus
 * env-derived credentials. Per-call/short-lived by contract — build a fresh
 * one per call, never cache across filesystem changes. Throws on
 * missing/invalid roster (same as `getRoster`); callers convert to a
 * discriminated-union Result at the core boundary.
 */
export function loadContext(directory?: string): BusContext {
  const rosterPath = resolveRosterPath(directory);
  const manifest = getRoster(directory);
  const projects = getProjects(manifest);
  if (manifest.server.baseUrl === undefined) {
    // Managed roster: attach-only, never spawn. Spawning is ensureServer()'s
    // job, called by adapters (plugin tools / MCP with opt-in) before
    // loadContext when the roster is managed.
    const live = attachLive(rosterPath);
    if (!live) {
      throw new Error(
        `space-bus: managed server not running for ${rosterPath} — call ensureServer() or run \`space-bus serve\``,
      );
    }
    return {
      roster: { server: { baseUrl: live.baseUrl }, projects },
      credentials: live.credentials,
    };
  }
  return {
    roster: { server: { baseUrl: manifest.server.baseUrl }, projects },
    credentials: getCredentials(),
  };
}

/**
 * Cheap check for whether a roster is managed (spawn-eligible) vs.
 * externally-managed (baseUrl) — reads the manifest once. Adapters use this
 * to decide whether to call `ensureServer()` before `loadContext()`.
 */
export function isManagedRoster(directory?: string): boolean {
  const manifest = getRoster(directory);
  return manifest.server.managed !== undefined;
}
