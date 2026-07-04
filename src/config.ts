import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { BusContext } from "./contract";

export const manifestSchema = z.object({
  server: z.object({ baseUrl: z.string().url() }),
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
  const url = new URL(parsed.data.server.baseUrl);
  const hostname = url.hostname;
  const allowedHosts = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
  if (!allowedHosts.has(hostname)) {
    throw new Error(
      `space-bus: spacebus.json baseUrl must point to localhost (got ${hostname}) — refusing to send credentials off-machine`,
    );
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
  const manifest = getRoster(directory);
  const projects = getProjects(manifest);
  return {
    roster: { server: manifest.server, projects },
    credentials: getCredentials(),
  };
}
