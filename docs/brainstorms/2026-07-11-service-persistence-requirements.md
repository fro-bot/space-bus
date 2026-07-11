---
date: 2026-07-11
topic: service-persistence
---

# `space-bus service` — reboot-persistent managed daemon

## Summary

Add a `space-bus service install|uninstall|status|stop|start` CLI subcommand that keeps a roster's managed bus daemon alive across reboots and crashes. v1 generates and loads a per-user launchd agent on macOS wrapping the existing `serve --foreground` supervisor; the generator sits behind a platform seam so a systemd fast-follow is additive.

---

## Problem Frame

The managed daemon is spawned by the first caller and supervised only while a `serve --foreground` process runs. Nothing restarts it after a host reboot or logout: the operator workspace daemon died silently during a multi-day gap, and every consumer attached through it — including Claude Desktop's bus access — was dead until someone noticed and manually ran `serve` again. Detection was accidental (a live dogfood failed to attach). The supervision work from issue #49 fails *closed* on daemon death, and its `--foreground` exit-code contract was designed for a process manager to consume — but space-bus ships no supported way to register one, so every operator machine carries a hand-rolled persistence gap.

---

## Requirements

**Subcommand surface**

- R1. `space-bus service install [--config <path>] [--json]` generates a per-user launchd agent for the resolved roster, writes it under `~/Library/LaunchAgents/`, loads it via `launchctl`, and verifies the daemon comes up.
- R2. `space-bus service uninstall [--config <path>] [--json]` unloads the agent, removes the plist, and reports what it removed; it does not delete roster config or state-dir contents beyond the service registration.
- R3. `space-bus service status [--config <path>] [--json]` reports installed (plist present), loaded (registered with launchd), and running (daemon liveness per existing `serverStatus`), as distinct fields.
- R4. `service stop` boots out the launchd job by label (pausing supervision + daemon without removing the plist); `service start` bootstraps it back. Stop leaves the plist in place, so a subsequent login or `service start` resumes the board. This is the deliberate pause/resume path under a service — a bare `space-bus stop` is defeated by the restart policy and is not it.
- R5. All `service` verbs support `--json` with stable field names, matching the existing CLI's dual plain/JSON output convention.

**Service semantics**

- R6. The service runs `space-bus serve --foreground` for the roster, so launchd's restart policy consumes the existing exit-code contract: exit 1 (daemon died/hung) triggers restart; exit 0 (deliberate stop) does not.
- R7. One service per roster: the launchd label and plist filename derive from the same roster identity used for state-dir keying, so multiple rosters can be installed side by side without collision.
- R8. The service starts at login/boot (`RunAtLoad`) and restarts on abnormal exit; restart policy must include backoff or a throttle so a persistently-failing daemon cannot hot-loop.
- R9. `install` on an already-installed roster is idempotent: it boots out any existing job for the roster identity, refreshes the plist to current settings, and reloads — rather than erroring, duplicating, or leaving a stale job.
- R10. Service stdout/stderr route to log files under the roster's existing state directory, not to the console or a system-wide location; log files are created owner-only (0600) and preserve the daemon's existing no-credential-logging guarantee.

**Safety and security**

- R11. Installation is an explicit operator action only. Nothing in plugin load, MCP startup, or `serve` auto-installs a service.
- R12. The generated plist contains no credentials: it may reference the roster path (e.g., via `SPACE_BUS_CONFIG`) but never the discovery password or auth material.
- R13. `uninstall` fully reverses `install`: it boots out the launchd job (terminating the running supervisor and its daemon so launchd cannot restart it), then removes the plist. After uninstall — with or without a reboot — nothing space-bus-related starts automatically.
- R14. When `launchctl` operations fail, the command surfaces the failure with an actionable message and a non-zero exit; it never reports success on a partial install.
- R15. The plist is written atomically (temp-file + rename) and owner-only (not group/world-writable); `install` rewrites or refuses to load a plist that is not user-owned or is world-writable, so a tampered plist cannot become login-time code execution.

**Platform seam**

- R16. Service generation sits behind a platform-manager seam (launchd is the only v1 implementation); on unsupported platforms `service` verbs fail fast with a clear "not supported on this platform" message rather than half-working.

---

## Acceptance Examples

- AE1. **Covers R1, R3, R6.** Given the workspace roster with no service installed, when the operator runs `space-bus service install`, a plist exists under `~/Library/LaunchAgents/`, `service status` reports installed+loaded+running, and after `kill -9` of the daemon's process group the daemon is re-spawned by launchd without operator action.
- AE2. **Covers R4, R6.** Given an installed, running service, when the operator runs `service stop`, launchd boots out the job, the foreground supervisor receives SIGTERM, `superviseServer` returns `{reason:"signal"}`, and `runServe` exits 0 after a clean `stopServer` — the daemon stays down and the plist remains. A bare `space-bus stop` (which signals only the daemon's process group, not the supervisor) is **not** a deliberate stop under a service: the supervisor observes the daemon die and exits 1, so launchd restarts a fresh daemon.
- AE3. **Covers R4.** Given a roster stopped via `service stop`, when the operator runs `service start` (or logs in again), launchd bootstraps the job and the board comes back up without a reinstall.
- AE4. **Covers R2, R13.** Given an installed service, when the operator runs `service uninstall` and reboots, no space-bus process is running and no plist remains.
- AE5. **Covers R7.** Given two rosters installed side by side, when one is uninstalled, the other's service remains loaded and running.
- AE6. **Covers R9.** Given an installed service, when the operator runs `service install` again after editing the roster path or CLI version, the service is refreshed in place and `status` still reports a single loaded service.
- AE7. **Covers R14.** Given `launchctl` rejects the load (e.g., malformed domain state), `service install` exits non-zero with the launchctl error surfaced, and `service status` does not report loaded.
- AE8. **Covers R16.** Given a Linux host, when the operator runs any `service` verb, the command exits non-zero with a "not supported on this platform (v1 supports macOS/launchd)" message.

---

## Success Criteria

- The operator workspace daemon (and with it Claude Desktop's board access) survives a host reboot with zero manual action — the 4-day silent outage class is closed.
- A cold machine reaches a working board via exactly one command (`space-bus service install`).
- A downstream planner can implement from this doc without inventing product behavior: verb surface, restart semantics, per-roster identity, and safety boundaries are all pinned here.

---

## Scope Boundaries

- systemd unit generation is out of v1 — the platform seam is designed for it, but no Linux implementation ships until it can be dogfooded.
- No auto-install or bundled installation: `service install` is never a side effect of plugin load, MCP startup, or `serve`.
- No Windows support and no consideration of it in the seam design.
- No health-check/alerting layer (notifications when the daemon flaps) — launchd restart + existing `status` visibility is the v1 story.
- No changes to the existing `serve`/`stop`/`status` command semantics; the service wraps the supervisor as-is (`service stop`/`start` are new launchd-lifecycle verbs, distinct from the daemon-level `space-bus stop`).

---

## Key Decisions

- **Wrap `serve --foreground` rather than add launchd-specific supervision**: the issue #49 Layer B supervisor already exits 0/1 exactly as a process manager expects; the service layer is deployment wiring, not new lifecycle logic.
- **macOS/launchd v1 with a systemd-ready seam**: build for the OS with a real operator today; don't ship untested systemd generation that can't be dogfooded on darwin.
- **Per-roster service, not global**: matches the per-roster daemon/state-dir model; multiple boards persist independently.
- **CLI performs the `launchctl` load (with full uninstall reversal)**, not emit-a-plist-for-manual-loading: one-command restore is the point of the feature.
- **Dedicated `service stop`/`start` verbs for deliberate pause/resume** (bootout/bootstrap by label), rather than overloading the daemon-level `space-bus stop`: verified against `runServe`/`superviseServer` that a bare `space-bus stop` under a service only bounces the daemon (launchd restarts it), so pause/resume must act on the launchd job itself. Keeps `space-bus stop`'s meaning intact for non-serviced rosters.

---

## Dependencies / Assumptions

- `serve --foreground`'s exit-code contract (0 deliberate stop / 1 death-for-restart) is stable and released (0.8.x); the service layer depends on it.
- Per-roster state-dir keying exists and is stable; service identity reuses it.
- Trust boundary is same-user: `install` persists whatever roster the resolved `--config` points at, consistent with the plugin's existing same-user model and localhost guard. Hardening against attacker-controlled config paths is not a v1 goal beyond the localhost guard the daemon already enforces.
- Assumption (verify at planning): launchd's `KeepAlive`/`SuccessfulExit` semantics map to the exit-code contract as expected, and per-user agents run at login on modern macOS without extra privileges.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Technical] How the plist invokes the CLI: pinned version vs floating (bunx/npx at service start), or an absolute path to an installed bin — including how the service behaves across space-bus version bumps.
- [Affects R7][Needs research] The right launchd throttle/backoff configuration (`ThrottleInterval`, `KeepAlive` sub-keys) to satisfy "no hot-loop" without delaying legitimate restarts.
- [Affects R3][Technical] How `service status` queries launchd (`launchctl print` parsing vs simpler presence checks) without fragile output scraping.
