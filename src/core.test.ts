import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContext } from "./config";
import {
  type CoreOpts,
  type DispatchArgs,
  deriveSessionState,
  dispatch,
  result,
  roster,
  snapshot,
  status,
  toDispatchArgs,
  wait,
} from "./core";

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

/** Fresh per-call context built from the current test roster (mirrors what
 * an adapter would get from config's loadContext per call). */
function ctx(): CoreOpts {
  return { context: loadContext() };
}

async function callRoster() {
  return roster(ctx());
}

async function callDispatch(args: DispatchArgs) {
  return dispatch(args, ctx());
}

async function callStatus(sessionId: string) {
  return status(sessionId, ctx());
}

async function callResult(sessionId: string) {
  return result(sessionId, ctx());
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
    const res = await callRoster();
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
    const res = await callRoster();
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

describe("toDispatchArgs", () => {
  test("empty-string sessionId -> ok:false, distinct from missing project", () => {
    const res = toDispatchArgs({
      prompt: "hi",
      sessionId: "",
      project: "alpha",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("space-bus: sessionId must be a non-empty string");
  });

  test("neither project nor sessionId -> ok:false, project-required error", () => {
    const res = toDispatchArgs({ prompt: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe(
      "space-bus: project is required when starting a new session",
    );
  });

  test("valid new-session shape ({prompt, project}) -> ok:true, project narrowed", () => {
    const res = toDispatchArgs({ prompt: "hi", project: "alpha" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.project).toBe("alpha");
    expect(res.prompt).toBe("hi");
  });

  test("valid steer shape ({prompt, sessionId}) -> ok:true", () => {
    const res = toDispatchArgs({ prompt: "hi", sessionId: "ses_1" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionId).toBe("ses_1");
  });

  test("sessionId + project both present -> ok:true (mismatch guard is dispatch's job, not the validator's)", () => {
    const res = toDispatchArgs({
      prompt: "hi",
      sessionId: "ses_1",
      project: "beta",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionId).toBe("ses_1");
    expect(res.project).toBe("beta");
  });
});

describe("dispatch() new-session", () => {
  test("ok:true mode new on successful create + prompt_async", async () => {
    globalThis.fetch = mockFetch({
      "POST /session": () => ({ body: { id: "ses_new_1" } }),
      "POST /session/ses_new_1/prompt_async": () => ({ status: 204 }),
    });
    const res = await callDispatch({ project: "alpha", prompt: "hello" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessionId).toBe("ses_new_1");
    expect(res.project).toBe("alpha");
    expect(res.mode).toBe("new");
  });

  test("unknown project: ok:false naming valid projects", async () => {
    globalThis.fetch = mockFetch({});
    const res = await callDispatch({ project: "nonexistent", prompt: "hi" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('unknown project "nonexistent"');
    expect(res.error).toContain("alpha");
    expect(res.error).toContain("beta");
  });

  test("empty-string sessionId: ok:false distinct from missing project", async () => {
    globalThis.fetch = mockFetch({});
    const res = await callDispatch({
      project: "alpha",
      sessionId: "",
      prompt: "hi",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("space-bus: sessionId must be a non-empty string");
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
    const res = await callDispatch({ sessionId: "ses_steer", prompt: "yes" });
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
    const res = await callDispatch({ sessionId: "ses_steer", prompt: "more" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.mode).toBe("follow-up");
  });

  test("project mismatch guard: ok:false naming both projects", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_steer": mockSessionLookup("alpha"),
    });
    const res = await callDispatch({
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

describe("deriveSessionState()", () => {
  test("busy -> running", () => {
    expect(deriveSessionState({ busy: true, resolved: true })).toBe("running");
  });

  test("not-busy + resolved -> complete", () => {
    expect(deriveSessionState({ busy: false, resolved: true })).toBe(
      "complete",
    );
  });

  test("pendingQuestion present -> blocked", () => {
    expect(
      deriveSessionState({
        busy: false,
        resolved: true,
        pendingQuestion: { preview: "q", options: [] },
      }),
    ).toBe("blocked");
  });

  test("unresolved -> not_found", () => {
    expect(deriveSessionState({ busy: false, resolved: false })).toBe(
      "not_found",
    );
  });

  test("failed -> failed", () => {
    expect(
      deriveSessionState({ busy: false, resolved: true, failed: true }),
    ).toBe("failed");
  });

  test("busy AND pendingQuestion -> blocked (not running)", () => {
    expect(
      deriveSessionState({
        busy: true,
        resolved: true,
        pendingQuestion: { preview: "q", options: [] },
      }),
    ).toBe("blocked");
  });

  test("not-busy AND pendingQuestion -> blocked (not complete)", () => {
    expect(
      deriveSessionState({
        busy: false,
        resolved: true,
        pendingQuestion: { preview: "q", options: [] },
      }),
    ).toBe("blocked");
  });

  test("unresolved AND busy -> not_found (unresolved wins)", () => {
    expect(deriveSessionState({ busy: true, resolved: false })).toBe(
      "not_found",
    );
  });

  test("failed AND busy -> failed (failed wins over running)", () => {
    expect(
      deriveSessionState({ busy: true, resolved: true, failed: true }),
    ).toBe("failed");
  });

  test("resultAvailable-equivalent: state is complete only when not busy, no question, resolved, not failed", () => {
    const complete = deriveSessionState({ busy: false, resolved: true });
    const running = deriveSessionState({ busy: true, resolved: true });
    const blocked = deriveSessionState({
      busy: false,
      resolved: true,
      pendingQuestion: { preview: "q", options: [] },
    });
    expect(complete).toBe("complete");
    expect(running).not.toBe("complete");
    expect(blocked).not.toBe("complete");
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
    const res = await callStatus("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.busy).toBe(true);
    expect(res.pendingQuestion?.preview).toBe("Proceed?");
    expect(res.pendingQuestion?.options).toEqual(["Yes"]);
  });

  test("fetch throwing resolves ok:false (never rejects)", async () => {
    globalThis.fetch = rejectingFetch("network down");
    await expect(callStatus("ses_1")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  test("busy session: state is running, existing fields unchanged", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA, title: "My session" },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "busy" } } }),
      "GET /session/ses_1/todo": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /question": () => ({ body: [] }),
      "GET /vcs/status": () => ({ body: [] }),
    });
    const res = await callStatus("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state).toBe("running");
    expect(res.busy).toBe(true);
    expect(res.title).toBe("My session");
    expect(res.pendingQuestion).toBeUndefined();
  });

  test("idle session: state is complete, existing fields unchanged", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/ses_1": () => ({
        body: { id: "ses_1", directory: dirA, title: "My session" },
      }),
      "GET /session/status": () => ({ body: { ses_1: { type: "idle" } } }),
      "GET /session/ses_1/todo": () => ({ body: [] }),
      "GET /session/ses_1/diff": () => ({ body: [] }),
      "GET /question": () => ({ body: [] }),
      "GET /vcs/status": () => ({ body: [] }),
    });
    const res = await callStatus("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state).toBe("complete");
    expect(res.resultAvailable).toBe(true);
    expect(res.busy).toBe(false);
    expect(res.diff).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  test("blocked session (pendingQuestion): state is blocked, existing fields unchanged", async () => {
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
    const res = await callStatus("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.state).toBe("blocked");
    expect(res.resultAvailable).toBe(false);
    expect(res.busy).toBe(true);
    expect(res.pendingQuestion?.preview).toBe("Proceed?");
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
    const res = await callResult("ses_1");
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
    const res = await callResult("ses_1");
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
    const res = await callResult("ses_1");
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
    const res = await callResult("ses_1");
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
    const res = await callResult("ses_1");
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
    const res = await callResult("ses_1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.diffSource).toBe("working-tree");
    expect(res.diff).toEqual([
      { file: "d.ts", additions: 1, deletions: 1, status: "M" },
    ]);
  });
});

describe("DispatchArgs type-level exclusivity", () => {
  test("bare {prompt} is a compile error (neither project nor sessionId)", () => {
    // @ts-expect-error — DispatchArgs requires project or sessionId.
    const bad: Parameters<typeof dispatch>[0] = { prompt: "hi" };
    expect(bad).toBeDefined();
  });
});

describe("never-throw contract", () => {
  test("every exported function resolves {ok:false} when fetch hard-rejects", async () => {
    globalThis.fetch = rejectingFetch("hard rejection");

    await expect(callRoster()).resolves.toEqual(
      expect.objectContaining({ ok: true }), // roster fails soft per-project
    );
    await expect(
      callDispatch({ project: "alpha", prompt: "hi" }),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    await expect(callStatus("ses_x")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
    await expect(callResult("ses_x")).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });
});

describe("context validation boundary", () => {
  test("non-localhost baseUrl -> ok:false citing the localhost rule, no fetch attempted", async () => {
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    const badContext = {
      roster: {
        server: { baseUrl: "http://example.com:4096" },
        projects: [
          {
            name: "alpha",
            path: dirA,
            description: "Alpha",
            expandedPath: dirA,
            exists: true,
          },
        ],
      },
    };

    const res = await roster({ context: badContext });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("localhost");
    expect(fetchCalled).toBe(false);
  });

  test("malformed roster (missing projects, wrong types) -> ok:false, never throws", async () => {
    const malformed = {
      roster: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        // projects omitted entirely, and later a wrong-typed variant
      },
    };
    await expect(roster({ context: malformed as never })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );

    const wrongTypes = {
      roster: {
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: "not-an-array",
      },
    };
    await expect(roster({ context: wrongTypes as never })).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  test("validate-then-mutate: mutating the roster object after passing it does not affect core's behavior", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/status": () => ({ body: {} }),
      "GET /session?limit=101": () => ({ body: [] }),
    });

    const context = loadContext();
    const call = roster({ context }); // core parses (copies) synchronously at entry
    // Mutate the caller's object immediately after passing it in.
    context.roster.projects = [];
    (context.roster.server as { baseUrl: string }).baseUrl =
      "http://evil.example.com";

    const res = await call;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projects).toHaveLength(2); // unaffected by post-call mutation
  });

  test("sentinel credential leak check: no error string anywhere contains the sentinel password", async () => {
    const SENTINEL = "SENTINEL_XYZ";
    const context = loadContext();
    context.credentials = { username: "opencode", password: SENTINEL };

    // Bad project name (arg-shape error path).
    globalThis.fetch = mockFetch({});
    const r1 = await dispatch(
      { project: "nonexistent", prompt: "hi" },
      {
        context,
      },
    );
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).not.toContain(SENTINEL);

    // Fetch rejection (never-throw / hard failure path).
    globalThis.fetch = rejectingFetch("network down");
    const r2 = await dispatch({ project: "alpha", prompt: "hi" }, { context });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).not.toContain(SENTINEL);

    const r3 = await status("ses_x", { context });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.error).not.toContain(SENTINEL);

    const r4 = await result("ses_x", { context });
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.error).not.toContain(SENTINEL);

    // Non-localhost context error path.
    const localhostViolation = {
      roster: {
        server: { baseUrl: "http://example.com:4096" },
        projects: [],
      },
      credentials: { username: "opencode", password: SENTINEL },
    };
    const r5 = await roster({ context: localhostViolation });
    expect(r5.ok).toBe(false);
    if (!r5.ok) expect(r5.error).not.toContain(SENTINEL);
  });

  test("project with exists:false behaves as the old existsSync-miss did", async () => {
    const context = loadContext();
    const missing = context.roster.projects.find((p) => p.name === "alpha");
    if (missing) missing.exists = false;

    globalThis.fetch = mockFetch({
      "GET /session/status": () => ({ body: {} }),
      "GET /session?limit=101": () => ({ body: [] }),
    });

    // roster(): skipped in probing, reported as pathExists:false.
    const rosterRes = await roster({ context });
    expect(rosterRes.ok).toBe(true);
    if (!rosterRes.ok) return;
    const alpha = rosterRes.projects.find((p) => p.name === "alpha");
    expect(alpha?.pathExists).toBe(false);
    expect(alpha?.busyCount).toBeUndefined();

    // dispatch(): actionable error naming the missing path.
    const dispatchRes = await dispatch(
      { project: "alpha", prompt: "hi" },
      { context },
    );
    expect(dispatchRes.ok).toBe(false);
    if (!dispatchRes.ok) {
      expect(dispatchRes.error).toContain("does not exist on disk");
    }
  });
});

describe("snapshot()", () => {
  let dirC: string;

  beforeEach(() => {
    dirC = mkdtempSync(join(tmpdir(), "space-bus-core-gamma-"));
  });

  afterEach(() => {
    rmSync(dirC, { recursive: true, force: true });
  });

  function threeProjectContext(): CoreOpts {
    const context = loadContext();
    context.roster.projects.push({
      name: "gamma",
      path: dirC,
      description: "Gamma project",
      expandedPath: dirC,
      exists: true,
    });
    return { context };
  }

  test("happy path: 3-project roster, all present with counts + a pending question on one", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/status": (init) => {
        void init;
        return { body: { ses_1: { type: "busy" } } };
      },
      "GET /session?limit=101": () => ({
        body: [{ id: "ses_1" }, { id: "ses_2" }],
      }),
      "GET /question": () => ({
        body: [
          {
            id: "q1",
            sessionID: "ses_1",
            questions: [
              {
                question: "pick one",
                options: [{ label: "a" }, { label: "b" }],
              },
            ],
          },
        ],
      }),
    });
    const res = await snapshot(threeProjectContext());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.projects).toHaveLength(3);
    for (const name of ["alpha", "beta", "gamma"]) {
      const p = res.projects.find((pr) => pr.name === name);
      expect(p?.exists).toBe(true);
      expect(p?.busyCount).toBe(1);
      expect(p?.sessionCount).toBe(2);
      expect(p?.sessionCountCapped).toBe(false);
      expect(p?.pendingQuestions).toEqual([
        { sessionId: "ses_1", preview: "pick one", options: ["a", "b"] },
      ]);
      expect(p?.sessions).toEqual([
        { sessionId: "ses_1", state: "blocked", resultAvailable: false },
        { sessionId: "ses_2", state: "complete", resultAvailable: true },
      ]);
    }
  });

  test("per-session state: busy, idle, and blocked sessions each report the correct normalized state", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/status": () => ({
        body: {
          ses_busy: { type: "busy" },
          ses_blocked: { type: "busy" },
        },
      }),
      "GET /session?limit=101": () => ({
        body: [{ id: "ses_busy" }, { id: "ses_idle" }, { id: "ses_blocked" }],
      }),
      "GET /question": () => ({
        body: [
          {
            id: "q1",
            sessionID: "ses_blocked",
            questions: [
              {
                question: "pick one",
                options: [{ label: "a" }],
              },
            ],
          },
        ],
      }),
    });
    const res = await snapshot(threeProjectContext());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alpha = res.projects.find((p) => p.name === "alpha");
    expect(alpha?.sessions).toEqual([
      { sessionId: "ses_busy", state: "running", resultAvailable: false },
      { sessionId: "ses_idle", state: "complete", resultAvailable: true },
      { sessionId: "ses_blocked", state: "blocked", resultAvailable: false },
    ]);
  });

  test("parity: snapshot()'s per-session state matches status()'s state for the same session (blocked and complete)", async () => {
    globalThis.fetch = mockFetch({
      "GET /session/status": () => ({
        body: {},
      }),
      "GET /session?limit=101": () => ({
        body: [{ id: "ses_blocked" }, { id: "ses_idle" }],
      }),
      "GET /session/ses_blocked": () => ({
        body: { id: "ses_blocked", title: "t", directory: dirA },
      }),
      "GET /session/ses_idle": () => ({
        body: { id: "ses_idle", title: "t", directory: dirA },
      }),
      "GET /session/ses_blocked/todo": () => ({ body: [] }),
      "GET /session/ses_idle/todo": () => ({ body: [] }),
      "GET /question": () => ({
        body: [
          {
            id: "q1",
            sessionID: "ses_blocked",
            questions: [
              {
                question: "pick one",
                options: [{ label: "a" }],
              },
            ],
          },
        ],
      }),
    });
    const context = threeProjectContext().context;
    const snapshotRes = await snapshot({ context });
    expect(snapshotRes.ok).toBe(true);
    if (!snapshotRes.ok) return;
    const alpha = snapshotRes.projects.find((p) => p.name === "alpha");
    const blockedFromSnapshot = alpha?.sessions?.find(
      (s) => s.sessionId === "ses_blocked",
    );
    const idleFromSnapshot = alpha?.sessions?.find(
      (s) => s.sessionId === "ses_idle",
    );

    const blockedStatusRes = await status("ses_blocked", { context });
    const idleStatusRes = await status("ses_idle", { context });
    expect(blockedStatusRes.ok).toBe(true);
    expect(idleStatusRes.ok).toBe(true);
    if (!blockedStatusRes.ok || !idleStatusRes.ok) return;

    expect(blockedFromSnapshot?.state).toBe(blockedStatusRes.state);
    expect(blockedFromSnapshot?.state).toBe("blocked");
    expect(idleFromSnapshot?.state).toBe(idleStatusRes.state);
    expect(idleFromSnapshot?.state).toBe("complete");
  });

  test("error path: one project's status fetch rejects, others intact, overall ok:true", async () => {
    globalThis.fetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      const directory = (init?.headers as Record<string, string> | undefined)?.[
        "x-opencode-directory"
      ];
      if (directory === dirA) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4096");
      }
      const path = url.replace("http://127.0.0.1:4096", "");
      if (path === "/session/status") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (path === "/session?limit=101") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (path === "/question") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 404 });
    }) as typeof fetch;

    const res = await snapshot(threeProjectContext());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alpha = res.projects.find((p) => p.name === "alpha");
    expect(alpha?.error).toBe("status=599/599");
    const beta = res.projects.find((p) => p.name === "beta");
    expect(beta?.error).toBeUndefined();
    expect(beta?.exists).toBe(true);
    const gamma = res.projects.find((p) => p.name === "gamma");
    expect(gamma?.error).toBeUndefined();
  });

  test("edge: exists:false project reported with zero fetches, no requests made for it", async () => {
    const requestedDirs: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const directory = (init?.headers as Record<string, string> | undefined)?.[
        "x-opencode-directory"
      ];
      if (directory) requestedDirs.push(directory);
      void input;
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("http://127.0.0.1:4096", "");
      if (path === "/session/status") {
        return new Response(JSON.stringify({}), { status: 200 });
      }
      if (path === "/session?limit=101") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (path === "/question") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 404 });
    }) as typeof fetch;

    const context = loadContext();
    const alpha = context.roster.projects.find((p) => p.name === "alpha");
    if (alpha) alpha.exists = false;

    const res = await snapshot({ context });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const alphaEntry = res.projects.find((p) => p.name === "alpha");
    expect(alphaEntry?.exists).toBe(false);
    expect(alphaEntry?.busyCount).toBeUndefined();
    expect(alphaEntry?.sessionCount).toBeUndefined();
    expect(requestedDirs).not.toContain(dirA);
  });

  function emptyRouteResponse(url: string): Response {
    const path = url.replace("http://127.0.0.1:4096", "");
    const okPaths = new Set([
      "/session/status",
      "/session?limit=101",
      "/question",
    ]);
    const body = path === "/session/status" ? {} : [];
    return new Response(JSON.stringify(body), {
      status: okPaths.has(path) ? 200 : 404,
    });
  }

  test("edge: concurrency bound honored (max in-flight projects <= 2 when concurrency:2)", async () => {
    const inFlightDirs = new Set<string>();
    let maxInFlightProjects = 0;
    globalThis.fetch = (async (input, init) => {
      const directory = (init?.headers as Record<string, string> | undefined)?.[
        "x-opencode-directory"
      ];
      if (directory) {
        inFlightDirs.add(directory);
        maxInFlightProjects = Math.max(maxInFlightProjects, inFlightDirs.size);
      }
      await new Promise((r) => setTimeout(r, 10));
      if (directory) inFlightDirs.delete(directory);
      const url = typeof input === "string" ? input : input.toString();
      return emptyRouteResponse(url);
    }) as typeof fetch;

    const opts = threeProjectContext();
    const res = await snapshot({ ...opts, concurrency: 2 });
    expect(res.ok).toBe(true);
    expect(maxInFlightProjects).toBeLessThanOrEqual(2);
  });

  test("sentinel: credential value never appears in any error entry", async () => {
    const SENTINEL = "SENTINEL_SNAPSHOT";
    const context = loadContext();
    context.credentials = { username: "opencode", password: SENTINEL };
    context.roster.projects.push({
      name: "gamma",
      path: dirC,
      description: "Gamma project",
      expandedPath: dirC,
      exists: true,
    });
    globalThis.fetch = rejectingFetch("network down");
    const res = await snapshot({ context });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const p of res.projects) {
      if (p.error) expect(p.error).not.toContain(SENTINEL);
    }
  });
});

describe("wait()", () => {
  type WaitFetchOpts = {
    sessionDirs: Record<string, string>;
    statuses: Record<string, { type: string }>;
    questions?: Record<
      string,
      { id: string; sessionID: string; questions: unknown[] }
    >;
  };

  function waitFetchSessionResponse(
    opts: WaitFetchOpts,
    path: string,
  ): Response {
    const id = decodeURIComponent(path.slice("/session/".length));
    const dir = opts.sessionDirs[id];
    if (!dir) return new Response(JSON.stringify({}), { status: 404 });
    return new Response(JSON.stringify({ id, directory: dir }), {
      status: 200,
    });
  }

  /** Mutable in-test session registry: sessionId -> owning directory, plus
   * mutable status/question maps so tests (esp. the real-elapsed transition
   * test) can flip state mid-wait via setTimeout. */
  function makeWaitFetch(opts: WaitFetchOpts): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("http://127.0.0.1:4096", "");
      if (path === "/session/status") {
        return new Response(JSON.stringify(opts.statuses), { status: 200 });
      }
      if (path === "/question") {
        return new Response(
          JSON.stringify(Object.values(opts.questions ?? {})),
          {
            status: 200,
          },
        );
      }
      if (path.startsWith("/session/") && !path.includes("?")) {
        return waitFetchSessionResponse(opts, path);
      }
      return new Response(JSON.stringify([]), { status: 404 });
    }) as typeof fetch;
  }

  async function callWait(
    sessionIds: string[],
    extra?: { timeoutMs?: number; pollIntervalMs?: number },
  ) {
    return wait(sessionIds, { ...ctx(), ...extra });
  }

  test("happy path: 3 sessions, one already complete at entry -> immediate return, waker=[that id]", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirA, ses_3: dirA },
      statuses: {
        ses_1: { type: "busy" },
        ses_2: { type: "idle" },
        ses_3: { type: "busy" },
      },
    });
    const start = Date.now();
    const res = await callWait(["ses_1", "ses_2", "ses_3"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(false);
    expect(res.waker).toEqual(["ses_2"]);
    expect(res.sessions).toHaveLength(3);
    expect(res.sessions.find((s) => s.sessionId === "ses_2")?.state).toBe(
      "complete",
    );
    expect(res.sessions.find((s) => s.sessionId === "ses_1")?.state).toBe(
      "running",
    );
    // Should return on the first poll, well under the timeout.
    expect(elapsed).toBeLessThan(300);
  });

  test("level-triggered: one already blocked at entry -> immediate return", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirA },
      statuses: { ses_1: { type: "busy" }, ses_2: { type: "busy" } },
      questions: {
        q1: {
          id: "q1",
          sessionID: "ses_2",
          questions: [{ question: "pick", options: [{ label: "a" }] }],
        },
      },
    });
    const res = await callWait(["ses_1", "ses_2"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(false);
    expect(res.waker).toEqual(["ses_2"]);
    expect(
      res.sessions.find((s) => s.sessionId === "ses_2")?.pendingQuestion
        ?.preview,
    ).toBe("pick");
  });

  test("real-elapsed transition: all running at entry, one flips to complete after a delay -> wakes before timeout", async () => {
    const statuses: Record<string, { type: string }> = {
      ses_1: { type: "busy" },
      ses_2: { type: "busy" },
    };
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirA },
      statuses,
    });
    const FLIP_MS = 100;
    const TIMEOUT_MS = 500;
    setTimeout(() => {
      statuses["ses_2"] = { type: "idle" };
    }, FLIP_MS);

    const start = Date.now();
    const res = await callWait(["ses_1", "ses_2"], {
      timeoutMs: TIMEOUT_MS,
      pollIntervalMs: 30,
    });
    const elapsed = Date.now() - start;

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(false);
    expect(res.waker).toEqual(["ses_2"]);
    expect(res.sessions.find((s) => s.sessionId === "ses_1")?.state).toBe(
      "running",
    );
    expect(res.sessions.find((s) => s.sessionId === "ses_2")?.state).toBe(
      "complete",
    );
    // Real elapsed time: it must have genuinely waited for the flip (not an
    // instant/mocked return) but woken up well before the timeout.
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(elapsed).toBeLessThan(TIMEOUT_MS);
  });

  test("timeout: all stay running past timeoutMs -> timedOut:true, ok:true, all-running snapshot", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirA },
      statuses: { ses_1: { type: "busy" }, ses_2: { type: "busy" } },
    });
    const res = await callWait(["ses_1", "ses_2"], {
      timeoutMs: 150,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(true);
    expect(res.waker).toEqual([]);
    expect(res.sessions.every((s) => s.state === "running")).toBe(true);
  });

  test("not_found: one unresolvable id -> inline not_found, wait proceeds on the rest and wakes immediately", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA },
      statuses: { ses_1: { type: "busy" } },
    });
    const res = await callWait(["ses_1", "ses_missing"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(false);
    expect(res.waker).toEqual(["ses_missing"]);
    expect(res.sessions.find((s) => s.sessionId === "ses_missing")?.state).toBe(
      "not_found",
    );
    expect(res.sessions.find((s) => s.sessionId === "ses_1")?.state).toBe(
      "running",
    );
  });

  test("cross-directory: sessions in two directories -> both groups polled, both represented", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirB },
      statuses: { ses_1: { type: "idle" }, ses_2: { type: "busy" } },
    });
    const res = await callWait(["ses_1", "ses_2"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessions.map((s) => s.sessionId).sort()).toEqual([
      "ses_1",
      "ses_2",
    ]);
    expect(res.sessions.find((s) => s.sessionId === "ses_1")?.project).toBe(
      "alpha",
    );
    expect(res.sessions.find((s) => s.sessionId === "ses_2")?.project).toBe(
      "beta",
    );
    expect(res.waker).toEqual(["ses_1"]);
  });

  test("invalid context fails closed: ok:false, never throws", async () => {
    const badContext = {
      roster: { server: { baseUrl: "http://evil.example.com" }, projects: [] },
    };
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed context for the fail-closed test
      wait(["ses_1"], { context: badContext as any, timeoutMs: 100 }),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
  });

  test("deadline independent of api's 30s: loop performs more than one poll before waking (proves it isn't a single 30s-bounded request)", async () => {
    const statuses: Record<string, { type: string }> = {
      ses_1: { type: "busy" },
    };
    let pollCount = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("http://127.0.0.1:4096", "");
      if (path === "/session/status") pollCount += 1;
      return makeWaitFetch({ sessionDirs: { ses_1: dirA }, statuses })(input);
    }) as typeof fetch;

    setTimeout(() => {
      statuses["ses_1"] = { type: "idle" };
    }, 80);

    const res = await callWait(["ses_1"], {
      timeoutMs: 500,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(false);
    // At ~30ms intervals with an 80ms flip, several polls must have happened
    // before wake — proving the loop repeats independently of api()'s
    // per-request 30s abort rather than treating one request as the bound.
    expect(pollCount).toBeGreaterThan(1);
  });

  test("poll failure degrades gracefully: a directory's request failing keeps sessions at last-known state without throwing", async () => {
    let callCount = 0;
    const sessionOpts: WaitFetchOpts = {
      sessionDirs: { ses_1: dirA },
      statuses: {},
    };
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("http://127.0.0.1:4096", "");
      if (path === "/session/status") {
        callCount += 1;
        return new Response("boom", { status: 500 });
      }
      if (path === "/question") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (path.startsWith("/session/") && !path.includes("?")) {
        return waitFetchSessionResponse(sessionOpts, path);
      }
      return new Response(JSON.stringify([]), { status: 404 });
    }) as typeof fetch;

    const res = await callWait(["ses_1"], {
      timeoutMs: 150,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(true);
    expect(res.sessions[0]?.state).toBe("running");
    expect(callCount).toBeGreaterThan(0);
  });

  test("dedupe: same sessionId passed twice -> sessions and waker each have length 1", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_x: dirA },
      statuses: { ses_x: { type: "idle" } },
    });
    const res = await callWait(["ses_x", "ses_x"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessions).toHaveLength(1);
    expect(res.waker).toHaveLength(1);
  });

  test("empty sessionIds -> returns immediately with empty sessions/waker and timedOut:true", async () => {
    const start = Date.now();
    const res = await callWait([], { timeoutMs: 5000, pollIntervalMs: 30 });
    const elapsed = Date.now() - start;
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.sessions).toEqual([]);
    expect(res.waker).toEqual([]);
    expect(res.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(1000);
  });

  test("retry status -> state 'running' (exercises isStatusBusy retry branch)", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA },
      statuses: { ses_1: { type: "retry" } },
    });
    const res = await callWait(["ses_1"], {
      timeoutMs: 150,
      pollIntervalMs: 30,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.timedOut).toBe(true);
    expect(res.sessions.find((s) => s.sessionId === "ses_1")?.state).toBe(
      "running",
    );
  });

  test("cross-surface consistency: wait()-derived state equals status()-derived state for the same scenario", async () => {
    globalThis.fetch = makeWaitFetch({
      sessionDirs: { ses_1: dirA, ses_2: dirA },
      statuses: { ses_1: { type: "busy" }, ses_2: { type: "idle" } },
      questions: {
        q1: {
          id: "q1",
          sessionID: "ses_1",
          questions: [{ question: "pick", options: [{ label: "a" }] }],
        },
      },
    });
    const waitRes = await callWait(["ses_1", "ses_2"], {
      timeoutMs: 300,
      pollIntervalMs: 30,
    });
    expect(waitRes.ok).toBe(true);
    if (!waitRes.ok) return;

    const status1 = await status("ses_1", ctx());
    const status2 = await status("ses_2", ctx());
    expect(status1.ok).toBe(true);
    expect(status2.ok).toBe(true);
    if (!status1.ok || !status2.ok) return;

    expect(waitRes.sessions.find((s) => s.sessionId === "ses_1")?.state).toBe(
      status1.state,
    );
    expect(waitRes.sessions.find((s) => s.sessionId === "ses_2")?.state).toBe(
      status2.state,
    );
  });
});
