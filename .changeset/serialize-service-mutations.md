---
"@fro.bot/space-bus": patch
---

`space-bus service install|start|stop|uninstall` now take a per-roster lock, so overlapping runs on the same roster no longer interleave their `launchctl` and plist steps. A second concurrent command fails immediately with an "operation in progress" error and changes nothing; `status` and other rosters are unaffected. If a previous command crashed and left its lock behind, the next command reclaims it; an incomplete or unreadable lock file is never removed automatically, and the error explains how to clear it.
