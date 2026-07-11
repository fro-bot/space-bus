#!/usr/bin/env bun
/**
 * Build script: bundles src/index.ts and src/mcp.ts into dist/ as ESM,
 * targeting node (the OpenCode host and the MCP bin must both run under
 * node-compatible runtimes). External deps stay unbundled — installed
 * from package.json dependencies/peerDependencies at consume time.
 */

const pkg = await Bun.file("./package.json").json();

const result = await Bun.build({
  entrypoints: [
    "./src/index.ts",
    "./src/mcp.ts",
    "./src/cli.ts",
    "./src/config.ts",
    "./src/server.ts",
  ],
  outdir: "./dist",
  target: "node",
  format: "esm",
  external: ["@opencode-ai/plugin", "@modelcontextprotocol/sdk", "zod"],
  define: {
    __SPACE_BUS_VERSION__: JSON.stringify(pkg.version),
  },
});

if (!result.success) {
  for (const message of result.logs) {
    console.error(message);
  }
  process.exit(1);
}

// core.ts, contract.ts, format.ts, and attach.ts are the browser-safe
// subpath exports (see AGENTS.md invariants) — consumed directly by
// browser bundlers (e.g. Mothership's Vite build). They're built in their
// own browser-targeted Bun.build call, separate from the node-target
// entries above: target: "node" injects Bun's node:module createRequire
// prelude into every output in the call, which breaks Vite bundling even
// for files with no actual node:* dependency. Building them standalone
// under target: "browser" keeps that prelude out.
//
// Each of these is also built as its own entrypoint (not one shared call
// per past attach.ts-alone precedent) — bundling contract.ts alongside
// entries that import it can make Bun's chunk-splitting nest ALL outputs
// under dist/src/* instead of dist/*.js (observed empirically — Bun picks
// a shared-ancestor-dir naming scheme once enough entries share an
// intermediate chunk). That would break every other subpath export,
// which all assume a flat dist/<name>.js layout. One entrypoint per call
// keeps each file's own imports inlined (no cross-entry chunk) and leaves
// dist/ flat.
const browserSafeEntrypoints = [
  "./src/core.ts",
  "./src/contract.ts",
  "./src/format.ts",
  "./src/attach.ts",
];

const browserSafeOutputs = [];
for (const entrypoint of browserSafeEntrypoints) {
  const browserResult = await Bun.build({
    entrypoints: [entrypoint],
    outdir: "./dist",
    target: "browser",
    format: "esm",
    external: ["@opencode-ai/plugin", "@modelcontextprotocol/sdk", "zod"],
  });

  if (!browserResult.success) {
    for (const message of browserResult.logs) {
      console.error(message);
    }
    process.exit(1);
  }

  browserSafeOutputs.push(...browserResult.outputs);
}

// dist/mcp.js and dist/cli.js are the package `bin` entries — they must be
// directly executable under node with a shebang, and bun build doesn't add
// one.
const BIN_FILENAMES = ["mcp.js", "cli.js"];
for (const filename of BIN_FILENAMES) {
  const out = result.outputs.find((o) => o.path.endsWith(filename));
  if (!out) continue;
  const path = out.path;
  const contents = await Bun.file(path).text();
  if (!contents.startsWith("#!/usr/bin/env node")) {
    await Bun.write(path, `#!/usr/bin/env node\n${contents}`);
  }
}

console.log(
  `build: wrote ${result.outputs.length + browserSafeOutputs.length} file(s) to dist/`,
);
