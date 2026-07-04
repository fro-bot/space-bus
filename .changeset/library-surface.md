---
"@fro.bot/space-bus": minor
---

Library surface: subpath exports `/core`, `/config`, `/contract`, `/format` (experimental — may change in minors). Browser-safe core with injected, boundary-validated context (roster + credentials); `snapshot()` composite for one-call mission-control state. Internal behavior change: config-resolution errors now surface at the adapter boundary before core runs; tool behavior otherwise unchanged.
