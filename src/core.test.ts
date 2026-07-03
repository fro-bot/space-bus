import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, result, roster, status } from "./core";

const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];
const ORIGINAL_FETCH = globalThis.fetch;

let dirA: string;
let dirB: string;
let configDir: string;

function writeRoster(): void {
  const rosterPath = join(configDir, "spacebus.json");
  writeFileSync(
    rosterPath,
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [
        { name: "alpha", path: dirA, description: "Alpha project" },
        { name: "beta", path: dirB, description: "Beta project" },
      ],
    }),
  );
  process.env["SPACE_BUS_CONFIG"] = rosterPath;
}

/** Route table keyed by "METHOD path" (path is whatever follows baseUrl). Values
 * are either a Response-shaping descriptor or a function producing one, so
 * individual tests can special-case by call count / body. */
type RouteHandler = (init?: RequestInit) => {
  status?: number;
  body?: unknown;
};

function mockFetch(routes: Record<string, RouteHandler>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.replace("http://127.0.0.1:4096", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${path}`;
    const handler =
      routes[key] ??
      routes[path] ?? // fallback: method-agnostic match
      undefined;
    if (!handler) {
      return new Response(JSON.stringify([]), { status: 404 });
    }
    const { status: s = 200, body } = handler(init);
    if (s === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(body ?? []), { status: s });
  }) as typeof fetch;
}

function rejectingFetch(message: string): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "space-bus-core-alpha-"));
  dirB = mkdtempSync(join(tmpdir(), "space-bus-core-beta-"));
  configDir = mkdtempSync(join(tmpdir(), "space-bus-core-config-"));
  writeRoster();
});

afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_ENV === undefined) {
    delete process.env["SPACE_BUS_CONFIG"];
  } else {
    process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
  }
});

describe("roster()", () => {
  test("ok:true with project entries on success", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/status": () => ({ body: { ses_1: { type: "busy" } } }),
      "GET /session?limit=101": () => ({
        body: [{ id: "ses_1" }, { id: "ses_2" }],
      }),
    });
    const res = await roster();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projects).toHaveLength(2);
    const alpha = res.projects.find((p) => p.name === "alpha");
    expect(alpha?.pathExists).toBe(true);
    expect(alpha?.busyCount).toBe(1);
    expect(alpha?.sessionCount).toBe(2);
    expect(alpha?.sessionCountCapped).toBe(false);
  });

  test("network refused: still ok:true, statusError set per-project (fail soft)", async () => {
    globalThis.fetch = rejectingFetch("connect ECONNREFUSED 127.0.0.1:4096");
    const res = await roster();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projects).toHaveLength(2);
    for (const p of res.projects) {
      expect(p.pathExists).toBe(true);
      expect(p.statusError).toBe("status=599/599");
      expect(p.busyCount).toBeUndefined();
    }
  });
});

describe("dispatch() new-session", () => {
  test("ok:true mode new on successful create + prompt_async", async () => {
    globalThis.fetch = mockFetch({
      "POST /session": () => ({ body: { id: "ses_new_1" } }),
      "POST /session/ses_new_1/prompt_async": () => ({ status: 204 }),
    });
    const res = await dispatch({ project: "alpha", prompt: "hello" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionId).toBe("ses_new_1");
    expect(res.project).toBe("alpha");
    expect(res.mode).toBe("new");
  });

  test("unknown project: ok:false naming valid projects", async () => {
    globalThis.fetch = mockFetch({});
    const res = await dispatch({ project: "nonexistent", prompt: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('unknown project "nonexistent"');
    expect(res.error).toContain("alpha");
    expect(res.error).toContain("beta");
  });
});

describe("dispatch() steering", () => {
  function mockSessionLookup(owner: "alpha" | "beta"): RouteHandler {
    const directory = owner === "alpha" ? dirA : dirB;
    return () => ({ body: { id: "ses_steer", directory } });
  }

  test("pending question present -> question-reply mode", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_steer": mockSessionLookup("alpha"),
      "GET /question": () => ({
        body: [{ id: "q_1", sessionID: "ses_steer" }],
      }),
      "POST /question/q_1/reply": () => ({ status: 200, body: {} }),
    });
    const res = await dispatch({ sessionId: "ses_steer", prompt: "yes" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("question-reply");
    expect(res.sessionId).toBe("ses_steer");
    expect(res.project).toBe("alpha");
  });

  test("no pending question -> follow-up mode", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_steer": mockSessionLookup("alpha"),
      "GET /question": () => ({ body: [] }),
      "POST /session/ses_steer/prompt_async": () => ({ status: 204 }),
    });
    const res = await dispatch({ sessionId: "ses_steer", prompt: "more" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("follow-up");
  });

  test("project mismatch guard: ok:false naming both projects", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_steer": mockSessionLookup("alpha"),
    });
    const res = await dispatch({
      sessionId: "ses_steer",
      project: "beta",
      prompt: "hi",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("alpha");
    expect(res.error).toContain("beta");
    expect(res.error).toContain("ses_steer");
  });
});

describe("status()", () => {
  test("busy session with pendingQuestion populated", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA, title: "My session" },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "busy" } } }),
      "GET /session/ses_1/todo": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /question": () => ({
        body: [
          {
            id: "q_1",
            sessionID: "ses_1",
            questions: [{ question: "Proceed?", options: [{ label: "Yes" }] }],
          },
        ],
      }),
      "GET /vcs/status": () => ({ body: [] }),
    });
    const res = await status("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.busy).toBe(true);
    expect(res.pendingQuestion?.preview).toBe("Proceed?");
    expect(res.pendingQuestion?.options).toEqual(["Yes"]);
  });

  test("fetch throwing resolves ok:false (never rejects)", async () => {
    globalThis.fetch = rejectingFetch("network down");
    await expect(status("ses_1")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});

describe("result()", () => {
  test("busy session -> ok:false 'still running'", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "busy" } } }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("still running");
  });

  test("idle session: assistant text extracted from /message", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/message?limit=50": () => ({
        body: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: "hi" }],
          },
          {
            info: { role: "assistant" },
            parts: [{ type: "text", text: "Done!" }],
          },
        ],
      }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /vcs/status": () => ({ body: [] }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toBe("Done!");
  });

  test("diff tier (a): non-empty /diff -> diffSource session", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/message?limit=50": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({
        body: [{ file: "a.ts", additions: 1, deletions: 0 }],
      }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSource).toBe("session");
    expect(res.diff).toEqual([{ file: "a.ts", additions: 1, deletions: 0 }]);
  });

  test("diff tier (b): empty bare diff, session.summary.diffs populated -> session", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": (init) => {
        // this route is hit twice: once via findSessionDirectory, once via
        // fetchDiffWithFallback's sessionRes fetch. Both need the same shape
        // but the summary is only relevant for the second use — return it
        // regardless since findSessionDirectory only reads .directory.
        void init;
        return {
          body: {
            id: "ses_1",
            directory: dirA,
            summary: {
              diffs: [{ file: "b.ts", additions: 2, deletions: 1 }],
            },
          },
        };
      },
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/message?limit=50": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSource).toBe("session");
    expect(res.diff).toEqual([{ file: "b.ts", additions: 2, deletions: 1 }]);
  });

  test("diff tier (c): both empty, per-turn diffs aggregate with last-turn-wins", async () => {
    const turnMessages = [
      {
        info: {
          role: "user",
          summary: {
            diffs: [{ file: "c.ts", additions: 1, deletions: 0 }],
          },
        },
        parts: [],
      },
      {
        info: {
          role: "user",
          summary: {
            diffs: [{ file: "c.ts", additions: 5, deletions: 2 }],
          },
        },
        parts: [],
      },
    ];
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/message?limit=50": () => ({ body: turnMessages }),
      "GET /session/ses_1/message?limit=100": () => ({ body: turnMessages }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /vcs/status": () => ({ body: [] }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSource).toBe("turns");
    expect(res.diff).toEqual([{ file: "c.ts", additions: 5, deletions: 2 }]);
  });

  test("diff tier (d): all empty, falls back to /vcs/status -> working-tree", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/message?limit=50": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /vcs/status": () => ({
        body: [{ file: "d.ts", additions: 1, deletions: 1, status: "M" }],
      }),
    });
    const res = await result("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSource).toBe("working-tree");
    expect(res.diff).toEqual([
      { file: "d.ts", additions: 1, deletions: 1, status: "M" },
    ]);
  });
});

describe("never-throw contract", () => {
  test("every exported function resolves {ok:false} when fetch hard-rejects", async () => {
    globalThis.fetch = rejectingFetch("hard rejection");

    await expect(roster()).resolves.toEqual(
      expect.objectContaining({ ok: true }), // roster fails soft per-project
    );
    await expect(dispatch({ project: "alpha", prompt: "hi" })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(status("ses_x")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(result("ses_x")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});
