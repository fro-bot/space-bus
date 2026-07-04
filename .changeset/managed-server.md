---
"@fro.bot/space-bus": minor
---

Managed bus server: opt-in `server.managed` roster mode spawns and supervises `harness serve` on first use (generated password, 0600 discovery handshake, persistent daemon, staleness healing). New `space-bus` CLI (serve/status/stop) and `/server` subpath. MCP attach-only unless SPACE_BUS_MCP_SPAWN. Externally-managed `baseUrl` rosters unchanged.
