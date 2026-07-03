import type { ReplyResult, RosterProject, SessionResultResult, SessionStatusResult } from "./core";

export function formatRoster(projects: RosterProject[]): string {
  return projects
    .map((p) => {
      if (!p.pathExists) return `${p.name}: MISSING PATH (${p.path}) — ${p.description}`;
      if (p.statusError) return `${p.name}: status error (${p.statusError}) — ${p.description}`;
      const count = `${p.sessionCount ?? 0}${p.sessionCountCapped ? "+" : ""}`;
      return `${p.name}: ${p.busyCount ?? 0} busy / ${count} sessions — ${p.description} (${p.path})`;
    })
    .join("\n");
}

export function formatDispatch(sessionId: string, project: string): string {
  return `Dispatched. Session ${sessionId} in ${project} — report this ID.`;
}

export function formatStatus(r: SessionStatusResult): string {
  const todoLines = r.todos.length
    ? r.todos.map((t) => `  - [${t.status}] ${t.content} (${t.priority})`).join("\n")
    : "  (none)";
  const lines = [
    `session: ${r.sessionId} (${r.project})`,
    `title: ${r.title ?? "(untitled)"}`,
    `busy: ${r.busy}`,
  ];
  if (r.pendingQuestion) {
    lines.push(`blocked: waiting on a question — "${r.pendingQuestion.preview}"`);
    if (r.pendingQuestion.options.length > 0) {
      lines.push(`  options: ${r.pendingQuestion.options.join(" | ")}`);
    }
    lines.push(`  (answer with bus_reply)`);
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

export function formatReply(r: ReplyResult): string {
  return r.mode === "question-reply"
    ? `Replied to pending question in session ${r.sessionId} (${r.project}).`
    : `Follow-up prompt sent to session ${r.sessionId} (${r.project}).`;
}

export function formatResult(r: SessionResultResult): string {
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
}
