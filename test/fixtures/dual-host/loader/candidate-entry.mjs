// U1 loader fixture: the minimal dual entry. One default object
// { id, server, setup } (a v1 host calls server(), a v2 host calls setup()).
// It is NOT the U2 implementation: v1 delegates to the real baseline bundle
// (index-v1.js, loaded lazily so a v2-only install never needs the v1 SDK);
// v2 registers the six real names, descriptions and JSON Schemas (extracted
// from that bundle) with stub handlers.
//
// Test-only switches, both inert when their env var is unset:
//   U1_LIFECYCLE_FILE   append one JSON line per module/server/setup/
//                       transform-eval event (counters, at most 200 lines).
//   U1_MUTATE_REQUIRED  "tool.arg": flip that argument from required to
//                       optional on whichever path the host takes. This is
//                       the negative control for the schema comparison.
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const LOG = process.env.U1_LIFECYCLE_FILE;
const [mutTool, mutArg] = (process.env.U1_MUTATE_REQUIRED ?? "").split(".");
let lines = 0;

function record(ev) {
  if (!LOG || lines >= 200) return;
  lines += 1;
  try {
    appendFileSync(LOG, `${JSON.stringify({ ev })}\n`);
  } catch {
    /* evidence only */
  }
}

record("module");

export default {
  id: "space-bus",
  async server(input, options) {
    record("server");
    const { default: v1Plugin } = await import("./index-v1.js");
    const hooks = await v1Plugin(input, options);
    const arg = mutTool ? hooks?.tool?.[mutTool]?.args?.[mutArg] : undefined;
    if (arg) hooks.tool[mutTool].args[mutArg] = arg.optional();
    return hooks;
  },
  async setup(ctx) {
    record("setup");
    const specs = JSON.parse(
      await readFile(
        new URL("./candidate-schemas.json", import.meta.url),
        "utf8",
      ),
    );
    const mutated = mutTool ? specs[mutTool]?.input : undefined;
    if (mutated) {
      mutated.required = (mutated.required ?? []).filter((n) => n !== mutArg);
    }
    await ctx.tool.transform((editor) => {
      record("transform-eval");
      for (const [name, spec] of Object.entries(specs)) {
        editor.add({
          name,
          description: spec.description,
          input: spec.input,
          async execute() {
            return { content: "U1 stub: delegation is U2 scope." };
          },
        });
      }
    });
  },
};
