/**
 * Evidence handling of scripts/verify-controller-delegation.ts.
 *
 * The delegation harness proves routing partly by ABSENCE ("no session in
 * beta's directory", "the nonce never reached the managed target"). An
 * absence claim is only worth anything if the read behind it succeeded, so
 * these tests pin: a failed, timed-out, non-2xx, non-JSON or malformed read —
 * or a missing fixture log — is "unobserved" (the check is NOT ESTABLISHED and
 * the run is incomplete), never an empty result; a valid empty result stays
 * distinguishable; and each target's claims are attributed to the right mode.
 *
 * Pure: no host, no network, no sandbox. The functions under test take an
 * injectable evidence source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type Check,
  type EvidenceSource,
  externalEvidenceChecks,
  finalizeOutcome,
  type ModelHit,
  managedEvidenceChecks,
  negativeEvidenceChecks,
  type Observation,
  type RoutingContext,
  readControllerMessages,
  readerControls,
  readModelHits,
  readSessionList,
  readTranscript,
  summarize,
  type V1Session,
} from "../scripts/verify-controller-delegation";

const ok = <T>(value: T): Observation<T> => ({ ok: true, value });
const bad = (reason: string): Observation<never> => ({ ok: false, reason });

describe("readSessionList: unreadable is never empty", () => {
  test("valid empty list is a readable empty list", () => {
    expect(readSessionList({ status: 200, body: [] })).toEqual(ok([]));
  });

  test("a populated list is returned as is", () => {
    const list = [{ id: "ses_a", directory: "/d" }, { id: "ses_b" }];
    expect(readSessionList({ status: 200, body: list })).toEqual(ok(list));
  });

  test.each([
    [
      "request failed / timed out (status 0)",
      { status: 0, body: "TimeoutError" },
    ],
    ["HTTP 401", { status: 401, body: { error: "unauthorized" } }],
    ["HTTP 404", { status: 404, body: [] }],
    ["HTTP 500 with a list body", { status: 500, body: [{ id: "ses_a" }] }],
    ["200 but not JSON", { status: 200, body: "<html>app shell</html>" }],
    ["200 but an object, not a list", { status: 200, body: { sessions: [] } }],
    ["200 with a null body", { status: 200, body: null }],
    ["entry without an id", { status: 200, body: [{ directory: "/d" }] }],
    ["entry that is not an object", { status: 200, body: ["ses_a"] }],
    [
      "entry with a non-string directory",
      { status: 200, body: [{ id: "a", directory: 3 }] },
    ],
  ])("%s is unreadable", (_name, read) => {
    const r = readSessionList(read);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeGreaterThan(0);
  });
});

// The v1 message envelope, from the pinned v1.17.13 SDK contract
// (@opencode-ai/sdk 1.17.13 types.gen.d.ts: SessionMessagesResponses[200] =
// Array<{ info: Message; parts: Array<Part> }>, Message = UserMessage |
// AssistantMessage (role), Part = text | reasoning | file | tool | step-start |
// step-finish | snapshot | patch | agent | retry | compaction | subtask) and
// from a real v1.17.13 target's stored messages (info.role; text parts carry
// `text`, step-start carries only `type`, step-finish has no `text`) and the
// recorded HTTP shape (`json-array(2) entry-keys[info,parts]`).
const userMsg = (text: string) => ({
  info: {
    id: "msg_u1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
  },
  parts: [
    {
      id: "prt_1",
      sessionID: "ses_1",
      messageID: "msg_u1",
      type: "text",
      text,
    },
  ],
});
const assistantMsg = (text: string) => ({
  info: {
    id: "msg_a1",
    sessionID: "ses_1",
    role: "assistant",
    time: { created: 2 },
  },
  parts: [
    {
      id: "prt_2",
      sessionID: "ses_1",
      messageID: "msg_a1",
      type: "step-start",
    },
    {
      id: "prt_3",
      sessionID: "ses_1",
      messageID: "msg_a1",
      type: "text",
      text,
    },
    {
      id: "prt_4",
      sessionID: "ses_1",
      messageID: "msg_a1",
      type: "step-finish",
      reason: "stop",
      cost: 0,
    },
  ],
});

describe("readTranscript: unreadable is never empty", () => {
  test("a valid empty transcript is readable and contains nothing", () => {
    expect(readTranscript({ status: 200, body: [] })).toEqual(ok("[]"));
  });

  test("a real-shaped conversation is readable and searchable for presence and absence", () => {
    const r = readTranscript({
      status: 200,
      body: [userMsg("Reply with the nonce N-1."), assistantMsg("ACK N-1")],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.includes("Reply with the nonce N-1.")).toBe(true);
      expect(r.value.includes("ACK N-1")).toBe(true);
      expect(r.value.includes("N-2")).toBe(false);
    }
  });

  test("valid non-text parts are accepted (v1 part types other than text)", () => {
    const mk = (part: Record<string, unknown>) => ({
      info: { role: "assistant" },
      parts: [{ id: "p", sessionID: "s", messageID: "m", ...part }],
    });
    const parts: Array<Record<string, unknown>> = [
      { type: "step-start" },
      { type: "step-finish", reason: "stop", cost: 0, tokens: {} },
      {
        type: "tool",
        callID: "c",
        tool: "bash",
        state: { status: "completed" },
      },
      { type: "file", mime: "text/plain", url: "file:///x" },
      { type: "reasoning", text: "thinking", time: { start: 1 } },
      { type: "snapshot", snapshot: "abc" },
      { type: "patch", hash: "h", files: [] },
      { type: "agent", name: "build" },
      { type: "retry", attempt: 1 },
      { type: "compaction", auto: false },
      { type: "subtask", prompt: "p", description: "d", agent: "a" },
    ];
    for (const part of parts)
      expect(readTranscript({ status: 200, body: [mk(part)] }).ok).toBe(true);
  });

  test("a message with no parts is a valid message", () => {
    expect(
      readTranscript({
        status: 200,
        body: [{ info: { role: "user" }, parts: [] }],
      }).ok,
    ).toBe(true);
  });

  test.each([
    ["timeout", { status: 0, body: "TimeoutError" }],
    ["non-2xx", { status: 503, body: [] }],
    ["not JSON", { status: 200, body: "oops" }],
    ["not a list", { status: 200, body: { messages: [] } }],
    ["null entry", { status: 200, body: [null] }],
  ])("%s is unreadable", (_name, read) => {
    expect(readTranscript(read).ok).toBe(false);
  });

  describe("an entry that is not a v1 message envelope is unreadable, never empty", () => {
    const part = { type: "text", text: "hi" };
    test.each([
      ["[{}]", [{}]],
      ["no info", [{ parts: [part] }]],
      ["no parts", [{ info: { role: "user" } }]],
      ["info is null", [{ info: null, parts: [] }]],
      ["info is an array", [{ info: [], parts: [] }]],
      ["info without role", [{ info: {}, parts: [] }]],
      ["info role is not a v1 role", [{ info: { role: "system" }, parts: [] }]],
      ["info role is not a string", [{ info: { role: 1 }, parts: [] }]],
      ["parts is not a list", [{ info: { role: "user" }, parts: "x" }]],
      ["parts is an object", [{ info: { role: "user" }, parts: {} }]],
      ["entry is a list", [[]]],
      ["entry is a string", ["x"]],
      ["part is a string", [{ info: { role: "user" }, parts: ["x"] }]],
      ["part is null", [{ info: { role: "user" }, parts: [null] }]],
      ["part without type", [{ info: { role: "user" }, parts: [{}] }]],
      [
        "part type is not a string",
        [{ info: { role: "user" }, parts: [{ type: 1 }] }],
      ],
      [
        "text part without text",
        [{ info: { role: "user" }, parts: [{ type: "text" }] }],
      ],
      [
        "text part with non-string text",
        [{ info: { role: "user" }, parts: [{ type: "text", text: 1 }] }],
      ],
      [
        "reasoning part without text",
        [{ info: { role: "assistant" }, parts: [{ type: "reasoning" }] }],
      ],
    ])("%s", (_name, body) => {
      const r = readTranscript({ status: 200, body });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/transcript/);
    });

    test("one malformed entry makes the whole transcript unreadable, even beside valid ones", () => {
      const r = readTranscript({
        status: 200,
        body: [userMsg("a"), {}, assistantMsg("b")],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("entry 1");
    });

    test("a malformed part names its entry and part", () => {
      const r = readTranscript({
        status: 200,
        body: [
          userMsg("a"),
          { info: { role: "assistant" }, parts: [part, {}] },
        ],
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/entry 1.*part 1/);
    });
  });

  describe("absence claims built on a transcript", () => {
    const tctx = () => ({
      managedRun: false,
      managedReachable: false,
      nonces: { alpha: "N-alpha", beta: "N-beta", omega: "N-omega" },
      dirs: {
        alpha: "/p/alpha",
        beta: "/p/beta",
        omega: "/p/omega",
        outside: "/p/o",
        ws: "/p/ws",
        rosterB: "/p/r",
      },
      sessionIds: { alpha: "ses_alpha", beta: "ses_beta" },
    });
    const world = (
      betaBody: unknown,
      alphaBody: unknown = [
        userMsg("Reply with the nonce N-alpha."),
        assistantMsg("ACK N-alpha"),
      ],
    ) => {
      const sessions = {
        "/p/alpha": ok([{ id: "ses_alpha", directory: "/p/alpha" }]),
        "/p/beta": ok([{ id: "ses_beta", directory: "/p/beta" }]),
      };
      const src: EvidenceSource = {
        sessions: async (_t, dir) =>
          (sessions as Record<string, Observation<V1Session[]>>)[dir] ??
          bad("unscripted"),
        sessionsUnauthenticated: async () => bad("HTTP 401"),
        transcript: async (_t, sid) =>
          readTranscript({
            status: 200,
            body: sid === "ses_alpha" ? alphaBody : betaBody,
          }),
        hits: () => ok([]),
        requests: () => ok([]),
      };
      return src;
    };
    const claim = async (src: EvidenceSource) =>
      (await externalEvidenceChecks(src, tctx())).find((c) =>
        c.name.includes("never appears in beta's transcript"),
      ) as Check;

    test("positive control: a readable beta transcript without alpha's nonce establishes the absence", async () => {
      const c = await claim(
        world([
          userMsg("Reply with the nonce N-beta."),
          assistantMsg("ACK N-beta"),
        ]),
      );
      expect(c.ok).toBe(true);
      expect(c.unobserved).toBeUndefined();
    });

    test("positive control: a readable valid-empty beta transcript is a true empty, still a pass", async () => {
      const c = await claim(world([]));
      expect(c.ok).toBe(true);
      expect(c.unobserved).toBeUndefined();
    });

    test("positive control: a readable beta transcript containing alpha's nonce is a definite failure", async () => {
      const c = await claim(world([userMsg("Reply with the nonce N-alpha.")]));
      expect(c.ok).toBe(false);
      expect(c.unobserved).toBeUndefined();
    });

    test.each([
      ["[{}]", [{}]],
      ["entry without parts", [{ info: { role: "user" } }]],
      [
        "text part without text",
        [{ info: { role: "user" }, parts: [{ type: "text" }] }],
      ],
    ])(
      "malformed beta transcript (%s) leaves the absence UNOBSERVED, not passed",
      async (_n, body) => {
        const c = await claim(world(body));
        expect(c.ok).toBe(false);
        expect(c.unobserved).toBe(true);
        expect(c.detail).toContain("NOT ESTABLISHED");
      },
    );

    test("a malformed alpha transcript leaves alpha's presence claim and the shared absence unobserved", async () => {
      const src = world([userMsg("Reply with the nonce N-beta.")], [{}]);
      const out = await externalEvidenceChecks(src, tctx());
      const presence = out.find((c) =>
        c.name.includes("alpha session transcript holds"),
      );
      expect(presence?.unobserved).toBe(true);
      expect((await claim(src)).unobserved).toBe(true);
    });
  });
});

describe("readControllerMessages: an unreadable controller transcript is not 'no messages'", () => {
  test("a valid empty list is readable and empty", () => {
    expect(readControllerMessages({ status: 200, body: { data: [] } })).toEqual(
      ok([]),
    );
  });

  test("messages are returned as is", () => {
    const data = [{ type: "assistant", content: [] }];
    expect(readControllerMessages({ status: 200, body: { data } })).toEqual(
      ok(data),
    );
  });

  test.each([
    ["timeout", { status: 0, body: "TimeoutError" }],
    ["non-2xx", { status: 500, body: { data: [] } }],
    ["no data field", { status: 200, body: {} }],
    ["data is not a list", { status: 200, body: { data: "x" } }],
    ["malformed entry", { status: 200, body: { data: [null] } }],
    ["not JSON", { status: 200, body: "oops" }],
  ])("%s is unreadable", (_name, read) => {
    expect(readControllerMessages(read).ok).toBe(false);
  });
});

describe("readModelHits: a missing fixture log cannot certify absence", () => {
  const req = (over: Record<string, unknown>) => ({
    role: "target",
    label: "ext",
    hasTools: false,
    nonces: [],
    cwd: null,
    ...over,
  });

  test("missing / non-array log is unreadable", () => {
    expect(readModelHits(undefined, "ext", "N1").ok).toBe(false);
    expect(readModelHits(null, "ext", "N1").ok).toBe(false);
    expect(readModelHits({ length: 0 }, "ext", "N1").ok).toBe(false);
  });

  test("a malformed entry makes the whole log unreadable (it may hide a hit)", () => {
    expect(
      readModelHits([req({ nonces: ["N1"] }), { role: "target" }], "ext", "N1")
        .ok,
    ).toBe(false);
    expect(readModelHits([null], "ext", "N1").ok).toBe(false);
    expect(readModelHits([req({ nonces: "N1" })], "ext", "N1").ok).toBe(false);
  });

  test("a readable log with no hit is a true empty", () => {
    expect(readModelHits([], "ext", "N1")).toEqual(ok([]));
    expect(readModelHits([req({ nonces: ["other"] })], "ext", "N1")).toEqual(
      ok([]),
    );
  });

  test("hits are scoped to the target label and role", () => {
    const log = [
      req({ label: "ext", nonces: ["N1"], cwd: "/a" }),
      req({ label: "mgd", nonces: ["N1"], cwd: "/o" }),
      req({ role: "controller", label: null, nonces: ["N1"] }),
    ];
    expect(readModelHits(log, "ext", "N1")).toEqual(ok([{ cwd: "/a" }]));
    expect(readModelHits(log, "mgd", "N1")).toEqual(ok([{ cwd: "/o" }]));
  });
});

// ---------------------------------------------------------------------------
// Check builders, driven through a fake evidence source.
// ---------------------------------------------------------------------------

const dirs = {
  alpha: "/p/alpha",
  beta: "/p/beta",
  omega: "/p/omega",
  outside: "/p/outside",
  ws: "/p/ws",
  rosterB: "/p/roster",
};
const nonces = { alpha: "N-alpha", beta: "N-beta", omega: "N-omega" };
const ctx = (over: Partial<RoutingContext> = {}): RoutingContext => ({
  managedRun: false,
  managedReachable: false,
  nonces,
  dirs,
  sessionIds: { alpha: "ses_alpha", beta: "ses_beta" },
  ...over,
});

type FakeOpts = {
  /** sessions[target][dir] ; a missing key reads as unreadable */
  sessions?: Partial<
    Record<"ext" | "mgd", Record<string, Observation<V1Session[]>>>
  >;
  transcripts?: Record<string, Observation<string>>;
  requests?: Observation<
    Array<{
      role: string;
      label: string | null;
      nonces: string[];
      cwd: string | null;
    }>
  >;
  unauthenticated?: Observation<V1Session[]>;
};
function fake(o: FakeOpts = {}) {
  const calls: string[] = [];
  const src: EvidenceSource = {
    async sessions(t, dir) {
      calls.push(`sessions:${t}:${dir}`);
      return o.sessions?.[t]?.[dir] ?? bad(`no scripted read for ${t} ${dir}`);
    },
    async sessionsUnauthenticated(t, dir) {
      calls.push(`unauth:${t}:${dir}`);
      return o.unauthenticated ?? bad("HTTP 401");
    },
    async transcript(t, sid, dir) {
      calls.push(`transcript:${t}:${sid}`);
      return (
        o.transcripts?.[`${t}:${sid}:${dir}`] ??
        bad(`no scripted transcript ${t} ${sid}`)
      );
    },
    hits(t, n) {
      calls.push(`hits:${t}:${n}`);
      const reqs = o.requests ?? ok([]);
      if (!reqs.ok) return reqs;
      return ok(
        reqs.value
          .filter(
            (r) => r.role === "target" && r.label === t && r.nonces.includes(n),
          )
          .map((r): ModelHit => ({ cwd: r.cwd })),
      );
    },
    requests() {
      calls.push("requests");
      return o.requests ?? ok([]);
    },
  };
  return { src, calls };
}

/** A fully readable, correctly routed external-only world. */
const EXTERNAL_REQUESTS = [
  { role: "target", label: "ext", nonces: [nonces.alpha], cwd: dirs.alpha },
  { role: "target", label: "ext", nonces: [nonces.beta], cwd: dirs.beta },
];

type Sessions = Record<string, Observation<V1Session[]>>;
type ExtWorld = FakeOpts & {
  sessions: { ext: Sessions; mgd?: Sessions };
  transcripts: Record<string, Observation<string>>;
};
type ManagedWorld = ExtWorld & { sessions: { ext: Sessions; mgd: Sessions } };

function healthyExternal(): ExtWorld {
  return {
    sessions: {
      ext: {
        [dirs.alpha]: ok([{ id: "ses_alpha", directory: dirs.alpha }]),
        [dirs.beta]: ok([{ id: "ses_beta", directory: dirs.beta }]),
        [dirs.outside]: ok([]),
        [dirs.ws]: ok([]),
        [dirs.rosterB]: ok([]),
      },
    },
    transcripts: {
      [`ext:ses_alpha:${dirs.alpha}`]: ok(
        `Reply with the nonce ${nonces.alpha} ... ACK ${nonces.alpha}`,
      ),
      [`ext:ses_beta:${dirs.beta}`]: ok(
        `Reply with the nonce ${nonces.beta} ... ACK ${nonces.beta}`,
      ),
    },
    requests: ok(EXTERNAL_REQUESTS),
  };
}

const named = (checks: Check[], fragment: string) => {
  const hit = checks.filter((c) => c.name.includes(fragment));
  if (hit.length !== 1)
    throw new Error(
      `expected exactly one check containing "${fragment}", got ${hit.length}: ${checks.map((c) => c.name).join(" | ")}`,
    );
  return hit[0] as Check;
};

describe("externalEvidenceChecks", () => {
  test("a fully readable, correctly routed world passes every check, all external", async () => {
    const out = await externalEvidenceChecks(
      fake(healthyExternal()).src,
      ctx(),
    );
    expect(out.length).toBeGreaterThanOrEqual(6);
    for (const c of out) {
      expect(c.mode).toBe("external");
      expect(c.ok).toBe(true);
      expect(c.unobserved).toBeUndefined();
    }
  });

  test("an unreadable beta session list cannot certify 'NOT in beta's directory'", async () => {
    const o = healthyExternal();
    o.sessions.ext[dirs.beta] = bad("HTTP 500");
    const c = named(
      await externalEvidenceChecks(fake(o).src, ctx()),
      "session exists in alpha's directory and NOT in beta's",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBe(true);
    expect(c.detail).toContain("NOT ESTABLISHED");
    expect(c.detail).toContain("HTTP 500");
  });

  test("a session list that times out is not an empty list", async () => {
    const o = healthyExternal();
    o.sessions.ext[dirs.alpha] = readSessionList({
      status: 0,
      body: "TimeoutError",
    });
    const out = await externalEvidenceChecks(fake(o).src, ctx());
    expect(
      named(out, "session exists in alpha's directory and NOT in beta's")
        .unobserved,
    ).toBe(true);
    // the independent beta-side claim reads only beta's list and is unaffected
    expect(
      named(out, "beta session exists in beta's directory and NOT in alpha's")
        .unobserved,
    ).toBe(true);
  });

  test("an unreadable transcript cannot certify 'alpha's nonce never appears in beta's transcript'", async () => {
    const o = healthyExternal();
    o.transcripts[`ext:ses_beta:${dirs.beta}`] = bad("HTTP 404");
    const out = await externalEvidenceChecks(fake(o).src, ctx());
    expect(named(out, "never appears in beta's transcript").unobserved).toBe(
      true,
    );
    // alpha's own transcript read is fine, so its positive claim stays established
    expect(
      named(
        out,
        "alpha session transcript holds the nonce prompt and ACK reply",
      ).ok,
    ).toBe(true);
  });

  test("a missing fixture log cannot certify the exactly-once model checks", async () => {
    const o = healthyExternal();
    o.requests = bad("model fixture request log is missing");
    const out = await externalEvidenceChecks(fake(o).src, ctx());
    expect(named(out, "saw alpha nonce exactly once").unobserved).toBe(true);
    expect(named(out, "saw beta nonce exactly once").unobserved).toBe(true);
  });

  test("a real misroute is a definite FAIL, not 'unobserved'", async () => {
    const o = healthyExternal();
    o.sessions.ext[dirs.beta] = ok([
      { id: "ses_beta", directory: dirs.beta },
      { id: "ses_alpha", directory: dirs.beta },
    ]);
    const c = named(
      await externalEvidenceChecks(fake(o).src, ctx()),
      "session exists in alpha's directory and NOT in beta's",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBeUndefined();
  });

  test("missing dispatch ids skip the session reads (the dispatch checks already fail upstream)", async () => {
    const f = fake(healthyExternal());
    const out = await externalEvidenceChecks(f.src, ctx({ sessionIds: {} }));
    expect(f.calls.some((c) => c.startsWith("sessions:"))).toBe(false);
    expect(out.every((c) => c.name.includes("model saw"))).toBe(true);
  });
});

function healthyManaged(): ManagedWorld {
  const o = healthyExternal();
  const mgd: Sessions = {
    [dirs.omega]: ok([{ id: "ses_omega", directory: dirs.omega }]),
    [dirs.alpha]: ok([]),
    [dirs.beta]: ok([]),
    [dirs.outside]: ok([]),
    [dirs.ws]: ok([]),
    [dirs.rosterB]: ok([]),
  };
  return {
    ...o,
    sessions: { ext: o.sessions.ext, mgd },
    requests: ok([
      ...EXTERNAL_REQUESTS,
      { role: "target", label: "mgd", nonces: [nonces.omega], cwd: dirs.omega },
    ]),
  };
}
const managedCtx = () =>
  ctx({
    managedRun: true,
    managedReachable: true,
    sessionIds: { alpha: "ses_alpha", beta: "ses_beta", omega: "ses_omega" },
  });

describe("managedEvidenceChecks", () => {
  test("nothing is read and nothing recorded when managed mode did not run", async () => {
    const f = fake(healthyManaged());
    expect(await managedEvidenceChecks(f.src, ctx())).toEqual([]);
    expect(f.calls).toEqual([]);
  });

  test("a healthy managed world passes, every check attributed to managed mode", async () => {
    const out = await managedEvidenceChecks(
      fake(healthyManaged()).src,
      managedCtx(),
    );
    expect(out.length).toBeGreaterThanOrEqual(5);
    for (const c of out) {
      expect(c.mode).toBe("managed");
      expect(c.ok).toBe(true);
    }
  });

  test("a failed read of any one managed directory cannot certify 'no session in the other directories'", async () => {
    const o = healthyManaged();
    o.sessions.mgd[dirs.outside] = bad("request failed or timed out");
    const c = named(
      await managedEvidenceChecks(fake(o).src, managedCtx()),
      "no session in the alpha/beta/outside/workspace directories",
    );
    expect(c.unobserved).toBe(true);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain("outside");
  });

  test("an unreachable managed target (no discovery record) leaves the session claims unobserved", async () => {
    const out = await managedEvidenceChecks(fake(healthyManaged()).src, {
      ...managedCtx(),
      managedReachable: false,
    });
    expect(
      named(out, "managed target: session exists in omega's directory")
        .unobserved,
    ).toBe(true);
    expect(
      named(out, "no session in the alpha/beta/outside/workspace directories")
        .unobserved,
    ).toBe(true);
  });

  test("a missing fixture log leaves every model-log claim unobserved", async () => {
    const o = healthyManaged();
    o.requests = bad("missing");
    const out = await managedEvidenceChecks(fake(o).src, managedCtx());
    expect(named(out, "did not reach the managed target").unobserved).toBe(
      true,
    );
    expect(named(out, "saw omega nonce exactly once").unobserved).toBe(true);
    expect(named(out, "did not reach the external target").unobserved).toBe(
      true,
    );
  });

  test("a stray session on the managed target is a definite FAIL", async () => {
    const o = healthyManaged();
    o.sessions.mgd[dirs.beta] = ok([{ id: "ses_x", directory: dirs.beta }]);
    const c = named(
      await managedEvidenceChecks(fake(o).src, managedCtx()),
      "no session in the alpha/beta/outside/workspace directories",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBeUndefined();
  });
});

describe("negativeEvidenceChecks: claims are scoped and attributed to the target they are about", () => {
  const negatives = [
    { key: "omega-via-ambient", nonce: "N-bad" },
    { key: "out-of-roster", nonce: "N-out" },
  ];
  const withMgd = [
    ...negatives.slice(0, 1),
    { key: "alpha-via-managed-b", nonce: "N-wrong" },
    negatives[1] as (typeof negatives)[number],
  ];

  test("external-only run: only external claims, and the managed target is never read", async () => {
    const f = fake(healthyExternal());
    const out = await negativeEvidenceChecks(f.src, ctx(), negatives);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((c) => c.mode === "external" && c.ok)).toBe(true);
    expect(f.calls.filter((c) => c.includes(":mgd")).length).toBe(0);
    expect(out.some((c) => /managed/.test(c.name))).toBe(false);
  });

  test("managed run: ext claims are external, mgd claims are managed; a wrong-roster scenario is managed on both targets", async () => {
    const out = await negativeEvidenceChecks(
      fake(healthyManaged()).src,
      managedCtx(),
      withMgd,
    );
    const ambientExt = named(
      out,
      "omega-via-ambient nonce never reached the external target's model",
    );
    const ambientMgd = named(
      out,
      "omega-via-ambient nonce never reached the managed target's model",
    );
    expect([ambientExt.mode, ambientMgd.mode]).toEqual(["external", "managed"]);
    const wrongExt = named(
      out,
      "alpha-via-managed-b nonce never reached the external target's model",
    );
    const wrongMgd = named(
      out,
      "alpha-via-managed-b nonce never reached the managed target's model",
    );
    expect([wrongExt.mode, wrongMgd.mode]).toEqual(["managed", "managed"]);
    expect(named(out, "no session exists on the external target").mode).toBe(
      "external",
    );
    expect(named(out, "no session exists on the managed target").mode).toBe(
      "managed",
    );
    expect(out.every((c) => c.ok)).toBe(true);
  });

  test("an unreadable managed stray scan leaves ONLY the managed claim unobserved; the external claim is still established", async () => {
    const o = healthyManaged();
    o.sessions.mgd[dirs.ws] = bad("HTTP 500");
    const out = await negativeEvidenceChecks(
      fake(o).src,
      managedCtx(),
      withMgd,
    );
    const mgd = named(out, "no session exists on the managed target");
    expect(mgd.unobserved).toBe(true);
    expect(mgd.mode).toBe("managed");
    const ext = named(out, "no session exists on the external target");
    expect(ext.ok).toBe(true);
    expect(ext.unobserved).toBeUndefined();
  });

  test("a failed external stray scan cannot certify 'no session in any out-of-roster directory'", async () => {
    const o = healthyExternal();
    o.sessions.ext[dirs.rosterB] = readSessionList({
      status: 200,
      body: "<html>",
    });
    const c = named(
      await negativeEvidenceChecks(fake(o).src, ctx(), negatives),
      "no session exists on the external target",
    );
    expect(c.unobserved).toBe(true);
    expect(c.detail).toContain("NOT ESTABLISHED");
  });

  test("a stray session found in one cell is a definite FAIL even though another cell was unreadable", async () => {
    const o = healthyExternal();
    o.sessions.ext[dirs.outside] = ok([{ id: "ses_stray" }]);
    o.sessions.ext[dirs.ws] = bad("HTTP 500");
    const c = named(
      await negativeEvidenceChecks(fake(o).src, ctx(), negatives),
      "no session exists on the external target",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBeUndefined();
    expect(c.detail).toContain("ses_stray");
  });

  test("a missing fixture log cannot certify that a nonce never reached a model", async () => {
    const o = healthyExternal();
    o.requests = bad("missing");
    const out = await negativeEvidenceChecks(fake(o).src, ctx(), negatives);
    for (const c of out.filter((x) => x.name.includes("nonce never reached"))) {
      expect(c.unobserved).toBe(true);
      expect(c.ok).toBe(false);
    }
  });

  test("a nonce that DID reach the external target is a definite FAIL", async () => {
    const o = healthyExternal();
    o.requests = ok([
      { role: "target", label: "ext", nonces: ["N-bad"], cwd: dirs.alpha },
    ]);
    const c = named(
      await negativeEvidenceChecks(fake(o).src, ctx(), negatives),
      "omega-via-ambient nonce never reached the external target's model",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBeUndefined();
  });

  test("a passing absence claim names the cells it observed", async () => {
    const c = named(
      await negativeEvidenceChecks(
        fake(healthyExternal()).src,
        ctx(),
        negatives,
      ),
      "no session exists on the external target",
    );
    expect(c.ok).toBe(true);
    expect(c.detail).toContain(dirs.outside);
    expect(c.detail).toContain(dirs.ws);
    expect(c.detail).toContain(dirs.rosterB);
  });
});

describe("readerControls: a failed read, a true empty and a known-present are three different things", () => {
  const untouchedDir = "/p/never-created";
  const world = (): ExtWorld => {
    const o = healthyExternal();
    o.sessions.ext[untouchedDir] = ok([]);
    return o;
  };

  test("a healthy reader passes every control", async () => {
    const out = await readerControls(fake(world()).src, ctx(), {
      untouchedDir,
    });
    expect(out.length).toBeGreaterThanOrEqual(6);
    for (const c of out) {
      expect(c.kind).toBe("harness");
      expect(c.ok).toBe(true);
    }
    expect(named(out, "known-present").ok).toBe(true);
    expect(named(out, "valid empty list").ok).toBe(true);
    expect(named(out, "refused read is reported unreadable").ok).toBe(true);
  });

  test("a reader that turned a refused read into an empty list FAILS its control", async () => {
    const o = world();
    o.unauthenticated = ok([]); // the old behaviour: failure swallowed as []
    const c = named(
      await readerControls(fake(o).src, ctx(), { untouchedDir }),
      "refused read is reported unreadable",
    );
    expect(c.ok).toBe(false);
  });

  test("a reader that cannot see a known-present session FAILS its control", async () => {
    const o = world();
    o.sessions.ext[dirs.alpha] = ok([]);
    const c = named(
      await readerControls(fake(o).src, ctx(), { untouchedDir }),
      "known-present",
    );
    expect(c.ok).toBe(false);
  });

  test("an unreadable untouched directory is not a valid empty list", async () => {
    const o = world();
    o.sessions.ext[untouchedDir] = bad("HTTP 500");
    const c = named(
      await readerControls(fake(o).src, ctx(), { untouchedDir }),
      "valid empty list",
    );
    expect(c.ok).toBe(false);
  });

  test("the directory-filter control cannot pass on an unreadable list", async () => {
    const o = world();
    o.sessions.ext[dirs.beta] = bad("HTTP 500");
    const c = named(
      await readerControls(fake(o).src, ctx(), { untouchedDir }),
      "directory filter discriminates",
    );
    expect(c.ok).toBe(false);
    expect(c.unobserved).toBe(true);
  });

  test("a missing fixture log fails the model-fixture and detector controls instead of passing vacuously", async () => {
    const o = world();
    o.requests = bad("missing");
    const out = await readerControls(fake(o).src, ctx(), { untouchedDir });
    expect(named(out, "controller model is a fixture").ok).toBe(false);
    expect(named(out, "detector sees a delivered nonce").ok).toBe(false);
    expect(named(out, "detector reports 0 for a never-sent nonce").ok).toBe(
      false,
    );
  });

  test("a fixture request with an unknown role fails the fixture-only control", async () => {
    const o = world();
    o.requests = ok([{ role: "unknown", label: null, nonces: [], cwd: null }]);
    expect(
      named(
        await readerControls(fake(o).src, ctx(), { untouchedDir }),
        "controller model is a fixture",
      ).ok,
    ).toBe(false);
  });

  test("managed controls only exist for a managed run, and need their own readable cells", async () => {
    const o = world();
    o.sessions.mgd = {
      [dirs.omega]: ok([{ id: "ses_omega", directory: dirs.omega }]),
      [untouchedDir]: ok([]),
    };
    const external = await readerControls(fake(o).src, ctx(), { untouchedDir });
    expect(external.some((c) => c.mode === "managed")).toBe(false);
    const withMgd = await readerControls(fake(o).src, managedCtx(), {
      untouchedDir,
    });
    const mgdControls = withMgd.filter((c) => c.mode === "managed");
    expect(mgdControls.length).toBeGreaterThanOrEqual(2);
    expect(mgdControls.every((c) => c.ok)).toBe(true);
  });
});

describe("summarize: unobserved evidence is incomplete, never pass and never a product finding", () => {
  const c = (over: Partial<Check>): Check => ({
    name: "n",
    kind: "u2",
    mode: "external",
    ok: true,
    ...over,
  });
  const base = { preflightOnly: false, modeArg: "both" as const };
  const avail = { available: true };
  const blocked = { available: false };

  test("original semantics: external pass + managed blocked is exit 3, managed BLOCKED", () => {
    const r = summarize({
      ...base,
      checks: [c({}), c({ kind: "harness" })],
      preflight: blocked,
    });
    expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
      "PASS",
      "BLOCKED",
      3,
    ]);
  });

  test("original semantics: both modes pass is exit 0", () => {
    const r = summarize({
      ...base,
      checks: [c({}), c({ mode: "managed" })],
      preflight: avail,
    });
    expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
      "PASS",
      "PASS",
      0,
    ]);
  });

  test("original semantics: a failed u2 check is a finding, exit 2", () => {
    const r = summarize({
      ...base,
      checks: [c({ ok: false }), c({ mode: "managed" })],
      preflight: avail,
    });
    expect([r.externalStatus, r.exit]).toEqual(["FAIL", 2]);
  });

  test("original semantics: a failed harness check is invalid, exit 1", () => {
    expect(
      summarize({
        ...base,
        checks: [c({}), c({ kind: "harness", ok: false })],
        preflight: blocked,
      }).exit,
    ).toBe(1);
  });

  test("original semantics: --mode external reports managed NOT-RUN and exits 0 on pass", () => {
    const r = summarize({
      checks: [c({})],
      preflight: blocked,
      preflightOnly: false,
      modeArg: "external",
    });
    expect([r.managedStatus, r.exit]).toEqual(["NOT-RUN (--mode external)", 0]);
  });

  test("original semantics: --preflight-only never claims a mode passed", () => {
    const r = summarize({
      checks: [],
      preflight: blocked,
      preflightOnly: true,
      modeArg: "both",
    });
    expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
      "NOT-RUN (--preflight-only)",
      "BLOCKED",
      3,
    ]);
    const ok2 = summarize({
      checks: [],
      preflight: avail,
      preflightOnly: true,
      modeArg: "both",
    });
    expect(ok2.exit).toBe(0);
  });

  test("an unobserved external check makes external INCOMPLETE and the run exit 1 — not PASS and not FAIL", () => {
    const r = summarize({
      ...base,
      checks: [c({}), c({ ok: false, unobserved: true })],
      preflight: blocked,
    });
    expect(r.externalStatus).toBe("INCOMPLETE");
    expect(r.exit).toBe(1);
    expect(r.unobserved).toBe(1);
  });

  test("an unobserved managed check makes managed INCOMPLETE and does not touch external's PASS", () => {
    const r = summarize({
      ...base,
      checks: [c({}), c({ mode: "managed", ok: false, unobserved: true })],
      preflight: avail,
    });
    expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
      "PASS",
      "INCOMPLETE",
      1,
    ]);
  });

  test("blocked managed is still BLOCKED (not INCOMPLETE) when no managed check exists", () => {
    const r = summarize({ ...base, checks: [c({})], preflight: blocked });
    expect(r.managedStatus).toBe("BLOCKED");
  });
});

describe("finalizeOutcome: a summary that cannot be persisted is a harness failure, never a success", () => {
  const base = {
    keep: false,
    ownWorkDir: true,
    externalStatus: "PASS",
    managedStatus: "PASS",
  };
  const okWriter = () => {
    const calls = { n: 0 };
    return {
      calls,
      write: () => {
        calls.n += 1;
      },
    };
  };
  const failingWriter = (
    error: unknown = new Error("ENOSPC: no space left"),
  ) => {
    const calls = { n: 0 };
    return {
      calls,
      write: () => {
        calls.n += 1;
        throw error;
      },
    };
  };

  describe("unchanged when the summary is persisted", () => {
    test.each([
      ["success", 0, "PASS", "PASS"],
      ["blocked managed", 3, "PASS", "BLOCKED"],
      ["--mode external", 0, "PASS", "NOT-RUN (--mode external)"],
      [
        "preflight-only, managed blocked",
        3,
        "NOT-RUN (--preflight-only)",
        "BLOCKED",
      ],
      [
        "preflight-only, managed available",
        0,
        "NOT-RUN (--preflight-only)",
        "PREFLIGHT-OK (flows not run: --preflight-only)",
      ],
    ])(
      "%s: exit kept, work dir removed, plain headline",
      (_n, exit, ext, mgd) => {
        const w = okWriter();
        const r = finalizeOutcome({
          ...base,
          exit,
          externalStatus: ext,
          managedStatus: mgd,
          writeSummary: w.write,
        });
        expect(r.exit).toBe(exit);
        expect(r.summaryPersisted).toBe(true);
        expect(r.removeWorkDir).toBe(true);
        expect(r.headline).toBe(`external: ${ext}; managed: ${mgd}`);
        expect(w.calls.n).toBe(1);
      },
    );

    test.each([
      ["finding (exit 2)", 2],
      ["harness invalid (exit 1)", 1],
    ])("%s: exit kept and the work dir is retained", (_n, exit) => {
      const r = finalizeOutcome({
        ...base,
        exit,
        writeSummary: okWriter().write,
      });
      expect([r.exit, r.removeWorkDir, r.summaryPersisted]).toEqual([
        exit,
        false,
        true,
      ]);
    });

    test("--keep or a work dir this run does not own is never removed", () => {
      expect(
        finalizeOutcome({
          ...base,
          exit: 0,
          keep: true,
          writeSummary: okWriter().write,
        }).removeWorkDir,
      ).toBe(false);
      expect(
        finalizeOutcome({
          ...base,
          exit: 0,
          ownWorkDir: false,
          writeSummary: okWriter().write,
        }).removeWorkDir,
      ).toBe(false);
    });
  });

  describe("when persisting the summary fails", () => {
    test.each([
      ["success", 0, "PASS", "PASS"],
      ["blocked managed", 3, "PASS", "BLOCKED"],
      ["finding", 2, "FAIL", "PASS"],
      ["already invalid", 1, "INCOMPLETE", "PASS"],
      ["--mode external", 0, "PASS", "NOT-RUN (--mode external)"],
      [
        "preflight-only, managed blocked",
        3,
        "NOT-RUN (--preflight-only)",
        "BLOCKED",
      ],
      [
        "preflight-only, managed available",
        0,
        "NOT-RUN (--preflight-only)",
        "PREFLIGHT-OK (flows not run: --preflight-only)",
      ],
    ])(
      "%s: exit 1, owned work dir retained, no unqualified headline",
      (_n, exit, ext, mgd) => {
        const w = failingWriter();
        const r = finalizeOutcome({
          ...base,
          exit,
          externalStatus: ext,
          managedStatus: mgd,
          writeSummary: w.write,
        });
        expect(r.exit).toBe(1);
        expect(r.summaryPersisted).toBe(false);
        expect(r.removeWorkDir).toBe(false);
        expect(r.summaryError).toContain("ENOSPC");
        // the headline names the failure and marks the statuses as unrecorded
        expect(r.headline).toContain("INVALID");
        expect(r.headline).toMatch(/summary .*not persisted/i);
        expect(r.headline).toContain("ENOSPC");
        expect(r.headline).toContain("unrecorded");
        expect(r.headline.startsWith("external:")).toBe(false);
        expect(r.headline).not.toBe(`external: ${ext}; managed: ${mgd}`);
        expect(w.calls.n).toBe(1);
      },
    );

    test("a non-Error failure is reported, not rethrown", () => {
      const r = finalizeOutcome({
        ...base,
        exit: 0,
        writeSummary: failingWriter("disk full").write,
      });
      expect(r.exit).toBe(1);
      expect(r.summaryError).toBe("disk full");
    });

    test("the work dir is retained even when --keep is absent and the exit would have allowed cleanup", () => {
      const w = failingWriter();
      expect(
        finalizeOutcome({ ...base, exit: 0, writeSummary: w.write })
          .removeWorkDir,
      ).toBe(false);
      expect(
        finalizeOutcome({
          ...base,
          exit: 3,
          managedStatus: "BLOCKED",
          writeSummary: w.write,
        }).removeWorkDir,
      ).toBe(false);
    });
  });

  test("wiring: main() persists through finalizeOutcome after teardown, and no longer cleans up on exit alone", () => {
    const src = readFileSync(
      new URL("../scripts/verify-controller-delegation.ts", import.meta.url),
      "utf8",
    );
    const teardown = src.indexOf(
      "teardown: every host process this run started is gone",
    );
    const finalize = src.indexOf("finalizeOutcome({");
    expect(teardown).toBeGreaterThan(0);
    expect(finalize).toBeGreaterThan(teardown);
    expect(src).not.toMatch(/\(exit === 0 \|\| exit === 3\) && !keep && own\b/);
    // the exit code and the cleanup decision both come from the outcome
    expect(src).toContain("exit = outcome.exit;");
    expect(src).toContain("if (outcome.removeWorkDir) rmSync(iso.work");
  });
});

describe("summarize: a confirmed product failure is not hidden by an unobserved check", () => {
  const chk = (over: Partial<Check>): Check => ({
    name: "n",
    kind: "u2",
    mode: "external",
    ok: true,
    ...over,
  });
  const failed = (over: Partial<Check> = {}) =>
    chk({ name: "confirmed failure", ok: false, ...over });
  const unobserved = (over: Partial<Check> = {}) =>
    chk({
      name: "unreadable claim",
      ok: false,
      unobserved: true,
      detail: "NOT ESTABLISHED (evidence unreadable): HTTP 500",
      ...over,
    });
  const avail = { available: true };
  const blocked = { available: false };
  const both = { preflightOnly: false, modeArg: "both" as const };

  describe("same mode", () => {
    test("external: failure + unobserved is FAIL (exit 2), with the unobserved check retained", () => {
      const r = summarize({
        ...both,
        checks: [chk({}), failed(), unobserved()],
        preflight: blocked,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "FAIL",
        "BLOCKED",
        2,
      ]);
      expect(r.failed).toBe(1);
      expect(r.unobserved).toBe(1);
    });

    test("managed: failure + unobserved is FAIL (exit 2), external untouched", () => {
      const r = summarize({
        ...both,
        checks: [
          chk({}),
          failed({ mode: "managed" }),
          unobserved({ mode: "managed" }),
        ],
        preflight: avail,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "PASS",
        "FAIL",
        2,
      ]);
    });

    test("order does not matter", () => {
      const r = summarize({
        ...both,
        checks: [unobserved(), failed(), chk({})],
        preflight: blocked,
      });
      expect(r.externalStatus).toBe("FAIL");
    });

    test("unobserved alone is still INCOMPLETE (exit 1), and unobserved + passes too", () => {
      for (const checks of [[unobserved()], [chk({}), unobserved(), chk({})]]) {
        const r = summarize({ ...both, checks, preflight: blocked });
        expect([r.externalStatus, r.exit]).toEqual(["INCOMPLETE", 1]);
        expect(r.failed).toBe(0);
        expect(r.unobserved).toBe(1);
      }
    });

    test("a failure alone is FAIL (exit 2)", () => {
      const r = summarize({ ...both, checks: [failed()], preflight: blocked });
      expect([r.externalStatus, r.exit]).toEqual(["FAIL", 2]);
    });
  });

  describe("across modes the statuses stay independent and a product failure exits 2", () => {
    const ext = (cs: Check[]) =>
      cs.map((c) => ({ ...c, mode: "external" as const }));
    const mgd = (cs: Check[]) =>
      cs.map((c) => ({ ...c, mode: "managed" as const }));

    test("external FAIL + managed INCOMPLETE: both retained, exit 2", () => {
      const r = summarize({
        ...both,
        checks: [...ext([failed()]), ...mgd([unobserved()])],
        preflight: avail,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "FAIL",
        "INCOMPLETE",
        2,
      ]);
    });

    test("external INCOMPLETE + managed FAIL: both retained, exit 2", () => {
      const r = summarize({
        ...both,
        checks: [...ext([unobserved()]), ...mgd([failed()])],
        preflight: avail,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "INCOMPLETE",
        "FAIL",
        2,
      ]);
    });

    test("external FAIL + managed BLOCKED is still exit 2 (a finding outranks blocked)", () => {
      const r = summarize({
        ...both,
        checks: ext([failed()]),
        preflight: blocked,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "FAIL",
        "BLOCKED",
        2,
      ]);
    });

    test("external INCOMPLETE + managed BLOCKED is exit 1, not 3", () => {
      const r = summarize({
        ...both,
        checks: ext([unobserved()]),
        preflight: blocked,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "INCOMPLETE",
        "BLOCKED",
        1,
      ]);
    });

    test("external PASS + managed INCOMPLETE is exit 1; external PASS + managed BLOCKED is exit 3", () => {
      expect(
        summarize({
          ...both,
          checks: [chk({}), ...mgd([unobserved()])],
          preflight: avail,
        }).exit,
      ).toBe(1);
      expect(
        summarize({ ...both, checks: [chk({})], preflight: blocked }).exit,
      ).toBe(3);
    });

    test("external FAIL with --mode external: managed stays NOT-RUN, exit 2", () => {
      const r = summarize({
        checks: [failed(), unobserved()],
        preflight: blocked,
        preflightOnly: false,
        modeArg: "external",
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "FAIL",
        "NOT-RUN (--mode external)",
        2,
      ]);
    });

    test("no preflight recorded: managed INCOMPLETE is retained next to an external FAIL (exit 2)", () => {
      const r = summarize({
        ...both,
        checks: [failed()],
        preflight: undefined,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "FAIL",
        "INCOMPLETE",
        2,
      ]);
    });

    test("external with no checks is INCOMPLETE and does not hide a managed FAIL", () => {
      const r = summarize({
        ...both,
        checks: mgd([failed()]),
        preflight: avail,
      });
      expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
        "INCOMPLETE",
        "FAIL",
        2,
      ]);
    });
  });

  describe("an invalid harness is exit 1 whatever else is true", () => {
    test.each([
      [
        "failed harness check + product failure",
        [chk({ kind: "harness", ok: false }), failed()],
      ],
      [
        "unreadable harness evidence + product failure",
        [unobserved({ kind: "harness" }), failed()],
      ],
      [
        "failed harness check + unobserved product check",
        [chk({ kind: "harness", ok: false }), unobserved()],
      ],
      ["failed harness check alone", [chk({ kind: "harness", ok: false })]],
    ])("%s", (_n, checks) => {
      const r = summarize({ ...both, checks, preflight: avail });
      expect(r.exit).toBe(1);
      expect(r.harnessBad).toBe(true);
    });

    test("a failed teardown check (harness) keeps a clean-looking run at exit 1", () => {
      const r = summarize({
        ...both,
        checks: [
          chk({}),
          chk({ kind: "harness", ok: false, name: "teardown" }),
        ],
        preflight: blocked,
      });
      expect(r.exit).toBe(1);
    });
  });

  describe("preflight-only and not-run semantics are unchanged", () => {
    test("preflight-only blocked is 3, available is 0, harness-invalid is 1", () => {
      const po = { preflightOnly: true, modeArg: "both" as const };
      expect(summarize({ ...po, checks: [], preflight: blocked }).exit).toBe(3);
      expect(summarize({ ...po, checks: [], preflight: avail }).exit).toBe(0);
      expect(
        summarize({
          ...po,
          checks: [chk({ kind: "harness", ok: false })],
          preflight: blocked,
        }).exit,
      ).toBe(1);
    });
  });

  describe("failures and unobserved checks are counted and reported separately", () => {
    const mixed = [
      chk({}),
      failed({ name: "ext failure" }),
      unobserved({
        name: "ext unread",
        detail: "NOT ESTABLISHED: ext HTTP 500",
      }),
      unobserved({
        name: "mgd unread",
        mode: "managed",
        detail: "NOT ESTABLISHED: mgd timeout",
      }),
      failed({ name: "mgd failure", mode: "managed" }),
    ];

    test("failed excludes unobserved; unobserved is counted in total and per mode", () => {
      const r = summarize({ ...both, checks: mixed, preflight: avail });
      expect(r.failed).toBe(2);
      expect(r.unobserved).toBe(2);
      expect(r.unobservedByMode).toEqual({ external: 1, managed: 1 });
    });

    test("every unobserved check keeps its name, mode and reason", () => {
      const r = summarize({ ...both, checks: mixed, preflight: avail });
      expect(r.unobservedChecks).toEqual([
        {
          name: "ext unread",
          mode: "external",
          kind: "u2",
          reason: "NOT ESTABLISHED: ext HTTP 500",
        },
        {
          name: "mgd unread",
          mode: "managed",
          kind: "u2",
          reason: "NOT ESTABLISHED: mgd timeout",
        },
      ]);
    });

    test("an ok:false check without the unobserved flag is a failure, never unobserved", () => {
      const r = summarize({
        ...both,
        checks: [chk({ ok: false })],
        preflight: blocked,
      });
      expect([r.externalStatus, r.failed, r.unobserved]).toEqual([
        "FAIL",
        1,
        0,
      ]);
    });

    test("a passing run reports zero of both", () => {
      const r = summarize({ ...both, checks: [chk({})], preflight: blocked });
      expect([r.failed, r.unobserved, r.unobservedChecks]).toEqual([0, 0, []]);
    });
  });
});
