---
"@fro.bot/space-bus": minor
---

Add `space-bus service install|uninstall|status|stop|start` — generates a per-user launchd agent wrapping `serve --foreground` so a roster's managed daemon survives reboots and crashes. macOS v1 (fails fast on other platforms); restart-on-abnormal-exit with a 10s throttle; idempotent reinstall; full uninstall reversal.
