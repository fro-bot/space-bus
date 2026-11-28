/**
 * Safety properties of scripts/verify-controller-delegation.ts that the
 * evidence-handling tests do not cover:
 *
 *   - every HTTP request the harness makes is pinned to a loopback destination
 *     on a port this run owns, and the one port that is read from a file (the
 *     plugin's managed-target discovery record) is validated before use;
 *   - what is persisted as evidence is bounded and credential-scrubbed, and a
 *     secret cannot survive truncation or an unredacted key;
 *   - a preflight whose unsandboxed control also fails cannot attribute the
 *     failure to the sandbox, so it is inconclusive (exit 1), not BLOCKED (3).
 *
 * Pure and synthetic: every credential below is an obviously fake value, and
 * the only socket is a throwaway 127.0.0.1 listener in the positive control.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  type Check,
  classifyPreflight,
  createLoopbackHttp,
  destinationProblem,
  errorCategory,
  fatalCategory,
  type HarnessKnown,
  isSafeSessionId,
  type ProbeRun,
  parseManagedDiscovery,
  projectCheckEvidence,
  projectFixtureRequests,
  projectFlowEvidence,
  projectPreflight,
  projectTeardown,
  readControllerMessages,
  readFixtureRequests,
  readSessionList,
  readTranscript,
  recognizedReasons,
  renderCheckLog,
  renderEvidence,
  renderFlowLog,
  renderPreflightLog,
  renderSelfTestLog,
  summarize,
  transportFailure,
  verifyManagedDiscovery,
} from "../scripts/verify-controller-delegation";

const FAKE_PW = "synthetic-nonsecret-pw-0001";

describe("parseManagedDiscovery: a file-derived port/pid is validated before any use", () => {
  const record = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      port: 49152,
      pid: 4242,
      password: FAKE_PW,
      identity: "ignored",
      ...over,
    });

  test("control: a well-formed record is accepted and extra fields are ignored", () => {
    expect(parseManagedDiscovery(record())).toEqual({
      ok: true,
      value: { port: 49152, pid: 4242, password: FAKE_PW },
    });
  });

  test.each([
    ["port 0", { port: 0 }],
    ["privileged port", { port: 80 }],
    ["port above 65535", { port: 65536 }],
    ["fractional port", { port: 49152.5 }],
    ["string port", { port: "49152" }],
    ["missing port", { port: undefined }],
    ["pid 0 (would signal the caller's group)", { pid: 0 }],
    ["pid 1", { pid: 1 }],
    ["negative pid (would signal every process)", { pid: -1 }],
    ["fractional pid", { pid: 4242.5 }],
    ["empty password", { password: "" }],
    ["non-string password", { password: 7 }],
    ["password with a control character", { password: "a\nb" }],
    ["oversized password", { password: "x".repeat(257) }],
  ])("%s is rejected", (_name, over) => {
    expect(parseManagedDiscovery(record(over)).ok).toBe(false);
  });

  test.each([
    ["not JSON", "<html>"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["a JSON string", '"x"'],
  ])("%s is rejected", (_name, raw) => {
    expect(parseManagedDiscovery(raw).ok).toBe(false);
  });

  test("a rejection never echoes the record's credential", () => {
    const r = parseManagedDiscovery(record({ port: 80 }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason.length).toBeGreaterThan(0);
      expect(r.reason).not.toContain(FAKE_PW);
    }
  });
});

describe("destinationProblem: only 127.0.0.1 on a port this run owns", () => {
  const allowed = new Set([49152, 49153]);

  test.each([
    "http://127.0.0.1:49152/global/health",
    "http://127.0.0.1:49153/session?directory=%2Fa%20b",
  ])("control: %s is allowed", (url) => {
    expect(destinationProblem(url, allowed)).toBeUndefined();
  });

  test.each([
    ["a port the run does not own", "http://127.0.0.1:49154/x"],
    ["the default port (no explicit port)", "http://127.0.0.1/x"],
    ["localhost by name", "http://localhost:49152/x"],
    ["another loopback address", "http://127.0.0.2:49152/x"],
    ["IPv6 loopback", "http://[::1]:49152/x"],
    ["a non-loopback host", "http://192.0.2.10:49152/x"],
    ["https", "https://127.0.0.1:49152/x"],
    ["a file URL", "file:///etc/hosts"],
    ["userinfo in front of an allowed host", "http://u:p@127.0.0.1:49152/x"],
    ["an authority-confusion URL", "http://127.0.0.1:49152@example.test/x"],
    ["a malformed URL", "not a url"],
    ["an empty string", ""],
  ])("%s is refused", (_name, url) => {
    expect(destinationProblem(url, allowed)).toEqual(expect.any(String));
  });

  test("a refusal never echoes the URL's userinfo", () => {
    const p = destinationProblem(
      `http://u:${FAKE_PW}@127.0.0.1:49152/x`,
      allowed,
    );
    expect(p).toEqual(expect.any(String));
    expect(p).not.toContain(FAKE_PW);
  });

  test("an empty allow-list refuses everything", () => {
    expect(destinationProblem("http://127.0.0.1:49152/x", new Set())).toEqual(
      expect.any(String),
    );
  });
});

describe("createLoopbackHttp: a run-local client that enforces the destination allow-list before it connects", () => {
  const listener = (handler: (req: Request) => Response) => {
    let hits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        hits++;
        return handler(req);
      },
    });
    return {
      port: server.port as number,
      hits: () => hits,
      stop: () => server.stop(true),
    };
  };

  test("a fresh client allows nothing: an unlisted loopback port is refused without a request", async () => {
    const l = listener(() => Response.json({}));
    try {
      const r = await createLoopbackHttp().json(
        `http://127.0.0.1:${l.port}/x`,
        {},
      );
      expect(r.status).toBe(0);
      expect(String(r.body)).toContain("destination refused");
      expect(l.hits()).toBe(0);
    } finally {
      await l.stop();
    }
  });

  test("a non-loopback host is refused even when its port is listed", async () => {
    const net = createLoopbackHttp();
    net.allow(49152);
    const r = await net.json("http://192.0.2.10:49152/x", {});
    expect(r.status).toBe(0);
    expect(String(r.body)).toContain("destination refused");
  });

  test("allow-lists are per client: allowing a port on one client does not allow it on another", async () => {
    const l = listener(() => Response.json({ ok: true }));
    try {
      const a = createLoopbackHttp();
      const b = createLoopbackHttp();
      a.allow(l.port);
      expect((await a.json(`http://127.0.0.1:${l.port}/x`, {})).status).toBe(
        200,
      );
      expect((await b.json(`http://127.0.0.1:${l.port}/x`, {})).status).toBe(0);
      expect(l.hits()).toBe(1);
    } finally {
      await l.stop();
    }
  });

  test.each([0, 80, 1023, 65536, 1.5, Number.NaN])(
    "allow(%p) is rejected",
    (port) => {
      expect(() => createLoopbackHttp().allow(port)).toThrow();
    },
  );

  test("control: a listed loopback port is reached and its JSON returned", async () => {
    const l = listener(() => Response.json({ hello: "synthetic" }));
    try {
      const net = createLoopbackHttp();
      net.allow(l.port);
      const r = await net.json(`http://127.0.0.1:${l.port}/x`, {});
      expect(r).toEqual({ status: 200, body: { hello: "synthetic" } });
    } finally {
      await l.stop();
    }
  });

  test("a redirect is reported, never followed: it cannot leave the validated destination", async () => {
    // `elsewhere` is a second throwaway loopback listener that is NOT on the
    // allow-list; a followed redirect (with credentials) would land on it.
    const elsewhere = listener(() => Response.json({ reached: true }));
    const owned = listener(
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${elsewhere.port}/landing` },
        }),
    );
    try {
      const net = createLoopbackHttp();
      net.allow(owned.port);
      const r = await net.json(`http://127.0.0.1:${owned.port}/x`, {
        authorization: "Basic c3ludGhldGljOm5vbnNlY3JldA==",
      });
      expect(r.status).toBe(302);
      expect(owned.hits()).toBe(1);
      expect(elsewhere.hits()).toBe(0);
    } finally {
      await owned.stop();
      await elsewhere.stop();
    }
  });
});

describe("verifyManagedDiscovery: the file is checked against a port the harness reserved, never trusted for it", () => {
  const RESERVED = 49152;
  const WRAPPER = "/work/synthetic/managed-wrapper.sh";
  const BIN = "/work/synthetic/hosts/target/bin/opencode";
  const cmd = `/bin/sh ${WRAPPER} ${BIN} serve --hostname 127.0.0.1 --port ${RESERVED}`;
  const raw = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ port: RESERVED, pid: 4242, password: FAKE_PW, ...over });
  const run = (
    text: string,
    commandOf: (pid: number) => string = () => cmd,
    over: Partial<Parameters<typeof verifyManagedDiscovery>[1]> = {},
  ) =>
    verifyManagedDiscovery(text, {
      expectedPort: RESERVED,
      mustContain: [BIN, WRAPPER],
      commandOf,
      ...over,
    });

  test("control: the reserved port on a process that is our wrapper + target is accepted", () => {
    expect(run(raw())).toEqual({
      ok: true,
      value: { port: RESERVED, pid: 4242, password: FAKE_PW },
    });
  });

  test("a port the harness did not reserve is rejected before any process is inspected", () => {
    let inspected = 0;
    const r = run(raw({ port: RESERVED + 1 }), () => {
      inspected++;
      return cmd;
    });
    expect(r.ok).toBe(false);
    expect(inspected).toBe(0);
  });

  test("a file that only validates structurally is not enough: a different valid port still fails", () => {
    expect(parseManagedDiscovery(raw({ port: 50000 })).ok).toBe(true);
    expect(run(raw({ port: 50000 })).ok).toBe(false);
  });

  test.each([
    ["the process is gone", () => ""],
    [
      "the process is not this run's target",
      () => "/usr/bin/other --port 49152",
    ],
    [
      "the process lacks the wrapper",
      () => `${BIN} serve --hostname 127.0.0.1 --port ${RESERVED}`,
    ],
    [
      "the process runs on another port",
      () => `/bin/sh ${WRAPPER} ${BIN} serve --port ${RESERVED + 1}`,
    ],
    [
      "the port is only a prefix of the process's port",
      () => `/bin/sh ${WRAPPER} ${BIN} serve --port ${RESERVED}0`,
    ],
  ])("rejected when %s", (_name, commandOf) => {
    expect(run(raw(), commandOf).ok).toBe(false);
  });

  test("structural problems are rejected without inspecting any process", () => {
    let inspected = 0;
    const r = run(raw({ pid: 1 }), () => {
      inspected++;
      return cmd;
    });
    expect(r.ok).toBe(false);
    expect(inspected).toBe(0);
  });

  test("no rejection reason echoes the credential", () => {
    for (const r of [
      run(raw({ port: RESERVED + 1 })),
      run(raw(), () => ""),
      run(raw({ pid: 0 })),
    ]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).not.toContain(FAKE_PW);
    }
  });
});

// A value that no scrubber could recognise: no credential prefix, no key
// name, no path, no known secret. If it is persisted anywhere, the only reason
// is that the projection copied unrecognised host content.
const SENTINEL = "zebra quokka 7731 unexpected free text";
const SENTINEL_TOKEN = "zebraquokka7731";
const NONCE_A = "U2N-alpha0123456789";
const NONCE_B = "U2N-beta9876543210";
const known: HarnessKnown = {
  projects: new Set(["alpha", "beta"]),
  rosters: new Set(["managed-b"]),
  nonces: new Set([NONCE_A, NONCE_B]),
  dirs: { alpha: "/work/a", ws: "/work/ws" },
};
const persist = (v: unknown) =>
  renderEvidence(v, { swaps: [], secrets: new Set(), guard: [] });

describe("persisted flow/fixture/summary evidence is categorical: raw host content is not retained", () => {
  const step = (over: Record<string, unknown> = {}) => ({
    tool: "bus_task",
    args: { project: "alpha", prompt: `Reply with the nonce ${NONCE_A}.` },
    status: "completed",
    text: `Session ses_abc123 in /work/a\nACK ${NONCE_A}`,
    ...over,
  });
  const flow = (over: Record<string, unknown> = {}) =>
    ({
      name: "ext-ambient",
      sessionId: "ses_ctl001",
      outcome: "succeeded",
      steps: [step()],
      finalText: `done ${NONCE_B}`,
      problems: [],
      unreadable: [],
      ...over,
    }) as never;

  test("positive control: routing-relevant evidence survives as categories, ids and digests", () => {
    const out = projectFlowEvidence(
      flow({
        steps: [
          step(),
          step({
            tool: "bus_wait",
            args: {
              sessionIds: ["ses_abc123"],
              timeoutMs: 90_000,
              roster: "managed-b",
            },
            text: "waited",
          }),
        ],
        problems: ["controller model was never called"],
        unreadable: ["controller message list: HTTP 500"],
      }),
      known,
    );
    expect(out).toMatchObject({
      name: "ext-ambient",
      sessionId: "ses_ctl001",
      outcome: "succeeded",
      stepCount: 2,
      problems: ["controller model was never called"],
      unreadable: ["HTTP 500"],
    });
    expect(out.steps[0]).toMatchObject({
      tool: "bus_task",
      status: "completed",
      argKeys: ["project", "prompt"],
      project: "alpha",
      nonce: NONCE_A,
      result: {
        length: expect.any(Number),
        noncesSeen: [NONCE_A],
        dispatchedSession: "ses_abc123",
      },
    });
    expect(out.steps[0]?.result.sha256).toMatch(/^[0-9a-f]{16}$/);
    expect(out.steps[1]).toMatchObject({
      tool: "bus_wait",
      roster: "managed-b",
      sessionIds: ["ses_abc123"],
      timeoutMs: 90_000,
    });
    expect(out.finalText?.noncesSeen).toEqual([NONCE_B]);
  });

  test("a digest correlates equal content and distinguishes different content", () => {
    const a = projectFlowEvidence(flow(), known).steps[0]?.result.sha256;
    const same = projectFlowEvidence(flow(), known).steps[0]?.result.sha256;
    const other = projectFlowEvidence(
      flow({ steps: [step({ text: "different" })] }),
      known,
    ).steps[0]?.result.sha256;
    expect(a).toBe(same);
    expect(a).not.toBe(other);
  });

  test("an unexpected sentinel in every free-text field of a flow is not retained", () => {
    const out = persist(
      projectFlowEvidence(
        flow({
          name: SENTINEL_TOKEN,
          sessionId: SENTINEL_TOKEN,
          outcome: SENTINEL,
          steps: [
            step({
              tool: `bus_${SENTINEL_TOKEN}`,
              status: SENTINEL,
              args: {
                project: SENTINEL,
                roster: SENTINEL,
                prompt: `${SENTINEL} ${NONCE_A}`,
                sessionId: SENTINEL_TOKEN,
                sessionIds: [SENTINEL_TOKEN, SENTINEL],
                timeoutMs: SENTINEL,
                extra: SENTINEL,
              },
              text: `${SENTINEL} ses_abc123`,
              headers: { note: SENTINEL },
            }),
          ],
          finalText: SENTINEL,
          problems: [SENTINEL, `session create failed: ${SENTINEL}`],
          unreadable: [`controller message list: ${SENTINEL}`],
        }),
        known,
      ),
    );
    expect(out).not.toContain("zebra");
    expect(out).not.toContain("quokka");
    expect(out).not.toContain("7731");
    // ...while the harness-known parts of the same step are still there
    expect(out).toContain(NONCE_A);
  });

  test("an unexpected sentinel in a fixture request is not retained; roles, labels, known nonces and directories are", () => {
    const out = projectFixtureRequests(
      [
        {
          role: "target",
          label: "ext",
          hasTools: false,
          nonces: [NONCE_A, SENTINEL_TOKEN],
          cwd: "/work/a",
          decision: { text: `ACK ${NONCE_A}` },
        },
        {
          role: SENTINEL,
          label: SENTINEL,
          hasTools: SENTINEL,
          nonces: [SENTINEL],
          cwd: SENTINEL,
          decision: {
            text: SENTINEL,
            via: SENTINEL,
            step: SENTINEL,
            x: SENTINEL,
          },
          extra: SENTINEL,
        },
        {
          role: "controller",
          label: null,
          hasTools: true,
          nonces: [],
          cwd: null,
          decision: { via: "execute", step: 2, args: { a: SENTINEL } },
        },
      ],
      known,
    );
    expect(persist(out)).not.toContain("zebra");
    expect(out[0]).toMatchObject({
      role: "target",
      label: "ext",
      noncesSeen: [NONCE_A],
      otherNonces: 1,
      cwd: "alpha",
      decision: { kind: "text", ack: true },
    });
    expect(out[2]).toMatchObject({
      role: "controller",
      hasTools: true,
      decision: { kind: "tool", tool: "execute", step: 2 },
    });
  });

  test("an unexpected sentinel in a check's detail is not retained; the claim, verdict, digest and vocabulary reasons are", () => {
    const raw = projectCheckEvidence({
      name: "external target reports v1.17.13",
      kind: "harness",
      mode: "external",
      ok: false,
      detail: `${SENTINEL} (version 0.0.0 on ses_abc123)`,
    });
    expect(persist(raw)).not.toContain("zebra");
    expect(raw).toMatchObject({
      name: "external target reports v1.17.13",
      ok: false,
      unobserved: false,
      reasons: [],
      detail: {
        length: expect.any(Number),
        sha256: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    });
    const unobserved = projectCheckEvidence({
      name: "claim",
      kind: "u2",
      mode: "managed",
      ok: false,
      unobserved: true,
      detail: `NOT ESTABLISHED (evidence unreadable): a: ext session list for /d: HTTP 502; b: ${SENTINEL}; c: entry 3 is malformed; d: entry 1 part 0 is a text part without a string \`text\``,
    });
    expect(unobserved.reasons).toEqual([
      "HTTP 502",
      "entry 3 is malformed",
      "entry 1 part 0 is a text part without a string `text`",
    ]);
    expect(persist(unobserved)).not.toContain("zebra");
  });

  test("unexpected sentinels in teardown, preflight and thrown messages are not retained", () => {
    const probe = { status: 1, stdout: SENTINEL, stderr: `Error: ${SENTINEL}` };
    const out = persist({
      teardown: projectTeardown({
        controller: { error: SENTINEL },
        weird: SENTINEL,
        ok: { stopped: true, portClosed: true, note: SENTINEL },
        reapedLeakedTargets: 0,
      }),
      preflight: projectPreflight({
        command: "static",
        sandboxed: probe,
        control: probe,
        available: false,
        inconclusive: true,
      }),
      fatal: fatalCategory(`build failed: ${SENTINEL}`),
    });
    expect(out).not.toContain("zebra");
    expect(JSON.parse(out).teardown.ok).toEqual({
      stopped: true,
      portClosed: true,
    });
    expect(JSON.parse(out).preflight.sandboxed).toEqual({
      status: 1,
      stdoutBytes: SENTINEL.length,
      stderrKind: "other",
    });
    expect(fatalCategory("global deadline hit waiting for x")).toBe(
      "global deadline hit",
    );
  });

  test("recognizedReasons keeps only the closed vocabulary, even when a clause is nearly one", () => {
    expect(
      recognizedReasons(
        `x: HTTP 404; ${SENTINEL}; y: request failed or timed out (${SENTINEL}); z: HTTP 404 ${SENTINEL}; session create failed (status 500)`,
      ),
    ).toEqual(["HTTP 404", "session create failed (status 500)"]);
    expect(
      recognizedReasons("request failed or timed out (destination refused)"),
    ).toEqual(["request failed or timed out (destination refused)"]);
  });

  test("the reasons the readers themselves produce never carry response or error content", () => {
    const hostile = [
      { status: 0, body: `Error ${SENTINEL} http://127.0.0.1:1/x` },
      { status: 500, body: { error: SENTINEL } },
      { status: 200, body: SENTINEL },
      { status: 200, body: { sessions: SENTINEL } },
      { status: 200, body: [{ id: 3, directory: SENTINEL }] },
      { status: 200, body: [{ info: { role: SENTINEL }, parts: [] }] },
      {
        status: 200,
        body: [
          {
            info: { role: "user" },
            parts: [{ type: SENTINEL }, { text: SENTINEL }],
          },
        ],
      },
      {
        status: 200,
        body: [
          {
            info: { role: "user" },
            parts: [{ type: "text", text: 5, note: SENTINEL }],
          },
        ],
      },
    ];
    for (const r of hostile) {
      for (const o of [
        readSessionList(r, "what"),
        readTranscript(r, "what"),
        readControllerMessages(r),
      ]) {
        if (!o.ok) {
          expect(o.reason).not.toContain("zebra");
          // and every reason is actionable: the vocabulary recognises it
          expect(recognizedReasons(o.reason).length).toBeGreaterThan(0);
        }
      }
    }
    const log = readFixtureRequests([{ role: SENTINEL, nonces: SENTINEL }]);
    expect(log.ok ? "" : log.reason).not.toContain("zebra");
    expect(transportFailure(`Error ${SENTINEL}`)).toBe("connection failed");
    expect(transportFailure("TimeoutError: aborted")).toBe("timed out");
    expect(transportFailure("destination refused: host x")).toBe(
      "destination refused",
    );
  });

  test("the number of persisted steps is bounded but their count is still reported", () => {
    const steps = Array.from({ length: 500 }, () => step());
    const out = projectFlowEvidence(flow({ steps }), known);
    expect(out.steps.length).toBe(64);
    expect(out.stepCount).toBe(500);
  });
});

describe("wiring: every persisted file is written from a projection", () => {
  const src = readFileSync(
    new URL("../scripts/verify-controller-delegation.ts", import.meta.url),
    "utf8",
  );
  test.each([
    "projectFlowEvidence(f, known)",
    "projectFixtureRequests(fixture?.requests, known)",
    'evidence.write("preflight.json", projectPreflight(preflight))',
    "preflight: projectPreflight(preflight)",
    "teardown: projectTeardown(teardown)",
    "checks: checks.map(projectCheckEvidence)",
  ])("%s", (needle) => {
    expect(src).toContain(needle);
  });
  test("raw argv, raw fixture requests and raw host identity lists are not copied into the manifest", () => {
    expect(src).not.toContain("argv.join");
    expect(src).not.toMatch(
      /evidence\.write\("fixture-requests\.json", fixture/,
    );
    expect(src).not.toContain("identity: hosts.identity,");
  });
});

describe("wiring: the discovery file never decides the destination", () => {
  const src = readFileSync(
    new URL("../scripts/verify-controller-delegation.ts", import.meta.url),
    "utf8",
  );
  test("the managed port is reserved by the harness, written into the roster, and the file is verified against it", () => {
    expect(src).toContain("port: managedPort");
    expect(src).toContain("expectedPort: managedPort");
    expect(src).not.toMatch(/allowPort\(\s*discovery/);
    expect(src).not.toMatch(/allow\(\s*discovery/);
  });
  test("no process-global allow-list is exported", () => {
    expect(src).not.toMatch(/export const allowedPorts/);
  });
});

describe("isSafeSessionId: a network-derived id is a path segment, nothing else", () => {
  test.each(["ses_abc123", "ses_ABCdef0123456789", "a-b_c"])(
    "control: %s is accepted",
    (id) => {
      expect(isSafeSessionId(id)).toBe(true);
    },
  );
  test.each([
    "",
    "../x",
    "a/b",
    "a?b=c",
    "a#b",
    "a b",
    "a\nb",
    "a%2fb",
    "x".repeat(129),
  ])("%j is rejected", (id) => {
    expect(isSafeSessionId(id)).toBe(false);
  });
  test("non-strings are rejected", () => {
    expect(isSafeSessionId(undefined)).toBe(false);
    expect(isSafeSessionId(7)).toBe(false);
    expect(isSafeSessionId(null)).toBe(false);
  });
});

describe("renderEvidence: what is persisted is bounded and scrubbed", () => {
  const render = (
    value: unknown,
    over: Partial<Parameters<typeof renderEvidence>[1]> = {},
  ) =>
    renderEvidence(value, {
      swaps: [["/work/synthetic-run", "<work>"]],
      secrets: new Set([FAKE_PW]),
      guard: ["/work/synthetic-run", FAKE_PW],
      ...over,
    });

  test("control: ordinary routing evidence is preserved verbatim", () => {
    const value = {
      name: "ext-ambient",
      steps: [
        {
          tool: "bus_task",
          args: { project: "alpha", prompt: "ping U2N-alpha0123456789" },
          text: "Session ses_abc in /work-ish ACK U2N-alpha0123456789",
        },
      ],
      ok: true,
      n: 3,
      missing: null,
    };
    expect(JSON.parse(render(value))).toEqual(value);
  });

  test("known secrets are redacted wherever they appear, keys included", () => {
    const out = render({
      [`k-${FAKE_PW}`]: `line ${FAKE_PW} end`,
      a: [FAKE_PW],
    });
    expect(out).not.toContain(FAKE_PW);
    expect(out).toContain("<redacted>");
  });

  test("a secret cannot survive truncation by straddling the cut", () => {
    // Place the secret so a fixed-size cut would split it in half.
    const filler = "x".repeat(3990);
    const out = render({ text: `${filler}${FAKE_PW}${"y".repeat(500)}` });
    expect(out).not.toContain(FAKE_PW);
    expect(out).not.toContain(FAKE_PW.slice(0, 10));
  });

  test("oversized strings are bounded and say so", () => {
    const out = JSON.parse(render({ text: "z".repeat(50_000) })) as {
      text: string;
    };
    expect(out.text.length).toBeLessThan(5_000);
    expect(out.text).toContain("truncated");
  });

  test("credential-named keys are redacted whatever their value", () => {
    const out = JSON.parse(
      render({
        Authorization: "synthetic-header-value",
        password: "synthetic-other",
        headers: { "x-api-key": "synthetic-key", Cookie: "a=b" },
        keep: "visible",
      }),
    ) as Record<string, unknown>;
    expect(out["Authorization"]).toBe("<redacted>");
    expect(out["password"]).toBe("<redacted>");
    expect(out["headers"]).toEqual({
      "x-api-key": "<redacted>",
      Cookie: "<redacted>",
    });
    expect(out["keep"]).toBe("visible");
  });

  test("credential-shaped text is redacted even when it is not a known secret", () => {
    const b64 = Buffer.from("opencode:synthetic-unknown").toString("base64");
    const out = render({
      a: `authorization: Basic ${b64}`,
      b: "Bearer synthetic.token.value-0123456789",
      c: "see http://user:synthetic-pass@127.0.0.1:1/x now",
      d: "GET /x?token=synthetic-q&keep=1 HTTP/1.1",
    });
    expect(out).not.toContain(b64);
    expect(out).not.toContain("synthetic.token.value");
    expect(out).not.toContain("synthetic-pass");
    expect(out).not.toContain("synthetic-q");
    expect(out).toContain("keep=1");
  });

  test("local paths are swapped and home-style paths are anonymised", () => {
    const out = render({
      p: "/work/synthetic-run/hosts/x and /Users/someone/secret-dir",
    });
    expect(out).toContain("<work>/hosts/x");
    expect(out).toContain("/Users/<user>/secret-dir");
    expect(out).not.toContain("/work/synthetic-run");
    expect(out).not.toContain("someone");
  });

  test("control characters are stripped from network-derived strings", () => {
    const out = JSON.parse(render({ t: "a\u0000b\u001b[31mc\nd" })) as {
      t: string;
    };
    const codes = [...out.t].map((ch) => ch.charCodeAt(0));
    expect(codes.some((c) => c < 0x20 && c !== 0x0a && c !== 0x09)).toBe(false);
    expect(out.t).toContain("\n");
  });

  test("the leak guard still fails closed on a needle the scrubbers did not catch", () => {
    expect(() =>
      render(
        { t: "mentions /srv/synthetic-guarded-path here" },
        { guard: ["/srv/synthetic-guarded-path"] },
      ),
    ).toThrow("leak guard tripped");
  });

  test("the guard error does not echo the needle or the value", () => {
    try {
      render(
        { t: "mentions /srv/synthetic-guarded-path here" },
        { guard: ["/srv/synthetic-guarded-path"] },
      );
      throw new Error("expected the guard to trip");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("synthetic-guarded");
    }
  });
});

describe("classifyPreflight: a failed control cannot attribute the failure to the sandbox", () => {
  const good: ProbeRun = {
    status: 0,
    stdout: "Mon Jan  1 00:00:00 2024 node",
    stderr: "",
  };
  const denied: ProbeRun = {
    status: 1,
    stdout: "",
    stderr: "Error: Operation not permitted",
  };
  const emptyOk: ProbeRun = { status: 0, stdout: "", stderr: "" };
  const timedOut: ProbeRun = { status: null, stdout: "", stderr: "" };

  test("sandboxed ps works: available, conclusive", () => {
    expect(classifyPreflight(good, good)).toEqual({
      available: true,
      inconclusive: false,
    });
  });
  test("sandboxed ps denied but the control works: BLOCKED is attributable", () => {
    expect(classifyPreflight(denied, good)).toEqual({
      available: false,
      inconclusive: false,
    });
  });
  test("both fail: inconclusive, not available", () => {
    expect(classifyPreflight(denied, denied)).toEqual({
      available: false,
      inconclusive: true,
    });
  });
  test.each([
    ["exit 0 with no output", emptyOk],
    ["a timeout / signal (null status)", timedOut],
  ])("a control with %s does not count as working", (_n, ctl) => {
    expect(classifyPreflight(denied, ctl).inconclusive).toBe(true);
  });
  test("an unsandboxed control failure does not undo a working sandboxed ps", () => {
    expect(classifyPreflight(good, denied)).toEqual({
      available: true,
      inconclusive: false,
    });
  });
});

describe("summarize: an inconclusive preflight is exit 1, never BLOCKED/3", () => {
  const c = (over: Partial<Check> = {}): Check => ({
    name: "n",
    kind: "u2",
    mode: "external",
    ok: true,
    ...over,
  });
  const inconclusive = { available: false, inconclusive: true };
  const blocked = { available: false, inconclusive: false };
  const both = { preflightOnly: false, modeArg: "both" as const };

  test("external passed + inconclusive preflight: managed INCONCLUSIVE, exit 1", () => {
    const r = summarize({ ...both, checks: [c()], preflight: inconclusive });
    expect([r.externalStatus, r.managedStatus, r.exit]).toEqual([
      "PASS",
      "INCONCLUSIVE",
      1,
    ]);
  });

  test("--preflight-only: inconclusive is exit 1, attributable block stays 3", () => {
    const po = { preflightOnly: true, modeArg: "both" as const, checks: [] };
    expect(summarize({ ...po, preflight: inconclusive }).exit).toBe(1);
    expect(summarize({ ...po, preflight: blocked }).exit).toBe(3);
  });

  test("control: an attributable block with passing external is still BLOCKED, exit 3", () => {
    const r = summarize({ ...both, checks: [c()], preflight: blocked });
    expect([r.managedStatus, r.exit]).toEqual(["BLOCKED", 3]);
  });

  test("a confirmed external failure still outranks an inconclusive preflight (exit 2)", () => {
    const r = summarize({
      ...both,
      checks: [c({ ok: false })],
      preflight: inconclusive,
    });
    expect(r.exit).toBe(2);
  });

  test("--mode external never consults the preflight", () => {
    const r = summarize({
      checks: [c()],
      preflight: inconclusive,
      preflightOnly: false,
      modeArg: "external",
    });
    expect([r.managedStatus, r.exit]).toEqual(["NOT-RUN (--mode external)", 0]);
  });

  test("a preflight without the inconclusive field keeps its old meaning", () => {
    const r = summarize({
      ...both,
      checks: [c()],
      preflight: { available: false },
    });
    expect([r.managedStatus, r.exit]).toEqual(["BLOCKED", 3]);
  });
});

describe("console log rendering is categorical too: raw host content is not echoed", () => {
  const hostileFlow = {
    name: "ext-ambient",
    sessionId: "ses_ctl001",
    outcome: SENTINEL,
    steps: [
      {
        tool: "bus_task",
        args: {
          project: "alpha",
          prompt: `${SENTINEL} ${NONCE_A}`,
          extra: SENTINEL,
        },
        status: SENTINEL,
        text: `${SENTINEL}\nSession ses_abc123 in /work/a ACK ${NONCE_A}`,
      },
      { tool: SENTINEL, args: {}, status: null, text: SENTINEL },
    ],
    finalText: SENTINEL,
    problems: [SENTINEL, "controller model was never called"],
    unreadable: [`controller message list: ${SENTINEL}`],
  } as never;

  test("a flow logs phase, outcome and owned correlation, never its text, prompt or free fields", () => {
    const lines = renderFlowLog(hostileFlow, known);
    const out = lines.join("\n");
    expect(out).not.toContain("zebra");
    expect(out).not.toContain("quokka");
    expect(out).toContain("flow ext-ambient: outcome=other steps=2");
    expect(out).toContain("controller model was never called");
    expect(lines[1]).toContain("bus_task");
    expect(lines[1]).toContain("project=alpha");
    expect(lines[1]).toContain(`nonce=${NONCE_A}`);
    expect(lines[1]).toContain("session=ses_abc123");
    expect(lines[1]).toMatch(/result=\d+ chars #[0-9a-f]{8}/);
  });

  test("a failed check logs its claim, recognised reasons and a detail digest, never the detail", () => {
    const failed = renderCheckLog({
      name: "external target reports v1.17.13",
      kind: "harness",
      mode: "external",
      ok: false,
      detail: `${SENTINEL} (HTTP 500 body)`,
    });
    expect(failed).not.toContain("zebra");
    expect(failed).toContain("FAIL [harness/external] external target reports");
    expect(failed).toMatch(/detail \d+ chars #[0-9a-f]{8}/);
    const unobserved = renderCheckLog({
      name: "claim",
      kind: "u2",
      mode: "managed",
      ok: false,
      unobserved: true,
      detail: `NOT ESTABLISHED (evidence unreadable): a: HTTP 502; b: ${SENTINEL}`,
    });
    expect(unobserved).toContain("UNOBSERVED [u2/managed] claim — HTTP 502");
    expect(unobserved).not.toContain("zebra");
    const passed = renderCheckLog({
      name: "claim",
      kind: "u2",
      mode: "external",
      ok: true,
      detail: SENTINEL,
    });
    expect(passed).toBe("ok   [u2/external] claim");
  });

  test("preflight, self-test and thrown errors log as categories", () => {
    const probe = { status: 1, stdout: SENTINEL, stderr: `Error: ${SENTINEL}` };
    expect(
      renderPreflightLog({
        command: "static",
        sandboxed: probe,
        control: probe,
        available: false,
        inconclusive: true,
      }),
    ).not.toContain("zebra");
    const selfTest = renderSelfTestLog({
      ok: false,
      checks: { readHomeDenied: true, externalIpDenied: false },
      sandboxed: { readHome: SENTINEL },
    } as never);
    expect(selfTest).toBe(
      "sandbox self-test: ok=false failed=[externalIpDenied]",
    );
    const withPath = Object.assign(
      new Error(`ENOENT: no such file '/Users/someone/${SENTINEL_TOKEN}'`),
      { code: "ENOENT" },
    );
    expect(errorCategory(withPath)).toBe("filesystem error ENOENT");
    expect(errorCategory(new Error(`build failed: ${SENTINEL}`))).toBe(
      "harness step failed",
    );
    expect(errorCategory(SENTINEL)).toBe("harness step failed");
    expect(
      errorCategory(new Error("refusing to persist: leak guard tripped")),
    ).toBe("leak guard tripped");
    expect(errorCategory(new Error("OS sandbox self-test failed"))).toBe(
      "OS sandbox self-test failed",
    );
  });

  test("control characters in a harness-authored name cannot forge a second log line", () => {
    const line = renderCheckLog({
      name: "a\nFAKE [harness/external] forged",
      kind: "harness",
      mode: "external",
      ok: true,
    });
    expect(line).not.toContain("\n");
  });

  describe("wiring: every console write goes through a renderer", () => {
    const src = readFileSync(
      new URL("../scripts/verify-controller-delegation.ts", import.meta.url),
      "utf8",
    );
    test.each([
      "log(renderCheckLog(c))",
      "renderFlowLog(f, known)",
      "log(renderPreflightLog(preflight))",
      "log(renderSelfTestLog(selfTest))",
      "throw new Error(errorCategory(e))",
      "log(`unhandled: ",
    ])("%s", (needle) => {
      expect(src).toContain(needle);
    });
    test("no log() call interpolates a raw detail, text, body, message, stream or whole object", () => {
      const calls = [...src.matchAll(/(?<![\w.])log\(([\s\S]*?)\);\n/g)].map(
        (m) => m[1] ?? "",
      );
      expect(calls.length).toBeGreaterThan(10);
      for (const call of calls) {
        expect(call).not.toMatch(
          /\.(detail|text|body|message|stderr|stdout|finalText|args)\b/,
        );
        expect(call).not.toMatch(/JSON\.stringify\((selfTest|preflight|f\b)/);
      }
    });
  });
});
