import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadContext } from "./config";
import { roster } from "./core";
import {
  acquireLock,
  attachLive,
  captureIdentity,
  discoveryFilePath,
  inspectLive,
  readDiscovery,
  releaseLock,
  stateDirFor,
} from "./discovery";
import { editServer } from "./roster-edit";
import { attachServer, ensureServer } from "./server";

// Ordinary synthetic fixtures only. The "live daemon" is this test process (a
// real pid whose recorded identity matches); nothing here signals it, stops
// it, or reaches a network: `fetch` is replaced by a recording stub, and the
// managed command is a marker script that must NEVER run.

let dir: string;
let rosterPath: string;
let marker: string;
let fetchCalls: string[];
let originalFetch: typeof fetch;

const LIVE_PID = process.pid;

function liveIdentity(): string {
  const identity = captureIdentity(LIVE_PID);
  if (identity === null) throw new Error("ps unavailable: cannot run test");
  return identity;
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (r.pid === undefined) throw new Error("no pid");
  return r.pid;
}

/** Writes a discovery record verbatim (raw text/object) at the roster's path. */
function writeRawRecord(record: Record<string, unknown> | string): string {
  mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
  const text = typeof record === "string" ? record : JSON.stringify(record);
  writeFileSync(discoveryFilePath(rosterPath), text, { mode: 0o600 });
  return text;
}

function recordWith(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    port: 4096,
    pid: LIVE_PID,
    identity: liveIdentity(),
    password: "synthetic-password",
    spawnConfig: {},
    baseUrl: "http://127.0.0.1:4096",
    ...overrides,
  };
}

/** Everything in the state dir, to prove nothing was created or rewritten. */
function stateDirListing(): string[] {
  const state = stateDirFor(rosterPath);
  return existsSync(state) ? readdirSync(state).sort() : [];
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "space-bus-ensure-invalid-")));
  rosterPath = join(dir, "spacebus.json");
  marker = join(dir, "spawned.marker");
  const script = join(dir, "would-spawn.ts");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "spawned");\nprocess.exit(1);\n`,
  );
  writeFileSync(
    rosterPath,
    JSON.stringify({
      server: { managed: { command: ["bun", script], cwd: dir } },
      projects: [],
    }),
  );
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    fetchCalls.push(String(url));
    return new Response(null, { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(stateDirFor(rosterPath), { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

// Schema-readable records whose endpoint fails the strict managed-origin rule,
// for a daemon that IS alive with a matching identity.
const INVALID_ENDPOINTS: Array<[string, Record<string, unknown>]> = [
  [
    "URL port differs from the recorded port",
    { baseUrl: "http://127.0.0.1:4097" },
  ],
  ["userinfo in the URL", { baseUrl: "http://user:pw@127.0.0.1:4096" }],
  ["https scheme", { baseUrl: "https://127.0.0.1:4096" }],
  ["path component", { baseUrl: "http://127.0.0.1:4096/other" }],
  ["non-loopback host", { baseUrl: "http://example.com:4096" }],
  // Zod's url() trims these into a valid URL; the RAW spelling must still fail.
  ["leading whitespace in the raw URL", { baseUrl: " http://127.0.0.1:4096" }],
  ["embedded tab in the raw URL", { baseUrl: "http://127.0.0.1:4096\t" }],
];

describe("inspectLive distinguishes a refused live endpoint from absent/dead", () => {
  test("absent record and corrupt record are both 'none'", () => {
    expect(inspectLive(rosterPath)).toEqual({ state: "none" });
    writeRawRecord("{not json");
    expect(inspectLive(rosterPath)).toEqual({ state: "none" });
  });

  test("a dead owner is 'none' even with an invalid endpoint, and its record is reaped as for any dead owner", () => {
    writeRawRecord(
      recordWith({
        pid: deadPid(),
        identity: "gone",
        baseUrl: "http://example.com:1",
      }),
    );
    expect(inspectLive(rosterPath)).toEqual({ state: "none" });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("a valid live record is 'live' with the recorded URL unchanged", () => {
    writeRawRecord(recordWith());
    const result = inspectLive(rosterPath);
    expect(result.state).toBe("live");
    if (result.state === "live") {
      expect(result.endpoint.baseUrl).toBe("http://127.0.0.1:4096");
      expect(result.endpoint.credentials.password).toBe("synthetic-password");
    }
  });

  test.each(INVALID_ENDPOINTS)(
    "%s => 'invalid-endpoint' with the pid, no credentials, record untouched",
    (_name, overrides) => {
      const text = writeRawRecord(recordWith(overrides));
      const result = inspectLive(rosterPath);
      expect(result).toEqual({ state: "invalid-endpoint", pid: LIVE_PID });
      expect(JSON.stringify(result)).not.toContain("synthetic-password");
      expect(readFileSync(discoveryFilePath(rosterPath), "utf8")).toBe(text);
    },
  );

  test.each(INVALID_ENDPOINTS)(
    "%s: attachLive/attachServer keep their null contract and readDiscovery keeps the parseable identity",
    (_name, overrides) => {
      writeRawRecord(recordWith(overrides));
      expect(attachLive(rosterPath)).toBeNull();
      expect(attachServer(rosterPath)).toBeNull();
      // The record is still readable: the pid/identity needed to refuse safely
      // (and to `space-bus stop`) must not be discarded by the strict check.
      expect(readDiscovery(rosterPath)?.pid).toBe(LIVE_PID);
    },
  );
});

describe("ensureServer fails closed for a live daemon with an invalid recorded endpoint", () => {
  test.each(INVALID_ENDPOINTS)(
    "%s: refuses without network, spawn, signal or record rewrite",
    async (_name, overrides) => {
      const text = writeRawRecord(recordWith(overrides));
      const before = stateDirListing();

      let error: unknown;
      try {
        await ensureServer(rosterPath, { readinessBudgetMs: 500 });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      const message = (error as Error).message;
      expect(message).toContain("refusing");
      expect(message).toContain(rosterPath);
      expect(message).toContain(`pid ${LIVE_PID}`);
      expect(message).toContain("space-bus stop");
      // Safe diagnostics: neither the credential nor the (possibly userinfo-bearing) URL.
      expect(message).not.toContain("synthetic-password");
      expect(message).not.toContain("user:pw");
      expect(message).not.toContain("example.com");

      expect(fetchCalls).toEqual([]); // no request, so no Authorization header
      expect(existsSync(marker)).toBe(false); // the managed command never ran
      expect(readFileSync(discoveryFilePath(rosterPath), "utf8")).toBe(text); // not rewritten/replaced
      expect(stateDirListing()).toEqual(before); // no lock, provisional or log created
      expect(captureIdentity(LIVE_PID)).toBe(liveIdentity()); // the "daemon" was never signalled
    },
  );

  test("a waiting loser fails closed as soon as the winner's record turns out to be an invalid live endpoint", async () => {
    const lock = acquireLock(rosterPath); // a live winner (us) holds the spawn lock
    expect(lock).not.toBeNull();
    try {
      const waiting = ensureServer(rosterPath, { lockWaitBudgetMs: 10_000 });
      const started = Date.now();
      const text = writeRawRecord(
        recordWith({ baseUrl: "http://127.0.0.1:4097" }),
      );
      await expect(waiting).rejects.toThrow(/refusing/);
      expect(Date.now() - started).toBeLessThan(5_000); // not the 10s budget
      expect(fetchCalls).toEqual([]);
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(discoveryFilePath(rosterPath), "utf8")).toBe(text);
    } finally {
      if (lock) releaseLock(lock);
    }
  });

  // Controls: the lifecycle for everything that is NOT a refused live daemon
  // is unchanged.
  test("control: a missing record still reaches the spawn path", async () => {
    await expect(
      ensureServer(rosterPath, { readinessBudgetMs: 500 }),
    ).rejects.toThrow(/exited before printing a readiness line|readiness/);
    expect(existsSync(marker)).toBe(true);
  });

  test("control: a DEAD owner with an invalid endpoint is replaced as before (spawn path reached, no refusal)", async () => {
    writeRawRecord(
      recordWith({
        pid: deadPid(),
        identity: "gone",
        baseUrl: "http://127.0.0.1:4097",
      }),
    );
    let error: unknown;
    try {
      await ensureServer(rosterPath, { readinessBudgetMs: 500 });
    } catch (e) {
      error = e;
    }
    expect((error as Error).message).not.toContain("refusing");
    expect(existsSync(marker)).toBe(true);
  });

  test("control: a valid live record is returned as before, with no spawn and no request", async () => {
    writeRawRecord(recordWith());
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 500 });
    expect(handle.baseUrl).toBe("http://127.0.0.1:4096");
    expect(handle.port).toBe(4096);
    expect(handle.pid).toBe(LIVE_PID);
    expect(existsSync(marker)).toBe(false);
    expect(fetchCalls).toEqual([]);
  });
});

describe("other consumers of the attach decision", () => {
  test("editServer still blocks while a live daemon has a refused endpoint (no split-brain)", () => {
    writeRawRecord(recordWith({ baseUrl: "http://127.0.0.1:4097" }));
    const before = readFileSync(rosterPath, "utf8");
    const result = editServer(rosterPath, { baseUrl: "http://127.0.0.1:5000" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("space-bus stop");
    expect(readFileSync(rosterPath, "utf8")).toBe(before);
  });

  test("loadContext (attach-only) names the refused endpoint instead of claiming 'not running', and never returns credentials", () => {
    writeRawRecord(recordWith({ baseUrl: "http://127.0.0.1:4097" }));
    let error: unknown;
    try {
      loadContext(dir);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("refusing");
    expect(message).not.toContain("not running");
    expect(message).not.toContain("synthetic-password");
  });

  test("loadContext keeps its 'not running' error for an absent record", () => {
    expect(() => loadContext(dir)).toThrow(/managed server not running/);
  });
});

describe("the canonical origin propagates to every managed request path", () => {
  const SLASHED = recordWith({ baseUrl: "http://LOCALHOST:4096/" });

  function writeRosterWithProject(): void {
    writeFileSync(
      rosterPath,
      JSON.stringify({
        server: { managed: { command: ["bun", "unused"], cwd: dir } },
        projects: [{ name: "p", path: dir, description: "synthetic project" }],
      }),
    );
  }

  test("ensureServer's fast path returns the canonical origin and the record is untouched", async () => {
    const text = writeRawRecord(SLASHED);
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 500 });
    expect(handle.baseUrl).toBe("http://localhost:4096");
    expect(readFileSync(discoveryFilePath(rosterPath), "utf8")).toBe(text);
    expect(existsSync(marker)).toBe(false);
  });

  test("loadContext hands core the canonical origin, and core's ordinary requests never double the slash or use the recorded spelling", async () => {
    writeRosterWithProject();
    writeRawRecord(SLASHED);
    const context = loadContext(dir);
    expect(context.roster.server.baseUrl).toBe("http://localhost:4096");
    expect(context.credentials?.password).toBe("synthetic-password");

    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      fetchCalls.push(String(url));
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toMatch(
        /^Basic /,
      );
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch;

    await roster({ context });
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const url of fetchCalls) {
      expect(url.startsWith("http://localhost:4096/")).toBe(true);
      expect(url.replace("http://", "")).not.toContain("//");
    }
  });
});
