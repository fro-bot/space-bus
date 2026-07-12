/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * `/registry` library subpath barrel: re-exports the registry
 * (list/register/unregister/set-default/resolve-name) and roster-edit
 * (createRoster/add/remove/update project, edit server block) modules for
 * external consumers (e.g. a Mothership webview or CLI) that want the
 * mutation substrate without pulling in the tool/plugin/MCP surfaces.
 * Node-only — joins config.ts's/discovery.ts's/server.ts's lane; MUST NOT
 * be imported by core.ts, contract.ts, format.ts, or attach.ts.
 *
 * Both source modules independently declare a same-shaped `Result` type
 * (`{ ok: true } | { ok: false; error: string }`); re-exporting both under
 * one barrel would be an ambiguous-export collision, so each is re-exported
 * here under a module-qualified alias instead of colliding on `Result`.
 */
export type { Result as RegistryResult } from "./registry";
export {
  readRegistry,
  registerRoster,
  registryPath,
  resolveRosterByName,
  setDefaultRoster,
  unregisterRoster,
} from "./registry";

export type {
  CreateRosterOpts,
  ProjectPatch,
  Result as RosterEditResult,
  RosterProjectInput,
} from "./roster-edit";
export {
  addProject,
  createRoster,
  editServer,
  removeProject,
  updateProject,
} from "./roster-edit";
