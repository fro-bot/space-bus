import { tool } from "@opencode-ai/plugin";
import { status } from "../../src/core";

export default tool({
  description: "Report a space-bus session's status plus a summary of its latest todo and diff.",
  args: {
    sessionId: tool.schema.string().describe("Session ID returned by bus_task"),
  },
  async execute(args) {
    const r = await status(args.sessionId);
    if (!r.ok) return r.error;
    const todoLines = r.todos.length
      ? r.todos.map((t) => `  - [${t.status}] ${t.content} (${t.priority})`).join("\n")
      : "  (none)";
    return [
      `session: ${r.sessionId} (${r.project})`,
      `title: ${r.title ?? "(untitled)"}`,
      `busy: ${r.busy}`,
      r.diffSource === "working-tree"
        ? `diff (working tree — repo-wide, may include changes from other sessions): ${r.diff.files} files, +${r.diff.additions}/-${r.diff.deletions}`
        : `diff: ${r.diff.files} files, +${r.diff.additions}/-${r.diff.deletions}`,
      `todos:`,
      todoLines,
    ].join("\n");
  },
});
