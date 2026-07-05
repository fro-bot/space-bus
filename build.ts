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
    "./src/core.ts",
    "./src/config.ts",
    "./src/contract.ts",
    "./src/format.ts",
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

// attach.ts is built in its own Bun.build call, separate from the entries
// above: bundling it alongside contract.ts (and the other entries that
// import contract.ts) makes Bun's chunk-splitting nest ALL outputs under
// dist/src/* instead of dist/*.js (observed empirically — Bun picks a
// shared-ancestor-dir naming scheme once enough entries share an
// intermediate chunk). That would break every other subpath export
// (./core, ./config, etc.), which all assume a flat dist/<name>.js layout.
// Building it standalone keeps attach.ts's own import of contract.ts
// inlined (no cross-entry chunk) and leaves the rest of dist/ flat.
const attachResult = await Bun.build({
  entrypoints: ["./src/attach.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  external: ["@opencode-ai/plugin", "@modelcontextprotocol/sdk", "zod"],
});

if (!attachResult.success) {
  for (const message of attachResult.logs) {
    console.error(message);
  }
  process.exit(1);
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
  `build: wrote ${result.outputs.length + attachResult.outputs.length} file(s) to dist/`,
);
