import { tool } from "@opencode-ai/plugin";
import { result } from "../../src/core";

export default tool({
  description: "Return a completed space-bus session's final assistant message and diff.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args) {
    const r = await result(args.sessionId);
    if (!r.ok) return r.error;
    const diffLines = r.diff.length
      ? r.diff.map((d) => `  - ${d.file ?? "(unknown)"} [${d.status ?? "?"}] +${d.additions}/-${d.deletions}`).join("\n")
      : "  (no changes)";
    return [
      `session: ${r.sessionId} (${r.project})`,
      `--- reply ---`,
      r.text || "(empty)",
      r.diffSource === "working-tree" ? `--- diff (working tree — repo-wide, may include changes from other sessions) ---` : `--- diff ---`,
      diffLines,
    ].join("\n");
  },
});
