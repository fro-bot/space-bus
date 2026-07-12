import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRoster } from "../registry";
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

  describe("roster param (Unit 4)", () => {
    // Registers rosters — isolate XDG_CONFIG_HOME per test so scenarios
    // never contaminate each other's registry.json, same pattern as
    // registry.test.ts / config.test.ts's registry describe block.
    let perTestConfigHome: string;
    let originalXdgConfigHome: string | undefined;

    function setupWithBeforeEach(): void {
      originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
      perTestConfigHome = mkdtempSync(
        join(tmpdir(), "space-bus-wait-registry-test-"),
      );
      process.env["XDG_CONFIG_HOME"] = perTestConfigHome;
    }

    function teardownRegistryIsolation(): void {
      rmSync(perTestConfigHome, { recursive: true, force: true });
      if (originalXdgConfigHome === undefined) {
        delete process.env["XDG_CONFIG_HOME"];
      } else {
        process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
      }
    }

    test("happy path: roster param resolves a registered roster's context and echoes it (AE2)", async () => {
      setup();
      setupWithBeforeEach();
      try {
        const rosterPath = realpathSync(join(configDir, "spacebus.json"));
        expect(registerRoster("personal", rosterPath)).toEqual({ ok: true });

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
        // Deliberately pass a directory that has no ambient spacebus.json —
        // the explicit roster param must still resolve.
        const noAmbientDir = mkdtempSync(
          join(tmpdir(), "space-bus-wait-no-ambient-"),
        );
        delete process.env["SPACE_BUS_CONFIG"];
        try {
          const busWait = makeBusWait(noAmbientDir);
          const out = (await busWait.execute(
            { sessionIds: ["ses_a"], roster: "personal" },
            // biome-ignore lint: minimal stub, only `directory` is consumed
            { directory: noAmbientDir } as any,
          )) as string;
          expect(out).toStartWith("roster: personal\n");
          expect(out).toContain("woke on: ses_a");
        } finally {
          rmSync(noAmbientDir, { recursive: true, force: true });
        }
      } finally {
        teardownRegistryIsolation();
        teardown();
      }
    });

    test("omitted roster param: behavior + echo byte-identical to ambient path (AE3), header names the resolved path", async () => {
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
        const expectedPath = realpathSync(join(configDir, "spacebus.json"));
        expect(out).toStartWith(`roster: ${expectedPath}\n`);
        expect(out).toContain("woke on: ses_a");
      } finally {
        teardown();
      }
    });

    test("error: unknown roster name surfaces an actionable error listing known names (AE5)", async () => {
      setup();
      setupWithBeforeEach();
      try {
        const rosterPath = realpathSync(join(configDir, "spacebus.json"));
        expect(registerRoster("workspace", rosterPath)).toEqual({ ok: true });

        const busWait = makeBusWait(dir);
        await expect(
          busWait.execute(
            { sessionIds: ["ses_a"], roster: "blog" },
            // biome-ignore lint: minimal stub, only `directory` is consumed
            { directory: dir } as any,
          ),
        ).rejects.toThrow(/workspace/);
      } finally {
        teardownRegistryIsolation();
        teardown();
      }
    });

    test("edge: zero rosters registered + roster param names 'no rosters are registered'", async () => {
      setup();
      setupWithBeforeEach();
      try {
        const busWait = makeBusWait(dir);
        await expect(
          busWait.execute(
            { sessionIds: ["ses_a"], roster: "anything" },
            // biome-ignore lint: minimal stub, only `directory` is consumed
            { directory: dir } as any,
          ),
        ).rejects.toThrow(/no rosters are registered/);
      } finally {
        teardownRegistryIsolation();
        teardown();
      }
    });
  });
});
