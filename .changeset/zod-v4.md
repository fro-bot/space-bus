---
"@fro.bot/space-bus": minor
---

zod upgraded to v4 (^4.4.3). `/contract` schemas are now zod-4 schemas — consumers on zod 3 must upgrade; passthrough semantics unchanged (`z.looseObject`). MCP raw-shape registration now on the SDK's zod-4 path.
