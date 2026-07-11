/**
 * Shared adapter-seam helper for the five plugin tools: for managed
 * rosters, ensure a server is running (spawns if needed, idempotent
 * attach-fast-path otherwise) before loading context; externally-managed
 * (baseUrl) rosters go straight to loadContext, unchanged from today.
 *
 * Lives outside config.ts/server.ts to keep their dependency direction
 * clean (server -> discovery <- config; adapters are the one place allowed
 * to depend on both).
 */
import { isManagedRoster, loadContext, resolveRosterPath } from "../config";
import type { BusContext } from "../contract";
import { ensureServer } from "../server";

export async function ensureAndLoadContext(
  directory?: string,
): Promise<BusContext> {
  if (isManagedRoster(directory)) {
    const rosterPath = resolveRosterPath(directory);
    await ensureServer(rosterPath);
  }
  return loadContext(directory);
}
