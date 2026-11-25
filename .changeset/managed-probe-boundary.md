---
"@fro.bot/space-bus": patch
---

The managed-server readiness probe and the attach paths now check the recorded endpoint before sending any credentials. A discovery record whose `baseUrl` is not a plain `http://` loopback origin (`127.0.0.1`, `localhost` or `[::1]`, no userinfo, path or query) or whose port differs from the recorded `port` is refused, without a request, instead of being trusted. The authenticated probes no longer follow redirects. Records written by `space-bus` itself are unaffected. `probe()` gains an optional `expectedPort` argument.
