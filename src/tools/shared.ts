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
  loadContextForRosterPath,
  resolveRosterPath,
} from "../config";
import type { BusContext } from "../contract";
import { formatRosterHeader } from "../format";
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

/** Injectable `ensureServer` seam — defaults to the real implementation.
 * Exists so tests can prove the registry name is resolved exactly ONCE
 * per call: a test can rebind the registry mid-call (inside this
 * function) and assert the loaded context still matches the path
 * resolved BEFORE the rebind, not a re-resolution after it. */
export async function ensureAndLoadContext(
  directory?: string,
  rosterName?: string,
  ensure: (rosterPath: string) => Promise<unknown> = ensureServer,
): Promise<ResolvedContext> {
  if (rosterName !== undefined) {
    // Resolve the name to a path ONCE — every subsequent step (managed
    // check, ensureServer, context load) uses this same resolved path,
    // never re-resolving the (mutable) registry name. Re-resolving here
    // would open a TOCTOU window: the name could be re-registered to a
    // different path between the ensureServer call and the context load.
    const resolved = resolveRosterByName(rosterName);
    if (!resolved.ok) throw new Error(resolved.error);
    const rosterPath = resolved.path;
    if (isManagedRosterAtPath(rosterPath)) {
      await ensure(rosterPath);
    }
    const context = loadContextForRosterPath(rosterPath);
    return { context, rosterName: resolved.name, rosterPath };
  }
  if (isManagedRoster(directory)) {
    const rosterPath = resolveRosterPath(directory);
    await ensure(rosterPath);
  }
  const rosterPath = resolveRosterPath(directory);
  return { context: loadContext(directory), rosterPath };
}

/**
 * Prepends the resolved-roster header to any post-resolution result text —
 * success OR error. Centralizing this closes the gap where a bare `throw
 * new Error(r.error)` (plugin adapters) or a bare `content:[{text: r.error}]`
 * (MCP handlers) would otherwise omit the header on core `ok:false` error
 * paths (Fix 1): once context resolution has succeeded, EVERY result must
 * carry the header, since the header is the split-brain/confused-deputy
 * mitigation — the caller needs to know which roster produced this error
 * just as much as which roster produced a success. Pre-resolution errors
 * (unknown roster name, missing spacebus.json, etc.) never reach this
 * helper — there's no resolved roster to report yet.
 */
export function withRosterHeader(
  source: { name?: string; path: string },
  text: string,
): string {
  return `${formatRosterHeader(source)}\n${text}`;
}
