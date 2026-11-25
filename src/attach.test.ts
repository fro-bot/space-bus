import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AttachSeams } from "./attach";
import { posixJoin, resolveManagedServer } from "./attach";
import { discoveryFilePath } from "./discovery";

async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

const ROSTER_PATH = "/home/marcus/proj/spacebus.json";
const DISCOVERY_JSON = JSON.stringify({
  port: 4096,
  pid: 1234,
  identity: "test-identity",
  password: "test-password",
  spawnConfig: { command: ["harness", "serve"] },
  baseUrl: "http://127.0.0.1:4096",
});

function stubFetch(fn: (url: string) => Promise<Response>): void {
  // biome-ignore lint/suspicious/noExplicitAny: test stub, full fetch surface not needed
  globalThis.fetch = fn as any;
}

function makeSeams(overrides: Partial<AttachSeams> = {}): AttachSeams {
  return {
    realpath: async (p) => p,
    readTextFile: async () => DISCOVERY_JSON,
    env: async () => null,
    homeDir: async () => "/home/marcus",
    ...overrides,
  };
}

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveManagedServer", () => {
  test("happy path: valid discovery + 200 on /session -> ok, alive:true", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/session");
      return new Response(null, { status: 200 });
    });

    const seams = makeSeams({
      realpath: async (p) => (p.endsWith("spacebus.json") ? ROSTER_PATH : null),
    });

    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.baseUrl).toBe("http://127.0.0.1:4096");
      expect(result.credentials).toEqual({
        username: "opencode",
        password: "test-password",
      });
      expect(result.alive).toBe(true);
    }
  });

  test("no discovery file -> ok:false, actionable 'not running' message", async () => {
    const seams = makeSeams({ readTextFile: async () => null });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not running");
    }
  });

  test("malformed discovery JSON -> ok:false", async () => {
    const seams = makeSeams({ readTextFile: async () => "{not json" });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
  });

  test("schema-invalid discovery JSON -> ok:false", async () => {
    const seams = makeSeams({
      readTextFile: async () => JSON.stringify({ foo: "bar" }),
    });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
  });

  test("non-loopback baseUrl -> ok:false, off-machine refusal", async () => {
    const seams = makeSeams({
      readTextFile: async () =>
        JSON.stringify({
          port: 4096,
          pid: 1234,
          identity: "x",
          password: "p",
          spawnConfig: {},
          baseUrl: "http://example.com:4096",
        }),
    });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("off-machine");
    }
  });

  function discoveryWith(baseUrl: string, port: number): string {
    return JSON.stringify({
      port,
      pid: 1234,
      identity: "test-identity",
      password: "test-password",
      spawnConfig: { command: ["harness", "serve"] },
      baseUrl,
    });
  }

  test.each([
    ["http://[::1]:5000", 5000],
    ["http://localhost:6001", 6001],
    ["http://127.0.0.1:4096", 4096],
  ] as const)(
    "attaches to the legitimate loopback form %s with the URL unchanged",
    async (baseUrl, port) => {
      const seen: string[] = [];
      stubFetch(async (url) => {
        seen.push(String(url));
        return new Response(null, { status: 200 });
      });
      const result = await resolveManagedServer(
        "/home/marcus/proj",
        makeSeams({ readTextFile: async () => discoveryWith(baseUrl, port) }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.baseUrl).toBe(baseUrl);
      expect(seen).toEqual([`${baseUrl}/session?limit=1`]);
    },
  );

  test.each([
    ["URL port differs from the recorded port", "http://127.0.0.1:4097", 4096],
    ["userinfo in the URL", "http://u:p@127.0.0.1:4096", 4096],
    ["https scheme", "https://127.0.0.1:4096", 4096],
    ["path component", "http://127.0.0.1:4096/other", 4096],
    ["query component", "http://127.0.0.1:4096?x=1", 4096],
    ["non-canonical host spelling", "http://0x7f.1:4096", 4096],
  ] as const)(
    "fails closed with NO request when %s",
    async (_name, baseUrl, port) => {
      let fetchCalls = 0;
      stubFetch(async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      });
      const result = await resolveManagedServer(
        "/home/marcus/proj",
        makeSeams({ readTextFile: async () => discoveryWith(baseUrl, port) }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("refusing to send credentials");
        expect(result.error).not.toContain("test-password");
        expect(result.error).not.toContain("u:p"); // never echo URL userinfo
      }
      expect(fetchCalls).toBe(0);
    },
  );

  test.each([
    ["http://127.0.0.1:4096/", 4096, "http://127.0.0.1:4096/session?limit=1"],
    ["http://[::1]:5000/", 5000, "http://[::1]:5000/session?limit=1"],
  ] as const)(
    "accepted terminal-slash %s requests exactly %s",
    async (baseUrl, port, expected) => {
      const seen: string[] = [];
      stubFetch(async (url) => {
        seen.push(String(url));
        return new Response(null, { status: 200 });
      });
      const result = await resolveManagedServer(
        "/home/marcus/proj",
        makeSeams({ readTextFile: async () => discoveryWith(baseUrl, port) }),
      );
      expect(result.ok).toBe(true);
      expect(seen).toEqual([expected]);
      // The returned (and requested) endpoint is the canonical origin, not the
      // recorded spelling; the record itself is not rewritten.
      if (result.ok) {
        expect(result.baseUrl).toBe(expected.replace("/session?limit=1", ""));
      }
    },
  );

  // Parity with discovery.ts: Zod's url() trims these into a valid URL, but the
  // RAW recorded spelling is what must be canonical (checked before Zod's
  // normalization), so both readers refuse them identically.
  test.each([
    ["leading whitespace", " http://127.0.0.1:4096"],
    ["trailing tab", "http://127.0.0.1:4096\t"],
    ["embedded newline", "http://127.0.0.1:4096/\n"],
  ] as const)(
    "raw spelling with %s is refused before any request",
    async (_name, rawBaseUrl) => {
      let fetchCalls = 0;
      stubFetch(async () => {
        fetchCalls += 1;
        return new Response(null, { status: 200 });
      });
      const result = await resolveManagedServer(
        "/home/marcus/proj",
        makeSeams({
          readTextFile: async () => discoveryWith(rawBaseUrl, 4096),
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("refusing to send credentials");
        expect(result.error).not.toContain("test-password");
      }
      expect(fetchCalls).toBe(0);
    },
  );

  test("a differently-spelled but accepted record resolves to the canonical origin in the result and the request", async () => {
    const seen: string[] = [];
    stubFetch(async (url) => {
      seen.push(String(url));
      return new Response(null, { status: 200 });
    });
    const result = await resolveManagedServer(
      "/home/marcus/proj",
      makeSeams({
        readTextFile: async () => discoveryWith("http://LOCALHOST:6001/", 6001),
      }),
    );
    expect(result.ok && result.baseUrl).toBe("http://localhost:6001");
    expect(seen).toEqual(["http://localhost:6001/session?limit=1"]);
  });

  test("the authenticated liveness probe does not follow redirects", async () => {
    const inits: RequestInit[] = [];
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      return new Response(null, {
        status: 302,
        headers: { location: "http://203.0.113.9/steal" }, // TEST-NET-3, synthetic
      });
    }) as unknown as typeof fetch;
    const result = await resolveManagedServer("/home/marcus/proj", makeSeams());
    expect(inits).toHaveLength(1);
    expect(inits[0]?.redirect).toBe("manual");
    expect(result.ok).toBe(false); // a redirect is not "alive"
  });

  test("stale/mismatched creds: fetch->401 -> ok:false, rejected credentials", async () => {
    stubFetch(async () => new Response(null, { status: 401 }));
    const seams = makeSeams();
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("rejected credentials");
    }
  });

  test("dead daemon: fetch throws -> ok:false, 'not answering' message", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const seams = makeSeams();
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not answering");
    }
  });

  test("SPACE_BUS_CONFIG override: resolver hashes that path", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    const overridePath = "/custom/roster.json";
    const seenPaths: string[] = [];
    const seams = makeSeams({
      env: async (name) => (name === "SPACE_BUS_CONFIG" ? overridePath : null),
      realpath: async (p) => p,
      readTextFile: async (p) => {
        seenPaths.push(p);
        return DISCOVERY_JSON;
      },
    });

    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(true);

    const expectedHash = await sha256Hex16(overridePath);
    expect(seenPaths).toHaveLength(1);
    expect(seenPaths[0]).toContain(expectedHash);
    expect(seenPaths[0]).not.toContain(
      await sha256Hex16("/home/marcus/proj/spacebus.json"),
    );
  });

  test("hash correctness: discovery path uses first-16-hex-of-sha256(rosterPath) layout", async () => {
    const readPaths: string[] = [];
    stubFetch(async () => new Response(null, { status: 200 }));
    const seams = makeSeams({
      realpath: async () => ROSTER_PATH,
      readTextFile: async (p) => {
        readPaths.push(p);
        return DISCOVERY_JSON;
      },
      env: async (name) =>
        name === "XDG_STATE_HOME" ? "/home/marcus/.state" : null,
    });

    await resolveManagedServer("/home/marcus/proj", seams);

    const expectedHash = await sha256Hex16(ROSTER_PATH);
    expect(readPaths[0]).toBe(
      `/home/marcus/.state/space-bus/${expectedHash}/discovery.json`,
    );
  });

  test("SPACE_BUS_CONFIG override: '~/foo/spacebus.json' expands to <home>/foo/... and hashes the expanded path", async () => {
    stubFetch(async () => new Response(null, { status: 200 }));
    const seenPaths: string[] = [];
    const expandedRosterPath = "/home/marcus/foo/spacebus.json";
    const seams = makeSeams({
      env: async (name) =>
        name === "SPACE_BUS_CONFIG" ? "~/foo/spacebus.json" : null,
      homeDir: async () => "/home/marcus",
      realpath: async (p) => p,
      readTextFile: async (p) => {
        seenPaths.push(p);
        return DISCOVERY_JSON;
      },
    });

    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(true);

    const expectedHash = await sha256Hex16(expandedRosterPath);
    expect(seenPaths).toHaveLength(1);
    expect(seenPaths[0]).toContain(expectedHash);
  });

  test("SPACE_BUS_CONFIG override: a URL value -> actionable error", async () => {
    const seams = makeSeams({
      env: async (name) =>
        name === "SPACE_BUS_CONFIG" ? "https://example.com/roster.json" : null,
    });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("absolute filesystem path");
      expect(result.error).toContain("URL");
    }
  });

  test("SPACE_BUS_CONFIG override: a relative value -> actionable error", async () => {
    const seams = makeSeams({
      env: async (name) =>
        name === "SPACE_BUS_CONFIG" ? "relative/roster.json" : null,
    });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("absolute filesystem path");
    }
  });

  test("no spacebus.json at candidate path -> ok:false, actionable error", async () => {
    const seams = makeSeams({ realpath: async () => null });
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("no spacebus.json");
    }
  });

  test("non-401 non-2xx probe response -> ok:false, 'not answering' message", async () => {
    stubFetch(async () => new Response(null, { status: 500 }));
    const seams = makeSeams();
    const result = await resolveManagedServer("/home/marcus/proj", seams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not answering");
    }
  });
});

describe("attach.ts <-> discovery.ts discovery-path parity", () => {
  test("attach's computed discovery path matches discoveryFilePath() for sample roster paths", async () => {
    const homeDir = "/home/marcus";
    const xdgStateHome = "/home/marcus/.state-home";
    const originalXdgStateHome = process.env["XDG_STATE_HOME"];
    const originalHome = process.env["HOME"];
    process.env["XDG_STATE_HOME"] = xdgStateHome;
    process.env["HOME"] = homeDir;

    try {
      const samplePaths = [
        "/home/marcus/proj/spacebus.json",
        "/home/marcus/other-proj/spacebus.json",
        "/tmp/weird path/spacebus.json",
      ];

      for (const rosterPath of samplePaths) {
        const seams = makeSeams({
          homeDir: async () => homeDir,
          env: async (name) =>
            name === "XDG_STATE_HOME" ? xdgStateHome : null,
        });

        const readPaths: string[] = [];
        const testSeams: AttachSeams = {
          ...seams,
          realpath: async () => rosterPath,
          readTextFile: async (p) => {
            readPaths.push(p);
            return DISCOVERY_JSON;
          },
        };
        stubFetch(async () => new Response(null, { status: 200 }));

        await resolveManagedServer("/irrelevant", testSeams);

        expect(readPaths).toHaveLength(1);
        expect(readPaths[0]).toBe(discoveryFilePath(rosterPath));
      }
    } finally {
      if (originalXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = originalXdgStateHome;
      }
      if (originalHome === undefined) {
        delete process.env["HOME"];
      } else {
        process.env["HOME"] = originalHome;
      }
    }
  });
});

describe("posixJoin", () => {
  test("preserves leading slash from first part, strips trailing slashes", () => {
    expect(posixJoin("/home/marcus", ".local", "state")).toBe(
      "/home/marcus/.local/state",
    );
  });

  test("strips leading and trailing slashes on non-first parts", () => {
    expect(posixJoin("/a/", "/b/", "c")).toBe("/a/b/c");
  });

  test("collapses runs of slashes without regex backtracking", () => {
    expect(posixJoin("/a///", "//b//c", "d")).toBe("/a/b/c/d");
  });

  test("filters out empty segments", () => {
    expect(posixJoin("/a", "", "/b", "///", "c")).toBe("/a/b/c");
  });

  test("produces relative path when first part has no leading slash", () => {
    expect(posixJoin("a", "b/", "/c")).toBe("a/b/c");
  });

  test("matches discovery.json path shape", () => {
    expect(
      posixJoin(
        "/home/marcus/.state",
        "space-bus",
        "deadbeefcafef00d",
        "discovery.json",
      ),
    ).toBe("/home/marcus/.state/space-bus/deadbeefcafef00d/discovery.json");
  });
});
