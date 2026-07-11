import { describe, expect, test } from "bun:test";
import type { WaitResult } from "./core";
import {
  formatDispatch,
  formatResult,
  formatRoster,
  formatStatus,
  formatWait,
} from "./format";

describe("formatRoster", () => {
  test("normal project with busy/session counts", () => {
    const out = formatRoster([
      {
        name: "dashboard",
        path: "/home/x/dashboard",
        description: "The dashboard app",
        pathExists: true,
        busyCount: 2,
        sessionCount: 5,
        sessionCountCapped: false,
      },
    ]);
    expect(out).toBe(
      "dashboard: 2 busy / 5 sessions — The dashboard app (/home/x/dashboard)",
    );
  });

  test("sessionCountCapped renders 100+ label", () => {
    const out = formatRoster([
      {
        name: "agent",
        path: "/home/x/agent",
        description: "Agent svc",
        pathExists: true,
        busyCount: 0,
        sessionCount: 100,
        sessionCountCapped: true,
      },
    ]);
    expect(out).toBe(
      "agent: 0 busy / 100+ sessions — Agent svc (/home/x/agent)",
    );
  });

  test("missing path renders MISSING PATH", () => {
    const out = formatRoster([
      {
        name: "gone",
        path: "/nowhere",
        description: "Gone project",
        pathExists: false,
      },
    ]);
    expect(out).toBe("gone: MISSING PATH (/nowhere) — Gone project");
  });

  test("statusError renders status error line", () => {
    const out = formatRoster([
      {
        name: "flaky",
        path: "/home/x/flaky",
        description: "Flaky svc",
        pathExists: true,
        statusError: "status=500/200",
      },
    ]);
    expect(out).toBe("flaky: status error (status=500/200) — Flaky svc");
  });

  test("multiple projects joined by newline", () => {
    const out = formatRoster([
      {
        name: "a",
        path: "/a",
        description: "A",
        pathExists: true,
        busyCount: 0,
        sessionCount: 0,
        sessionCountCapped: false,
      },
      {
        name: "b",
        path: "/b",
        description: "B",
        pathExists: false,
      },
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});

describe("formatDispatch", () => {
  test("mode new", () => {
    const out = formatDispatch({
      sessionId: "ses_123",
      project: "dashboard",
      mode: "new",
      directory: "/home/x/dashboard",
    });
    expect(out).toBe(
      "Dispatched. Session ses_123 in dashboard — report this ID.",
    );
  });

  test("mode question-reply", () => {
    const out = formatDispatch({
      sessionId: "ses_456",
      project: "agent",
      mode: "question-reply",
    });
    expect(out).toBe("Replied to pending question in session ses_456 (agent).");
  });

  test("mode follow-up", () => {
    const out = formatDispatch({
      sessionId: "ses_789",
      project: "infra",
      mode: "follow-up",
    });
    expect(out).toBe("Follow-up prompt sent to session ses_789 (infra).");
  });
});

describe("formatStatus", () => {
  test("busy session, no title, no todos, no diff, no question", () => {
    const out = formatStatus({
      sessionId: "ses_1",
      project: "dashboard",
      busy: true,
      todos: [],
      diff: { files: 0, additions: 0, deletions: 0 },
      diffSource: "session",
      state: "running",
      resultAvailable: false,
    });
    expect(out).toBe(
      [
        "session: ses_1 (dashboard)",
        "title: (untitled)",
        "busy: true",
        "diff: 0 files, +0/-0",
        "todos:",
        "  (none)",
      ].join("\n"),
    );
  });

  test("idle session with title and diff", () => {
    const out = formatStatus({
      sessionId: "ses_2",
      project: "agent",
      busy: false,
      title: "Fix bug",
      todos: [],
      diff: { files: 3, additions: 10, deletions: 4 },
      diffSource: "session",
      state: "complete",
      resultAvailable: true,
    });
    expect(out).toContain("title: Fix bug");
    expect(out).toContain("busy: false");
    expect(out).toContain("diff: 3 files, +10/-4");
  });

  test("with todos renders each line", () => {
    const out = formatStatus({
      sessionId: "ses_3",
      project: "infra",
      busy: false,
      todos: [
        { content: "Write tests", status: "pending", priority: "high" },
        { content: "Ship it", status: "in_progress", priority: "medium" },
      ],
      diff: { files: 0, additions: 0, deletions: 0 },
      diffSource: "session",
      state: "complete",
      resultAvailable: true,
    });
    expect(out).toContain("  - [pending] Write tests (high)");
    expect(out).toContain("  - [in_progress] Ship it (medium)");
  });

  test("working-tree diffSource uses repo-wide label", () => {
    const out = formatStatus({
      sessionId: "ses_4",
      project: "dashboard",
      busy: false,
      todos: [],
      diff: { files: 1, additions: 2, deletions: 1 },
      diffSource: "working-tree",
      state: "complete",
      resultAvailable: true,
    });
    expect(out).toContain(
      "diff (working tree — repo-wide, may include changes from other sessions): 1 files, +2/-1",
    );
  });

  test("pendingQuestion adds blocked line, options, and hint", () => {
    const out = formatStatus({
      sessionId: "ses_5",
      project: "dashboard",
      busy: true,
      todos: [],
      diff: { files: 0, additions: 0, deletions: 0 },
      diffSource: "session",
      pendingQuestion: {
        preview: "Should I proceed?",
        options: ["Yes", "No"],
      },
      state: "blocked",
      resultAvailable: false,
    });
    const lines = out.split("\n");
    expect(lines).toContain(
      'blocked: waiting on a question — "Should I proceed?"',
    );
    expect(lines).toContain("  options: Yes | No");
    expect(lines).toContain("  (answer with bus_task using sessionId)");
  });

  test("pendingQuestion with no options omits the options line", () => {
    const out = formatStatus({
      sessionId: "ses_6",
      project: "dashboard",
      busy: true,
      todos: [],
      diff: { files: 0, additions: 0, deletions: 0 },
      diffSource: "session",
      pendingQuestion: { preview: "Continue?", options: [] },
      state: "blocked",
      resultAvailable: false,
    });
    expect(out).not.toContain("  options:");
    expect(out).toContain("  (answer with bus_task using sessionId)");
  });
});

describe("formatResult", () => {
  test("reply text with diff entries", () => {
    const out = formatResult({
      sessionId: "ses_1",
      project: "dashboard",
      text: "Done, fixed the bug.",
      diff: [
        { file: "src/a.ts", additions: 3, deletions: 1, status: "modified" },
      ],
      diffSource: "session",
    });
    expect(out).toBe(
      [
        "session: ses_1 (dashboard)",
        "--- reply ---",
        "Done, fixed the bug.",
        "--- diff ---",
        "  - src/a.ts [modified] +3/-1",
      ].join("\n"),
    );
  });

  test("working-tree diffSource uses repo-wide diff header", () => {
    const out = formatResult({
      sessionId: "ses_2",
      project: "infra",
      text: "ok",
      diff: [{ file: "b.ts", additions: 1, deletions: 0 }],
      diffSource: "working-tree",
    });
    expect(out).toContain(
      "--- diff (working tree — repo-wide, may include changes from other sessions) ---",
    );
    expect(out).toContain("  - b.ts [?] +1/-0");
  });

  test("empty diff renders (no changes) and empty text renders (empty)", () => {
    const out = formatResult({
      sessionId: "ses_3",
      project: "agent",
      text: "",
      diff: [],
      diffSource: "session",
    });
    expect(out).toBe(
      [
        "session: ses_3 (agent)",
        "--- reply ---",
        "(empty)",
        "--- diff ---",
        "  (no changes)",
      ].join("\n"),
    );
  });
});

describe("formatWait", () => {
  test("running session, timed out", () => {
    const r: WaitResult = {
      sessions: [
        {
          sessionId: "ses_a",
          project: "alpha",
          state: "running",
          resultAvailable: false,
        },
      ],
      waker: [],
      timedOut: true,
    };
    const out = formatWait(r);
    expect(out).toContain("timed out");
    expect(out).toContain("ses_a (alpha): running");
  });

  test("complete session wakes the wait", () => {
    const r: WaitResult = {
      sessions: [
        {
          sessionId: "ses_a",
          project: "alpha",
          state: "complete",
          resultAvailable: true,
        },
        {
          sessionId: "ses_b",
          project: "beta",
          state: "running",
          resultAvailable: false,
        },
      ],
      waker: ["ses_a"],
      timedOut: false,
    };
    const out = formatWait(r);
    expect(out).toContain("woke on: ses_a");
    expect(out).toContain("ses_a (alpha): complete");
    expect(out).toContain("ses_b (beta): running");
  });

  test("blocked session renders the pending question and options", () => {
    const r: WaitResult = {
      sessions: [
        {
          sessionId: "ses_a",
          project: "alpha",
          state: "blocked",
          resultAvailable: false,
          pendingQuestion: { preview: "proceed?", options: ["yes", "no"] },
        },
      ],
      waker: ["ses_a"],
      timedOut: false,
    };
    const out = formatWait(r);
    expect(out).toContain('waiting on a question — "proceed?"');
    expect(out).toContain("options: yes | no");
  });

  test("failed and not_found states render plainly", () => {
    const r: WaitResult = {
      sessions: [
        {
          sessionId: "ses_a",
          project: "alpha",
          state: "failed",
          resultAvailable: false,
        },
        {
          sessionId: "ses_missing",
          project: "",
          state: "not_found",
          resultAvailable: false,
        },
      ],
      waker: ["ses_a", "ses_missing"],
      timedOut: false,
    };
    const out = formatWait(r);
    expect(out).toContain("ses_a (alpha): failed");
    expect(out).toContain("ses_missing ((unresolved)): not_found");
  });
});
