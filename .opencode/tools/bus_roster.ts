import { tool } from "@opencode-ai/plugin";
import { roster } from "../../src/core";
import { formatRoster } from "../../src/format";

export default tool({
  description: "List the space-bus manifest projects with live session status per project.",
  args: {},
  async execute(_args, ctx) {
    const r = await roster({ directory: ctx.directory });
    if (!r.ok) throw new Error(r.error);
    return formatRoster(r.projects);
  },
});
