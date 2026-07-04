---
"@fro.bot/space-bus": patch
---

Test isolation: the suite no longer writes managed-server state directories into the real ~/.local/state — tests now run under an isolated XDG_STATE_HOME.
