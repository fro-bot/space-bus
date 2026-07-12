import { describe, expect, test } from "bun:test";

import { assertNoLaunchAgentsLeak, assertNoRealConfigLeak } from "./setup";

// Unit tests for the pure comparison functions extracted from test/setup.ts's
// preload leak guards. These feed fabricated before/after snapshots — no
// nested `bun test`, no touching the real home directory — so the guard
// logic itself is pinned independently of the preload hooks that call it.

describe("assertNoRealConfigLeak", () => {
  test("throws when the file appears (absent -> present)", () => {
    expect(() =>
      assertNoRealConfigLeak(
        { exists: false, mtimeMs: null },
        { exists: true, mtimeMs: 12345 },
        "/fake/home/.config/space-bus/rosters.json",
      ),
    ).toThrow(/Real config leak guard/);
  });

  test("throws when the file mutates (mtime advances)", () => {
    expect(() =>
      assertNoRealConfigLeak(
        { exists: true, mtimeMs: 1000 },
        { exists: true, mtimeMs: 2000 },
        "/fake/home/.config/space-bus/rosters.json",
      ),
    ).toThrow(/Real config leak guard/);
  });

  test("does not throw when the state is unchanged (both absent)", () => {
    expect(() =>
      assertNoRealConfigLeak(
        { exists: false, mtimeMs: null },
        { exists: false, mtimeMs: null },
      ),
    ).not.toThrow();
  });

  test("does not throw when the state is unchanged (both present, same mtime)", () => {
    expect(() =>
      assertNoRealConfigLeak(
        { exists: true, mtimeMs: 1000 },
        { exists: true, mtimeMs: 1000 },
      ),
    ).not.toThrow();
  });
});

describe("assertNoLaunchAgentsLeak", () => {
  test("throws when a new plist appears", () => {
    expect(() =>
      assertNoLaunchAgentsLeak(
        new Set(["bot.fro.space-bus.abc123.plist"]),
        new Set([
          "bot.fro.space-bus.abc123.plist",
          "bot.fro.space-bus.def456.plist",
        ]),
      ),
    ).toThrow(/LaunchAgents leak guard/);
  });

  test("does not throw for a clean, unchanged state", () => {
    expect(() =>
      assertNoLaunchAgentsLeak(
        new Set(["bot.fro.space-bus.abc123.plist"]),
        new Set(["bot.fro.space-bus.abc123.plist"]),
      ),
    ).not.toThrow();
  });

  test("does not throw when both sets are empty", () => {
    expect(() => assertNoLaunchAgentsLeak(new Set(), new Set())).not.toThrow();
  });
});
