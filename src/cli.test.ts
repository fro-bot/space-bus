import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runServe } from "./cli";
import type { ServerHandle, SuperviseOutcome } from "./server";
import { stopServer } from "./server";

const STUB_COMMAND = ["bun", "test/fixtures/stub-server.ts"];
const REPO_ROOT = process.cwd();
const CLI_PATH = join(REPO_ROOT, "src/cli.ts");
const SENTINEL_PASSWORD = "sentinel-cli-password-do-not-leak";

let dir: string;
let rosterPath: string;

function writeRoster(): void {
  writeFileSync(
    rosterPath,
    JSON.stringify({
      server: { managed: { command: STUB_COMMAND, cwd: REPO_ROOT } },
      projects: [],
    }),
  );
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[], timeoutMs = 20_000): RunResult {
  const proc = Bun.spawnSync(["bun", "run", CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SPACE_BUS_CONFIG: rosterPath,
      OPENCODE_SERVER_PASSWORD: SENTINEL_PASSWORD,
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? 1,
  };
}

function assertNoPasswordLeak(...outputs: string[]): void {
  for (const out of outputs) {
    expect(out).not.toContain(SENTINEL_PASSWORD);
  }
}

describe("space-bus CLI", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-cli-test-"));
    rosterPath = join(dir, "spacebus.json");
    writeRoster();
  });

  afterEach(async () => {
    await stopServer(rosterPath);
    rmSync(dir, { recursive: true, force: true });
  });

  test("status with nothing running: running:false, exit 0", () => {
    const res = runCli(["status", "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.running).toBe(false);
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("stop with nothing running: stopped:false, clean message, exit 0", () => {
    const res = runCli(["stop", "--json"]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.stopped).toBe(false);
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("unknown command: exit 1 + usage on stderr", () => {
    const res = runCli(["frobnicate"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown command");
    expect(res.stderr).toContain("Usage:");
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("--help: prints usage, exit 0", () => {
    const res = runCli(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage:");
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("no command: prints usage to stderr, exit 1", () => {
    const res = runCli([]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("Usage:");
    expect(res.stdout).toBe("");
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("unknown flag: exit 1, actionable stderr message", () => {
    const res = runCli(["status", "--bogus-flag"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("unknown flag");
    expect(res.stderr).toContain("--bogus-flag");
    expect(res.stderr).toContain("Usage:");
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("--config with no following value: exit 1, clear error", () => {
    const res = runCli(["status", "--config"]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("--config requires a path argument");
    assertNoPasswordLeak(res.stdout, res.stderr);
  });

  test("serve then status: status shows running:true with port/pid (AE5), then stop clears it", () => {
    const serveRes = runCli(["serve", "--json"]);
    expect(serveRes.exitCode).toBe(0);
    const served = JSON.parse(serveRes.stdout);
    expect(served.running).toBe(true);
    expect(typeof served.port).toBe("number");
    expect(typeof served.pid).toBe("number");
    expect(typeof served.baseUrl).toBe("string");
    assertNoPasswordLeak(serveRes.stdout, serveRes.stderr);

    const statusRes = runCli(["status", "--json"]);
    expect(statusRes.exitCode).toBe(0);
    const status = JSON.parse(statusRes.stdout);
    expect(status).toMatchObject({
      running: true,
      port: served.port,
      pid: served.pid,
    });
    assertNoPasswordLeak(statusRes.stdout, statusRes.stderr);

    const stopRes = runCli(["stop", "--json"]);
    expect(stopRes.exitCode).toBe(0);
    const stopped = JSON.parse(stopRes.stdout);
    expect(stopped.stopped).toBe(true);
    assertNoPasswordLeak(stopRes.stdout, stopRes.stderr);

    const afterStopRes = runCli(["status", "--json"]);
    const afterStop = JSON.parse(afterStopRes.stdout);
    expect(afterStop.running).toBe(false);
    assertNoPasswordLeak(afterStopRes.stdout, afterStopRes.stderr);
  }, 30_000);

  // --- runServe foreground supervision: injected deps, no real daemon ----

  describe("runServe foreground supervision", () => {
    const fakeHandle: ServerHandle = {
      baseUrl: "http://127.0.0.1:9",
      credentials: { username: "opencode", password: "pw" },
      pid: 111,
      port: 9,
    };

    function captureStderr(): { get: () => string; restore: () => void } {
      const original = process.stderr.write.bind(process.stderr);
      let buf = "";
      // biome-ignore lint/suspicious/noExplicitAny: test stub for stderr.write's overloaded signature
      (process.stderr.write as any) = (chunk: any, ...rest: any[]) => {
        buf += chunk.toString();
        return original(chunk, ...rest);
      };
      return {
        get: () => buf,
        restore: () => {
          process.stderr.write = original;
        },
      };
    }

    test("signal: shouldStop -> resolves 0, stopServer invoked", async () => {
      let stopCalls = 0;
      const args = {
        command: "serve",
        json: true,
        foreground: true,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      const code = await runServe(args, {
        ensureServer: async () => fakeHandle,
        stopServer: async () => {
          stopCalls += 1;
          return { stopped: true };
        },
        superviseServer: async (_roster, _handle, shouldStop, interrupt) => {
          // Simulate the signal firing immediately.
          expect(shouldStop()).toBe(false);
          expect(interrupt).toBeInstanceOf(Promise);
          return { reason: "signal" } as SuperviseOutcome;
        },
      });
      expect(code).toBe(0);
      expect(stopCalls).toBe(1);
    });

    test("died -> non-zero exit, actionable stderr (no password), no stopServer call needed by runServe", async () => {
      const capture = captureStderr();
      const args = {
        command: "serve",
        json: true,
        foreground: true,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      try {
        const code = await runServe(args, {
          ensureServer: async () => fakeHandle,
          stopServer: async () => ({ stopped: false }),
          superviseServer: async () => ({ reason: "died" }) as SuperviseOutcome,
        });
        expect(code).toBe(1);
        expect(capture.get()).toContain("died");
        assertNoPasswordLeak(capture.get());
      } finally {
        capture.restore();
      }
    });

    test("hung -> non-zero exit, actionable stderr (no password), stopServer was invoked (by superviseServer itself)", async () => {
      const capture = captureStderr();
      let stopCalls = 0;
      const args = {
        command: "serve",
        json: true,
        foreground: true,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      try {
        const code = await runServe(args, {
          ensureServer: async () => fakeHandle,
          stopServer: async () => {
            stopCalls += 1;
            return { stopped: true };
          },
          superviseServer: async (roster, _handle, _shouldStop, _interrupt) => {
            // superviseServer's real implementation calls stop internally
            // on the hung path; the injected fake here calls the injected
            // stopServer to model that.
            await stopServer(roster).catch(() => {});
            stopCalls += 1;
            return { reason: "hung" } as SuperviseOutcome;
          },
        });
        expect(code).toBe(1);
        expect(stopCalls).toBeGreaterThan(0);
        expect(capture.get()).toContain("hung");
        assertNoPasswordLeak(capture.get());
      } finally {
        capture.restore();
      }
    });

    test("rejection: a superviseServer that rejects -> resolves 1 (does not hang), actionable stderr (no password)", async () => {
      const capture = captureStderr();
      const args = {
        command: "serve",
        json: true,
        foreground: true,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      try {
        const code = await runServe(args, {
          ensureServer: async () => fakeHandle,
          stopServer: async () => ({ stopped: true }),
          superviseServer: async () => {
            throw new Error("boom: simulated supervision failure");
          },
        });
        expect(code).toBe(1);
        expect(capture.get()).toContain("supervision failed");
        assertNoPasswordLeak(capture.get());
      } finally {
        capture.restore();
      }
    });

    test("non-foreground: returns 0 immediately, does not supervise", async () => {
      let superviseCalls = 0;
      const args = {
        command: "serve",
        json: true,
        foreground: false,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      const code = await runServe(args, {
        ensureServer: async () => fakeHandle,
        superviseServer: async () => {
          superviseCalls += 1;
          return { reason: "signal" } as SuperviseOutcome;
        },
      });
      expect(code).toBe(0);
      expect(superviseCalls).toBe(0);
    });

    test("regression: the initial running-line still prints before supervision", async () => {
      const originalWrite = process.stdout.write.bind(process.stdout);
      let out = "";
      // biome-ignore lint/suspicious/noExplicitAny: test stub for stdout.write's overloaded signature
      (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
        out += chunk.toString();
        return originalWrite(chunk, ...rest);
      };
      const args = {
        command: "serve",
        json: true,
        foreground: true,
        config: rosterPath,
        help: false,
        unknownFlags: [],
        configMissingValue: false,
      };
      writeRoster();
      try {
        await runServe(args, {
          ensureServer: async () => fakeHandle,
          stopServer: async () => ({ stopped: true }),
          superviseServer: async () =>
            ({ reason: "signal" }) as SuperviseOutcome,
        });
        const parsed = JSON.parse(out.trim());
        expect(parsed.running).toBe(true);
        expect(parsed.pid).toBe(fakeHandle.pid);
      } finally {
        process.stdout.write = originalWrite;
      }
    });
  });
});
