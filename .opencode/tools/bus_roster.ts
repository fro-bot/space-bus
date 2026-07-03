import { tool } from "@opencode-ai/plugin";
import { roster } from "../../src/core";

export default tool({
  description: "List the space-bus manifest projects with live session status per project.",
  args: {},
  async execute() {
    const r = await roster();
    if (!r.ok) return r.error;
    return r.projects
      .map((p) => {
        if (!p.pathExists) return `${p.name}: MISSING PATH (${p.path}) — ${p.description}`;
        if (p.statusError) return `${p.name}: status error (${p.statusError}) — ${p.description}`;
        return `${p.name}: ${p.busyCount ?? 0} busy / ${p.sessionCount ?? 0} sessions — ${p.description} (${p.path})`;
      })
      .join("\n");
  },
});
