---
date: 2026-07-11
topic: multi-roster-support
---

# Multi-Roster Support — Roster Registry, In-App Mutation, Per-Call Addressing

## Summary

Make rosters first-class and plural: a machine-level registry names every roster on the machine, a shared mutation module lets any surface create rosters and edit their projects, and the bus tool surface gains per-call roster addressing with a session default. A Mothership instance (or any MCP connector) picks its active roster, edits it in-app, and can create new rosters without hand-authoring files.

---

## Problem Frame

A roster (`spacebus.json`) already multiplexes N projects over one `opencode serve` instance, and the managed lifecycle is per-roster by construction (hash-keyed state dirs, side-by-side launchd services — proven in the 0.11.0 AEs). But everything above the substrate is single-roster: the MCP facade hard-pins one roster via `SPACE_BUS_CONFIG` at process start, there is no way to enumerate the rosters that exist on a machine, and no code path anywhere writes a roster file — every roster is hand-authored. The intended daily driver is Mothership instances running over different roster sets (e.g., the fro-bot workspace board and a personal-sites board), and any MCP-capable app should be able to read and control those boards. Today that means hand-editing JSON files and restarting clients to switch boards.

Verified substrate facts that shape the work: core is already N-roster-capable (every function takes an injected per-call `BusContext`; no module state); the MCP facade is the single-pin bottleneck (`src/mcp.ts` resolves via `SPACE_BUS_CONFIG` only); the discovery file does not record its roster path, so a state-dir scan alone cannot name a running daemon's roster; Mothership currently parses `spacebus.json` with its own schema copy.

---

## Actors

- A1. Mothership instance: desktop app bound to one active roster at a time; consumes the library surface (`/core`, `/contract`, `/attach`), needs in-app roster creation and project editing.
- A2. MCP connector: Claude Desktop or any MCP-client app using `space-bus-mcp`; needs to list rosters, pick one, and task/steer across them without restart.
- A3. CLI operator: manages rosters and daemon lifecycle from the shell (`space-bus`).
- A4. OpenCode control agent: uses the plugin tools from a workspace directory; today resolves that directory's roster.

---

## Key Flows

- F1. Pick active roster
  - **Trigger:** an MCP connector (A2) starts or the user switches boards
  - **Steps:** list registered rosters → select one as the session's active roster → subsequent `bus_*` calls resolve against it; any single call may override with an explicit roster
  - **Outcome:** switching boards requires no client-config edit or restart
  - **Covered by:** R9, R10, R11

- F2. Create a roster in-app
  - **Trigger:** user starts a new board (e.g., dev-blog + personal-site projects) from Mothership (A1) or via MCP/CLI
  - **Steps:** name the roster and its workspace root folder → the mutation module writes a valid `spacebus.json` (managed server by default) and registers it → projects are added to it in-app
  - **Outcome:** a servable, registered roster exists without hand-authoring JSON
  - **Covered by:** R4, R5, R6

- F3. Reconcile registry against reality
  - **Trigger:** operator or app asks "what boards exist / what's running?"
  - **Steps:** enumerate registry entries → probe each roster's daemon state → scan state dirs for daemons the registry doesn't know
  - **Outcome:** one view of registered rosters + their liveness, plus flagged drift (unknown daemons, dangling registry entries)
  - **Covered by:** R13, R14

---

## Requirements

**Roster registry**
- R1. A per-user, machine-level registry maps a unique human-readable name to an absolute roster path; one registry per machine.
- R2. The registry is additive and optional: `SPACE_BUS_CONFIG` and `<directory>/spacebus.json` resolution keep working for unregistered rosters, unchanged.
- R3. Registry operations: register an existing roster file, unregister (never deletes the roster file), and set a machine default (R10's session-default initialization depends on it); rename is deferred.
- R4. Roster creation is a single operation: given a name, workspace root folder, and server mode, write a schema-valid `spacebus.json` and register it.

**Roster mutation**
- R5. One shared Node-only mutation module owns all roster writes: create roster, add/remove/modify project entries, edit the server block. Writes are atomic (temp + rename) and schema-validated before landing; the localhost guard applies to any `baseUrl` written.
- R6. The mutation module is exposed on three surfaces backed by the same implementation: a library subpath (Mothership's in-app editing), MCP tooling (connectors), and `space-bus roster` CLI verbs (operators/scripts).
- R7. Mutation results are discriminated unions (`ok:false` with an actionable error, never a throw across the library boundary, never a partial write).
- R8. Mothership adoption is a goal: the module (with the existing exported roster schema) must cover what Mothership needs to delete its own `spacebus.json` parsing and use space-bus as the single source of truth.

**Roster addressing (tool surfaces)**
- R9. The five `bus_*` tools gain an optional `roster` parameter (a registry name) that overrides ambient resolution on both surfaces, and every tool result names the roster the call resolved. Two-surface parity holds: plugin tools and MCP registrations stay byte-identical.
- R10. When `roster` is omitted, MCP calls resolve the session's active roster — ephemeral in-memory state per MCP server process (one per stdio connection), initialized from `SPACE_BUS_CONFIG` when set, else the registry default, reset on restart, selectable via the management tool. Plugin calls keep directory-first resolution (`ctx.directory`) when `roster` is omitted.
- R11. One new management tool (single tool, both surfaces) covers roster listing, active-roster selection, creation, registration, and project mutation — the tool surface grows by exactly one, with a narrow action enum, per-action input validation, and per-action errors.
- R12. When a named roster is not in the registry, the call fails with an actionable error listing known roster names.

**Reconciliation and lifecycle**
- R13. The discovery file records its roster path at spawn — metadata in the same 0600 file, never logged and surfaced only in reconciliation output. Reconciliation names registered rosters by hashing registry paths against state-dir keys (covers pre-field files); the recorded path names unregistered daemons, and pre-field unregistered daemons stay unknown.
- R14. A reconciliation view (library + MCP + CLI) lists registered rosters with daemon liveness plus drift flags (unknown state-dir daemons; registry entries whose roster file is gone); v1 is listing and flags only — no repair actions or richer classification.

**Security and compatibility**
- R15. The registry stores names and paths only — never credentials; paths are canonicalized on write and read with symlinked entries rejected, names are validated against a safe charset, and every roster load through the registry re-applies the existing validation (schema, localhost guard).
- R16. Space-bus never edits MCP client configs (Claude Desktop et al.); adopting a new roster in a client is the client's action.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R4.** Given a machine with one registered roster (`workspace`), when Mothership creates a roster named `personal` over `~/sites` with two projects, then `space-bus roster list` (CLI) and the MCP management tool both show `workspace` and `personal`, and `personal`'s `spacebus.json` validates against the exported schema.
- AE2. **Covers R9, R10.** Given an MCP session whose active roster is `workspace`, when the client calls `bus_roster` with `roster: "personal"`, the personal board's projects return; a following `bus_roster` with no parameter still returns the workspace board.
- AE3. **Covers R10.** Given `SPACE_BUS_CONFIG` pointing at an unregistered roster file, when the MCP starts, `bus_*` calls resolve that roster (session default) exactly as today — no registry required.
- AE4. **Covers R5, R7.** Given a roster edit that would produce an invalid file (e.g., non-loopback `baseUrl`), when the mutation is attempted from any surface, the roster file on disk is byte-identical to before and the caller receives `ok:false` naming the violation.
- AE5. **Covers R12.** Given no roster named `blog`, when a tool call passes `roster: "blog"`, the error names the known rosters (`workspace`, `personal`).
- AE6. **Covers R13, R14.** Given a daemon spawned from an unregistered roster, when reconciliation runs, the daemon is listed with its roster path (from its discovery file) and flagged unregistered; registering it by name resolves the flag.
- AE7. **Covers R9, R11.** Given the plugin tool map and MCP registrations, when descriptions are compared (existing parity test), the five `bus_*` tools plus the management tool are byte-identical across surfaces.

---

## Success Criteria

- Two Mothership instances run side-by-side over different rosters, each able to add/remove projects and create new rosters without touching JSON by hand.
- An MCP connector switches boards mid-session with one tool call — no config edit, no restart.
- A first-time Mothership user creates a working roster in-app in one flow, without encountering registry concepts.
- Mothership deletes its own `spacebus.json` parsing in favor of the space-bus module (tracked as a Mothership-side follow-on).
- Existing single-roster setups (current workspace pin, plugin directory resolution) behave identically with zero migration.

---

## Scope Boundaries

- No cross-roster aggregates: `bus_wait`/`snapshot()` operate within one roster per call; clients compose per-roster calls for multi-board views.
- No remote rosters: the localhost guard stands; a roster always describes a local server.
- No MCP client-config editing (Claude Desktop entries are user-managed).
- No Mothership UI implementation here — space-bus ships the substrate; Mothership integration is its own repo's work.
- No roster-file format migration: `spacebus.json` shape is unchanged (registry and discovery-file field are additive).
- Registry rename and reconciliation repair actions — deferred until the core flows prove out.

---

## Key Decisions

- Registry + state-dir reconciliation (over registry-only, scan-only, or client-owned lists): registry is authoritative for names; the scan catches drift — daemons from unregistered rosters and dangling entries.
- Per-call `roster` param + session default (over session-state-only, param-only, or per-roster MCP server entries): backward compatible, race-free for parallel calls, and in-app roster creation works because the client doesn't need a config edit per roster.
- Mutation exposed on all three surfaces (library + MCP + CLI) from one shared module: full parity, one implementation to review.
- Tool surface grows by exactly one management tool: bus verbs stay five; roster management does not fragment into per-verb tools.
- Registry is interop infrastructure, not the primary UX abstraction: clients surface roster selection/creation in their own UI; registry membership stays behind the scenes.
- Explicit `roster` param beats ambient resolution on both surfaces, and every result echoes the resolved roster — the split-brain mitigation for omitted-roster divergence between MCP (session default) and plugin (directory-first).

---

## Dependencies / Assumptions

- Discovery-file change (R13) is additive and versioned by the existing zod schema (`discoveryFileSchema`); old files remain readable.
- The roster schema is already exported on `/contract` — Mothership adoption (R8) builds on it rather than a new schema.
- Registry writes share the same atomic-write + same-user trust posture as the mutation module.
- Registry-name → context resolution lives in the Node-only loader lane (config); `/core` stays context-only and browser-safe.
- Mothership adoption "done" for this repo = the registry, mutation, and schema APIs cover what Mothership's local parsing does today; the migration itself is Mothership-repo work and may keep legacy parsing during transition.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] Registry file location and shape (e.g., `~/.config/space-bus/rosters.json` vs XDG-derived), and whether it needs its own lock for concurrent writers.
- [Affects R5][Technical] Concurrent-edit posture for roster files (last-writer-wins vs advisory lock) — two Mothership instances editing the same roster is legal.
- [Affects R10][Technical] Where MCP session state lives (per-process is per-connection for stdio) and how the plugin surface exposes registry-name resolution without breaking directory-first behavior.
- [Affects R11][Technical] Management tool shape: one tool with an `action` enum vs a small verb set — bounded by the grows-by-exactly-one decision.
- [Affects R5][Technical] Exact atomic-write protocol for registry and roster writes (canonicalization, symlink rejection, fsync) — reuse the plist-writer and O_NOFOLLOW learnings from the service-persistence work.
