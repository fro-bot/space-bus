---
"@fro.bot/space-bus": minor
---

Add active supervision to `space-bus serve --foreground`. The foreground process now polls the managed daemon's liveness (process identity plus an authenticated endpoint probe with a consecutive-failure grace threshold) instead of only waiting for its own signals. On confirmed daemon death — the process is gone, it fails a run of consecutive probes, or it stays unhealthy (unreachable or auth-failing) past an absolute-lifetime budget — the supervisor cleans up the discovery record and exits non-zero so an external process manager (launchd/systemd `Restart=on-failure`) can restart `space-bus serve`. A clean SIGINT/SIGTERM interrupts the poll immediately, stops the daemon, and exits zero. Recovery-by-restart is delegated to the OS process manager; the daemon is never restarted in-process.
