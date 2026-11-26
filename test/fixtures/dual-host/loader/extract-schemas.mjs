// Build-time helper. verify-host-matrix.ts runs this inside the disposable
// BASELINE source copy (where the built dist/index.js and its node_modules
// exist) to turn the six real v1 tool definitions into JSON Schemas for the
// candidate entry's v2 `setup` and for the fidelity reference.
// Output: JSON on stdout, { [toolName]: { description, input } }.
//
// IMPORTANT: the args are built with the zod namespace bundled inside
// @opencode-ai/plugin (`tool.schema`). Converting them with the separately
// installed top-level `zod` silently drops every `.describe()` text, because
// descriptions live in the registry of the zod copy that created them. So the
// conversion must use `tool.schema.toJSONSchema` from that same copy.
import { pathToFileURL } from "node:url";
import { tool } from "@opencode-ai/plugin";

const entry = process.argv[2];
const { default: plugin } = await import(pathToFileURL(entry).href);
const hooks = await plugin({ directory: process.cwd() });
const z = tool.schema;

const out = {};
for (const [name, definition] of Object.entries(hooks.tool ?? {})) {
  const input = z.toJSONSchema(z.object(definition.args), { io: "input" });
  out[name] = { description: definition.description, input };
}
console.log(JSON.stringify(out));
