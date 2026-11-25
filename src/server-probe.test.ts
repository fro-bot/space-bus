import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ServerStatus } from "./server";
import { probe, superviseServer } from "./server";

// Synthetic URLs and a recording fetch stub only: nothing here connects to a
// network or authenticates against a real server.

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init: RequestInit }>;

function stubFetch(respond: () => Response | Promise<Response>): void {
  calls = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("probe (authenticated managed-server readiness probe)", () => {
  test("keeps its outcome contract for the legitimate loopback forms", async () => {
    for (const [baseUrl, port] of [
      ["http://127.0.0.1:4096", 4096],
      ["http://[::1]:5000", 5000],
      ["http://localhost:6001", 6001],
    ] as const) {
      stubFetch(() => new Response(null, { status: 200 }));
      expect(await probe(baseUrl, "pw", port)).toBe("ready");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe(`${baseUrl}/session?limit=1`);
      expect(calls[0]?.init.headers).toEqual({
        authorization: `Basic ${Buffer.from("opencode:pw").toString("base64")}`,
      });
    }
    stubFetch(() => new Response(null, { status: 401 }));
    expect(await probe("http://127.0.0.1:4096", "pw")).toBe("auth-failure");
    stubFetch(() => new Response(null, { status: 403 }));
    expect(await probe("http://127.0.0.1:4096", "pw")).toBe("auth-failure");
    stubFetch(() => new Response(null, { status: 503 }));
    expect(await probe("http://127.0.0.1:4096", "pw")).toBe("retry");
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probe("http://127.0.0.1:4096", "pw")).toBe("retry");
  });

  test("never follows a redirect, and a redirect is not readiness", async () => {
    stubFetch(
      () =>
        new Response(null, {
          status: 307,
          headers: { location: "http://203.0.113.9/elsewhere" }, // TEST-NET-3
        }),
    );
    expect(await probe("http://127.0.0.1:4096", "pw", 4096)).toBe("retry");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
  });

  test.each([
    ["URL port differs from the expected port", "http://127.0.0.1:4097", 4096],
    ["userinfo in the URL", "http://u:p@127.0.0.1:4096", 4096],
    ["https scheme", "https://127.0.0.1:4096", 4096],
    ["non-loopback host", "http://example.com:4096", 4096],
    ["path component", "http://127.0.0.1:4096/other", 4096],
    ["query component", "http://127.0.0.1:4096?x=1", 4096],
    ["malformed URL", "not a url", 4096],
  ] as const)(
    "sends nothing and returns retry when %s",
    async (_name, baseUrl, port) => {
      stubFetch(() => new Response(null, { status: 200 }));
      expect(await probe(baseUrl, "pw", port)).toBe("retry");
      expect(calls).toEqual([]); // the Authorization header is never attached
    },
  );

  test("without an expected port it still enforces the managed origin shape", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await probe("http://u:p@127.0.0.1:4096", "pw")).toBe("retry");
    expect(await probe("http://example.com:4096", "pw")).toBe("retry");
    expect(calls).toEqual([]);
  });
});

describe("probe request URL for accepted terminal-slash forms", () => {
  test.each([
    ["http://127.0.0.1:4096/", 4096, "http://127.0.0.1:4096/session?limit=1"],
    ["http://[::1]:5000/", 5000, "http://[::1]:5000/session?limit=1"],
    ["http://localhost:6001/", 6001, "http://localhost:6001/session?limit=1"],
    ["http://127.0.0.1:4096", 4096, "http://127.0.0.1:4096/session?limit=1"],
  ] as const)("%s requests exactly %s", async (baseUrl, port, expected) => {
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await probe(baseUrl, "pw", port)).toBe("ready");
    expect(calls.map((c) => c.url)).toEqual([expected]);
    expect(calls[0]?.url).not.toContain("//session");
  });

  test("a doubled terminal slash is still refused, not trimmed into acceptance", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    expect(await probe("http://127.0.0.1:4096//", "pw", 4096)).toBe("retry");
    expect(calls).toEqual([]);
  });
});

describe("superviseServer forwards the recorded port to the real probe", () => {
  const handle = (baseUrl: string, port: number) => ({
    baseUrl,
    credentials: { username: "opencode", password: "pw" },
    pid: 12345, // synthetic: no signal is ever sent (status is injected, stop is injected)
    port,
  });
  const alive = (): ServerStatus => ({ running: true, pid: 12345 });

  test("a handle whose URL port differs from its recorded port never reaches the network and ends as hung", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    let stopCalls = 0;
    let checks = 0;
    const outcome = await superviseServer(
      "/synthetic/spacebus.json",
      handle("http://127.0.0.1:4096", 4097), // mismatched on purpose
      {
        sleep: async () => {},
        status: alive,
        threshold: 2,
        // Safety net: if the port were not forwarded the probe would succeed
        // forever; bound the loop so that regression fails instead of hanging.
        shouldStop: () => {
          checks += 1;
          return checks > 10;
        },
        stop: async () => {
          stopCalls += 1;
          return { stopped: true };
        },
        // no `probe` override: the real probe runs
      },
    );
    expect(outcome).toEqual({ reason: "hung" });
    expect(calls).toEqual([]); // the credential was never attached to a request
    expect(stopCalls).toBe(1);
  });

  test("a consistent handle is probed once per tick at the exact session URL, even with a terminal slash", async () => {
    stubFetch(() => new Response(null, { status: 200 }));
    let checks = 0;
    const outcome = await superviseServer(
      "/synthetic/spacebus.json",
      handle("http://127.0.0.1:4096/", 4096),
      {
        sleep: async () => {},
        status: alive,
        stop: async () => ({ stopped: true }),
        // lets exactly one tick run: top-of-loop check, then post-tick check
        shouldStop: () => {
          checks += 1;
          return checks > 1;
        },
      },
    );
    expect(outcome).toEqual({ reason: "signal" });
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session?limit=1",
    ]);
    expect(calls[0]?.init.redirect).toBe("manual");
  });
});
