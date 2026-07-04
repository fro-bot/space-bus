import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  afterEach(() => {
    stopServer(rosterPath);
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

  test("no command / --help: prints usage, exit 0", () => {
    const res = runCli(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("Usage:");
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
});
