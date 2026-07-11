/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 */
import type {
  DispatchResult,
  RosterProject,
  SessionResultResult,
  SessionStatusResult,
  WaitResult,
} from "./core";

export function formatRoster(projects: RosterProject[]): string {
  return projects
    .map((p) => {
      if (!p.pathExists)
        return `${p.name}: MISSING PATH (${p.path}) — ${p.description}`;
      if (p.statusError)
        return `${p.name}: status error (${p.statusError}) — ${p.description}`;
      const count = `${p.sessionCount ?? 0}${p.sessionCountCapped ? "+" : ""}`;
      return `${p.name}: ${p.busyCount ?? 0} busy / ${count} sessions — ${p.description} (${p.path})`;
    })
    .join("\n");
}

export function formatDispatch(r: DispatchResult): string {
  switch (r.mode) {
    case "new":
      return `Dispatched. Session ${r.sessionId} in ${r.project} — report this ID.`;
    case "question-reply":
      return `Replied to pending question in session ${r.sessionId} (${r.project}).`;
    case "follow-up":
      return `Follow-up prompt sent to session ${r.sessionId} (${r.project}).`;
  }
}

/** Machine-readable dispatch metadata, shared verbatim by both surfaces
 * (plugin ToolResult.metadata and MCP structuredContent) so the shapes
 * can't drift. `sessionId` and `project` are always populated on
 * DispatchResult (new sessions and both steering modes resolve a project). */
export type DispatchMetadata = {
  sessionId: string;
  project: string;
  mode: DispatchResult["mode"];
};

export function dispatchMetadata(r: DispatchResult): DispatchMetadata {
  return { sessionId: r.sessionId, project: r.project, mode: r.mode };
}

export function formatStatus(r: SessionStatusResult): string {
  const todoLines = r.todos.length
    ? r.todos
        .map((t) => `  - [${t.status}] ${t.content} (${t.priority})`)
        .join("\n")
    : "  (none)";
  const lines = [
    `session: ${r.sessionId} (${r.project})`,
    `title: ${r.title ?? "(untitled)"}`,
    `busy: ${r.busy}`,
  ];
  if (r.pendingQuestion) {
    lines.push(
      `blocked: waiting on a question — "${r.pendingQuestion.preview}"`,
    );
    if (r.pendingQuestion.options.length > 0) {
      lines.push(`  options: ${r.pendingQuestion.options.join(" | ")}`);
    }
    lines.push(`  (answer with bus_task using sessionId)`);
  }
  lines.push(
    r.diffSource === "working-tree"
      ? `diff (working tree — repo-wide, may include changes from other sessions): ${r.diff.files} files, +${r.diff.additions}/-${r.diff.deletions}`
      : `diff: ${r.diff.files} files, +${r.diff.additions}/-${r.diff.deletions}`,
    `todos:`,
    todoLines,
  );
  return lines.join("\n");
}

export function formatWait(r: WaitResult): string {
  const header = r.timedOut
    ? "timed out — no session reached a needs-attention state"
    : `woke on: ${r.waker.join(", ")}`;
  const sessionLines = r.sessions.map((s) => {
    const parts = [
      `  - ${s.sessionId} (${s.project || "(unresolved)"}): ${s.state}`,
    ];
    if (s.pendingQuestion) {
      parts.push(
        `    blocked: waiting on a question — "${s.pendingQuestion.preview}"`,
      );
      if (s.pendingQuestion.options.length > 0) {
        parts.push(`      options: ${s.pendingQuestion.options.join(" | ")}`);
      }
    }
    return parts.join("\n");
  });
  return [header, ...sessionLines].join("\n");
}

export function formatResult(r: SessionResultResult): string {
  const diffLines = r.diff.length
    ? r.diff
        .map(
          (d) =>
            `  - ${d.file ?? "(unknown)"} [${d.status ?? "?"}] +${d.additions}/-${d.deletions}`,
        )
        .join("\n")
    : "  (no changes)";
  return [
    `session: ${r.sessionId} (${r.project})`,
    `--- reply ---`,
    r.text || "(empty)",
    r.diffSource === "working-tree"
      ? `--- diff (working tree — repo-wide, may include changes from other sessions) ---`
      : `--- diff ---`,
    diffLines,
  ].join("\n");
}
