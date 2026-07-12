---
"@fro.bot/space-bus": minor
---

Multi-roster substrate: roster registry + mutation library on a new `/registry` subpath.

- **Roster registry** — a per-user, machine-level registry (`$XDG_CONFIG_HOME/space-bus/rosters.json`, else `~/.config/space-bus/rosters.json`) mapping human-readable names to roster paths: `readRegistry`, `registerRoster`, `unregisterRoster`, `setDefaultRoster`, `resolveRosterByName`. Names are validated (`[a-z0-9-]`, case-insensitive-unique), paths are canonicalized with symlinked entries rejected, and the registry never stores credentials. The registry is additive and optional — `SPACE_BUS_CONFIG` and `<directory>/spacebus.json` resolution are unchanged.
- **Roster mutation** — programmatic `spacebus.json` editing: `createRoster` (write + register in one op), `addProject`, `removeProject`, `updateProject`, `editServer`. Every edit is read-validate-mutate-validate-write with atomic replacement; an invalid edit (schema violation or non-loopback `baseUrl`) leaves the file byte-identical and returns `ok:false`.
- **Discovery `rosterPath`** — managed-daemon discovery files now record their roster path at spawn (optional field; pre-field files parse unchanged), enabling future reconciliation to name which roster a running daemon belongs to.

Node-only surface (`import ... from "@fro.bot/space-bus/registry"`); the browser-safe lanes (`/core`, `/contract`, `/format`, `/attach`) are unchanged. Tool surfaces are unchanged — per-call roster addressing ships in a follow-up release.
