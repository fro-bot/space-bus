// V2-only observer. v2.3.2 has no HTTP route that lists tools, so this plugin
// asks the host for its own tool registry and writes a snapshot to
// $HOST_MATRIX_TOOLS_FILE (replaced atomically). It never calls the plugin
// under test. Reloads are bounded (at most 3, only while no bus_* tool is
// visible) because a reload re-runs the replayable transform callbacks, which
// is exactly the count the harness reports; the snapshot records how many it
// made so the harness can show they were zero.
import { rename, writeFile } from "node:fs/promises";

const MAX_POLLS = 120;
const POLL_MS = 500;
const RELOAD_AT = new Set([0, 8, 16]);

export default {
  id: "host-matrix-observer",
  async setup(ctx) {
    const out = process.env.HOST_MATRIX_TOOLS_FILE;
    let stopped = false;
    let reloads = 0;
    const poll = async () => {
      for (let i = 0; i < MAX_POLLS && !stopped; i++) {
        try {
          let tools = await ctx.tool.list();
          if (!tools.some((t) => t.id.startsWith("bus_")) && RELOAD_AT.has(i)) {
            reloads += 1;
            await ctx.tool.reload();
            tools = await ctx.tool.list();
          }
          const snapshot = {
            reloads,
            tools: tools.map((t) => ({
              id: t.id,
              description: t.description ?? null,
              input: t.input ?? t.parameters ?? null,
            })),
          };
          await writeFile(`${out}.tmp`, JSON.stringify(snapshot));
          await rename(`${out}.tmp`, out);
        } catch {
          /* the harness reports a missing snapshot as BLOCKED */
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    };
    void poll();
    return async () => {
      stopped = true;
    };
  },
};
