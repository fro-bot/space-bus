import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// E2E check that build.ts's Bun.build `define` actually substitutes
// __SPACE_BUS_VERSION__ in the emitted dist/mcp.js bin, and that the
// shebang build.ts prepends survives. Runs the real `bun run build`
// (same as CI) rather than reimplementing the build logic, so a
// regression in build.ts itself is caught here too.

const projectRoot = join(import.meta.dir, "..");

describe("dist/mcp.js version injection (e2e build)", () => {
  test("shebang present, version substituted, define placeholder gone", () => {
    const bunPath = Bun.which("bun");
    if (!bunPath) {
      console.warn("bun not found on PATH, skipping build e2e test");
      return;
    }

    const pkg = JSON.parse(
      readFileSync(join(projectRoot, "package.json"), "utf8"),
    );
    const version: string = pkg.version;
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);

    const build = Bun.spawnSync(["bun", "run", "build"], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (build.exitCode !== 0) {
      const stdout = build.stdout.toString();
      const stderr = build.stderr.toString();
      throw new Error(
        `bun run build failed (exit ${build.exitCode}):\n${stdout}\n${stderr}`,
      );
    }

    const mcpJs = readFileSync(join(projectRoot, "dist/mcp.js"), "utf8");

    const firstLine = mcpJs.split("\n", 1)[0];
    expect(firstLine).toBe("#!/usr/bin/env node");

    expect(mcpJs).toContain(`"${version}"`);
    expect(mcpJs).not.toContain("__SPACE_BUS_VERSION__");
  }, 60_000);
});
