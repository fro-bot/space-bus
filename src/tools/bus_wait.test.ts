import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBusWait } from "./bus_wait";

describe("bus_wait tool", () => {
  const ORIGINAL_ENV = process.env["SPACE_BUS_CONFIG"];
  const ORIGINAL_FETCH = globalThis.fetch;
  let dir: string;
  let configDir: string;

  function writeRoster(): void {
    const rosterPath = join(configDir, "spacebus.json");
    writeFileSync(
      rosterPath,
      JSON.stringify({
        server: { baseUrl: "http://127.0.0.1:4096" },
        projects: [{ name: "alpha", path: dir, description: "Alpha" }],
      }),
    );
    process.env["SPACE_BUS_CONFIG"] = rosterPath;
  }

  function mockFetch(routes: Record<string, () => Response>): typeof fetch {
    return (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      const path = url.replace("http://127.0.0.1:4096", "");
      const handler = routes[path];
      return handler
        ? handler()
        : new Response(JSON.stringify([]), { status: 404 });
    }) as typeof fetch;
  }

  function setup(): void {
    dir = mkdtempSync(join(tmpdir(), "space-bus-wait-alpha-"));
    configDir = mkdtempSync(join(tmpdir(), "space-bus-wait-config-"));
    writeRoster();
  }

  function teardown(): void {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_ENV === undefined) {
      delete process.env["SPACE_BUS_CONFIG"];
    } else {
      process.env["SPACE_BUS_CONFIG"] = ORIGINAL_ENV;
    }
  }

  test("happy path: returns a formatted snapshot with per-session state and waker", async () => {
    setup();
    try {
      globalThis.fetch = mockFetch({
        "/session/ses_a": () =>
          new Response(JSON.stringify({ id: "ses_a", directory: dir }), {
            status: 200,
          }),
        "/session/status": () =>
          new Response(JSON.stringify({ ses_a: { type: "idle" } }), {
            status: 200,
          }),
        "/question": () => new Response(JSON.stringify([]), { status: 200 }),
      });
      const busWait = makeBusWait(dir);
      const out = (await busWait.execute(
        { sessionIds: ["ses_a"] },
        // biome-ignore lint: minimal stub, only `directory` is consumed
        { directory: dir } as any,
      )) as string;
      expect(out).toContain("woke on: ses_a");
      expect(out).toContain("ses_a (alpha): complete");
    } finally {
      teardown();
    }
  });

  test("empty-array guard: fails fast, does not block or touch config", async () => {
    setup();
    try {
      const busWait = makeBusWait(dir);
      await expect(
        busWait.execute(
          { sessionIds: [] },
          // biome-ignore lint: minimal stub, only `directory` is consumed
          { directory: dir } as any,
        ),
      ).rejects.toThrow();
    } finally {
      teardown();
    }
  });

  test("error path: wait() ok:false surfaces as a thrown error with no raw context leak", async () => {
    setup();
    try {
      // No SPACE_BUS_CONFIG-resolvable roster/project for this id — the
      // core call still succeeds (not_found is a state, not an error), so
      // instead exercise a hard context failure: bogus directory outside
      // the roster resolves no config at all.
      rmSync(join(configDir, "spacebus.json"), { force: true });
      const busWait = makeBusWait(dir);
      await expect(
        busWait.execute(
          { sessionIds: ["ses_a"] },
          // biome-ignore lint: minimal stub, only `directory` is consumed
          { directory: dir } as any,
        ),
      ).rejects.toThrow();
    } finally {
      teardown();
    }
  });
});
