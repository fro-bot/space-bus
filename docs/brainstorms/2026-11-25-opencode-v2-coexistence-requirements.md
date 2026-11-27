---

date: 2026-11-25
topic: opencode-v2-coexistence
---

# OpenCode v1 and v2 coexistence

## Summary

Ship one Space Bus package for both controller generations. From a v2 control session or the stdio MCP connector, an operator can delegate to a v1 roster and a v2 roster side by side. The first milestone attaches to a designated, already-running local v2 service; it does not manage that service's lifecycle.

## Problem frame

The control workspace is moving to v2 before all its target projects. Loading the plugin and reaching the target are separate problems: a plugin can register successfully yet send work to the wrong service or project directory. Starting a replacement when the intended v2 service is unavailable is particularly costly: it can hide an isolation mistake and split session history.

## Actors and supported combinations

The operator selects a roster. The controller or MCP client delegates on the operator's behalf. The target service owns its sessions; a roster pointing at it does not confer ownership of its process.

| Caller                               | v1 roster                              | v2 roster, milestone 1                                                |
| ------------------------------------ | -------------------------------------- | --------------------------------------------------------------------- |
| OpenCode v1 plugin                   | Existing behavior                      | Actionable unsupported result before session creation or host startup |
| OpenCode v2 plugin                   | Existing attach-only and managed modes | Attach to the designated service                                      |
| Stdio MCP (including Claude Desktop) | Existing behavior                      | Attach to the same designated service as the plugin                   |

## Requirements

- R1. Install the same published npm artifact in supported v1 and v2 controllers and expose the existing six `bus_*` tools without a second package or a version-specific tool vocabulary. Preserve the reserved plugin loader entry and the distinct lifecycle library entry.
- R2. Existing rosters continue to denote v1 without edits. Preserve v1 managed and externally managed modes, per-call roster selection, and MCP's existing v1 spawn policy.
- R3. A roster is the migration unit: it selects one target service generation for all of its projects. A v2 controller can switch between v1 and v2 rosters without switching control sessions.
- R4. The operator selects an independently started local v2 service for the roster. Space Bus reads trusted service registration information; it does not publish, repair, or refresh that registration. Plugin and MCP must reach the same designation regardless of caller environment or transient port.
- R5. Shared v2 attachment never starts, stops, restarts, or takes ownership of the designated service. Missing service, inaccessible credentials, or a generation mismatch must yield actionable errors, not fallback or credential disclosure.
- R6. Dispatch, status, wait, and result must act on the selected roster's project and session on both supported target generations. Preserve existing tool semantics, plugin/MCP parity, local-only credential handling, and browser-safe library boundaries.
- R7. The v1 controller must refuse a v2 roster before creating a session or starting a host. Moving the daily driver back to v1 does not imply access to migrated rosters.
- R8. The operator pauses new delegations and finishes or cancels outstanding work, including work waiting for input, before switching the roster. History stays on the original host; Space Bus must refuse a reference whose association with the selected service and roster project cannot be established.

## Key flows and acceptance examples

- **AE1 — Upgrade the controller first (R1–R3, R6).** Install one packed artifact on both generations. An existing v1 roster works unchanged from v1. From one v2 control session, delegate to different projects on a v1 roster and a v2 roster, wait, and retrieve each result from its intended project. Registration alone is not a pass.
- **AE2 — Change the caller, not the target (R3–R6).** Repeat the two-roster round trip through MCP with a different ambient profile. Verify service and project identity, not merely a successful response. After the same designated v2 service restarts on another port, attachment works without editing the roster.
- **AE3 — Service absent, inaccessible, or wrong (R4–R5).** With another local service available, select an unavailable designation, or one whose registration cannot be trusted or identifies the wrong generation. Report which designation needs attention without sending credentials or work to a substitute. The CLI's lifecycle commands cannot start, stop, install, or uninstall the shared service; MCP's v1 spawn opt-in does not override this boundary.
- **AE4 — Roll back the controller (R2, R7).** A v1 controller can still delegate to a v1 roster. Selecting a v2 roster fails before any work or host is created.
- **AE5 — Cut over an idle roster (R6, R8).** Finish or cancel its v1 work, then move it to v2. In a controlled fixture, give unrelated work on both hosts the same session ID and project name. Using the old reference must not read, wait on, or send a follow-up to the v2 session. Likewise, a session outside the selected roster's projects must not become accessible merely because its ID exists on the shared service.

## Success criteria

Demonstrate the supported matrix with real loaders, the packed package, and independent local test services. Verify the six tools are discoverable and that dispatch through result reaches the intended service and project from plugin and MCP. For refused cases, verify absence of side effects. Do not use an operator's daily-driver service or shared checkout as a destructive test fixture.

## Scope boundaries

- **Milestone 2:** Space Bus-owned v2 hosts, including starting, supervising, and stopping a dedicated host. Milestone 1 must not simulate ownership of a shared service.
- No mixed-generation projects within one roster, automatic migration of active tasks or session history, v1-to-v2 delegation from a v1 controller, or expansion to off-machine targets.
- The cutover procedure is operator-coordinated, not a new distributed drain lock. The rollback example covers switching controller generations with the dual-generation package installed, not reinstalling an older Space Bus package.
- No v1 sunset date or silent reduction of the current v1 compatibility range. If evidence rules out the existing floor, bring the trade-off back to the operator.

## Key decisions and planning evidence

- Keep package compatibility separate from target selection. The plugin conversion is recorded as completed in `docs/plans/2026-07-02-001-feat-space-bus-plugin-conversion-plan.md`. This work adds a second controller and target protocol; it does not replace the six-tool contract.
- Test the installed package, not only a source import: `docs/solutions/integration-issues/opencode-plugin-reserved-subpath-loader-resolution-2026-07-11.md` documents a failure source fixtures missed. Preserve `./server` as the plugin entry and `./managed-server` as the lifecycle API.
- The [Systematic plan](https://github.com/marcusrbrown/systematic/blob/bb8daab3e1232b663a6efaaed4c669e62446d5ae/docs/plans/2026-10-27-001-feat-opencode-v2-support-plan.md) and [Copilot Delegate plan](https://github.com/marcusrbrown/opencode-copilot-delegate/blob/b8f05d1048cbe688fcb26d53396d57e581c508a0/docs/plans/2026-11-20-002-feat-opencode-v2-dual-host-plan.md) are package-loading precedents, not evidence about Space Bus service ownership or routing.
- **Verify in planning:** test the current v1 floor (`1.17.13`) and establish a tested v2 floor. Validate a discover-only service designation usable across the CLI and MCP environments. Map the target project to the v2 session location independently of plugin load location, and verify how stale task references are refused. See the [plugin migration guide](https://opencode.ai/docs/build/plugins/migrate-v1), [client guide](https://opencode.ai/docs/build/client), and [API reference](https://opencode.ai/docs/api).
- **First planning checks:** prove v2 controller → v1 roster independently of shared-v2 discovery. For v2 targets, establish what identifies the intended service before credential use and what distinguishes an old bare session ID after cutover. If either guarantee cannot be met, bring the evidence back rather than defaulting to an ambient service or treating directory equality as proof of session origin.
