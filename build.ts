#!/usr/bin/env bun
/**
 * Build script: bundles src/index.ts and src/mcp.ts into dist/ as ESM,
 * targeting node (the OpenCode host and the MCP bin must both run under
 * node-compatible runtimes). External deps stay unbundled — installed
 * from package.json dependencies/peerDependencies at consume time.
 */

const pkg = await Bun.file("./package.json").json();

const result = await Bun.build({
  entrypoints: ["./src/index.ts", "./src/mcp.ts"],
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

// dist/mcp.js is the package `bin` entry — it must be directly executable
// under node with a shebang, and bun build doesn't add one.
const mcpOut = result.outputs.find((o) => o.path.endsWith("mcp.js"));
if (mcpOut) {
  const path = mcpOut.path;
  const contents = await Bun.file(path).text();
  if (!contents.startsWith("#!/usr/bin/env node")) {
    await Bun.write(path, `#!/usr/bin/env node\n${contents}`);
  }
}

console.log(`build: wrote ${result.outputs.length} file(s) to dist/`);
