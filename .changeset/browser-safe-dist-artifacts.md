---
"@fro.bot/space-bus": patch
---

Fix browser-safe subpath artifacts (`./core`, `./contract`, `./format`) shipping a Node-only `createRequire`/`node:module` prelude that broke Vite/browser bundling (e.g. Mothership). These entrypoints are now built with a browser-targeted Bun.build call, matching `./attach`. Added a dist-level browser-safety test asserting the published artifacts contain no `node:` imports, closing the gap where the existing src-level browser-safety test passed while the published dist was broken.
