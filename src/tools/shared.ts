/**
 * Shared adapter-seam helper for the five plugin tools: for managed
 * rosters, ensure a server is running (spawns if needed, idempotent
 * attach-fast-path otherwise) before loading context; externally-managed
 * (baseUrl) rosters go straight to loadContext, unchanged from today.
 *
 * Lives outside config.ts/server.ts to keep their dependency direction
 * clean (server -> discovery <- config; adapters are the one place allowed
 * to depend on both).
 *
 * Resolution precedence (R9/R10, plugin side): an explicit `roster` name
 * param wins over the surface's ambient resolution (plugin: `ctx.directory`
 * ?? defaultDirectory). When `roster` is present, this resolves via the
 * registry loader (`loadContextForRoster`) instead of directory-based
 * `loadContext` — both paths funnel through the same
 * ensure-then-load shape so managed rosters still spawn/attach correctly
 * regardless of which resolution source named them.
 */
import {
  isManagedRoster,
  isManagedRosterAtPath,
  loadContext,
  loadContextForRoster,
  resolveRosterPath,
} from "../config";
import type { BusContext } from "../contract";
import { resolveRosterByName } from "../registry";
import { ensureServer } from "../server";

/** Result of context resolution, carrying the roster name/path needed for
 * the result-echo header (formatRosterHeader in format.ts). */
export type ResolvedContext = {
  context: BusContext;
  /** Registry name, when resolution went through an explicit `roster` param. */
  rosterName?: string;
  /** The roster file path actually resolved (ambient or registry-resolved). */
  rosterPath: string;
};

export async function ensureAndLoadContext(
  directory?: string,
  rosterName?: string,
): Promise<ResolvedContext> {
  if (rosterName !== undefined) {
    // Resolve the name to a path first via the registry's revalidating
    // resolver (resolveRosterByName, reached inside loadContextForRoster's
    // error path too) — but check managed-ness on the resolved path BEFORE
    // attempting to attach, same ordering as the directory-based branch
    // below (ensureServer runs before the context load that would
    // otherwise throw "not running").
    const resolved = resolveRosterByName(rosterName);
    if (!resolved.ok) throw new Error(resolved.error);
    const rosterPath = resolved.path;
    if (isManagedRosterAtPath(rosterPath)) {
      await ensureServer(rosterPath);
    }
    const { context } = loadContextForRoster(rosterName);
    return { context, rosterName, rosterPath };
  }
  if (isManagedRoster(directory)) {
    const rosterPath = resolveRosterPath(directory);
    await ensureServer(rosterPath);
  }
  const rosterPath = resolveRosterPath(directory);
  return { context: loadContext(directory), rosterPath };
}
