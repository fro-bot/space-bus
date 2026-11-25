import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { probe } from "./server";

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
