import type { RosterProject, SessionResultResult, SessionStatusResult } from "./core";

export function formatRoster(projects: RosterProject[]): string {
  return projects
    .map((p) => {
      if (!p.pathExists) return `${p.name}: MISSING PATH (${p.path}) — ${p.description}`;
      if (p.statusError) return `${p.name}: status error (${p.statusError}) — ${p.description}`;
      return `${p.name}: ${p.busyCount ?? 0} busy / ${p.sessionCount ?? 0} sessions — ${p.description} (${p.path})`;
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
