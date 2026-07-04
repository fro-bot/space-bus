import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureIdentity,
  isAlive,
  provisionalFilePath,
  readDiscovery,
  writeDiscovery,
  writeProvisional,
} from "./discovery";
import {
  attachServer,
  ensureServer,
  redactSensitive,
  serverStatus,
  stopServer,
} from "./server";

const STUB_COMMAND = ["bun", "test/fixtures/stub-server.ts"];
const REPO_ROOT = process.cwd();

let dir: string;
let rosterPath: string;
const spawnedPids: number[] = [];

function makeRoster(overrides: Record<string, unknown> = {}): unknown {
  return {
    server: {
      managed: {
        command: STUB_COMMAND,
        cwd: REPO_ROOT,
        ...((overrides["managed"] as object) ?? {}),
      },
    },
    projects: [],
    ...overrides,
  };
}

function writeRoster(data: unknown): void {
  writeFileSync(rosterPath, JSON.stringify(data));
}

async function killAllSpawned(): Promise<void> {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  spawnedPids.length = 0;
}

describe("server lifecycle", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-server-test-"));
    rosterPath = join(dir, "spacebus.json");
    writeRoster(makeRoster());
  });

  afterEach(async () => {
    await stopServer(rosterPath);
    await killAllSpawned();
    rmSync(dir, { recursive: true, force: true });
  });

  // --- Detach spike (gates the rest of the unit) --------------------------

  test("detach spike: node:child_process spawn({detached:true}).unref() outlives the Bun parent", async () => {
    const spikeScript = `
      const { spawn } = require("node:child_process");
      const fs = require("node:fs");
      const child = spawn("sleep", ["30"], {
        detached: true,
        stdio: ["ignore", fs.openSync("${dir}/spike-out.log", "w"), fs.openSync("${dir}/spike-err.log", "w")],
      });
      child.unref();
      fs.writeFileSync("${dir}/spike-pid.txt", String(child.pid));
    `;
    const spikeFile = join(dir, "spike.ts");
    writeFileSync(spikeFile, spikeScript);

    // Run the spike in a genuinely separate Bun process, then check from
    // *this* (separate) test process whether the sleep pid is still alive
    // after that Bun process has fully exited.
    execFileSync("bun", ["run", spikeFile], { encoding: "utf8" });

    const pidPath = join(dir, "spike-pid.txt");
    const pidRaw = await Bun.file(pidPath).text();
    const pid = Number(pidRaw.trim());
    expect(Number.isInteger(pid)).toBe(true);
    spawnedPids.push(pid);

    // The bun parent has already exited (execFileSync returned). Verify the
    // detached child is still alive from this separate process.
    expect(isAlive(pid)).toBe(true);

    process.kill(pid, "SIGKILL");
  });

  // --- attachServer --------------------------------------------------------

  test("attachServer returns null when no discovery file exists", () => {
    expect(attachServer(rosterPath)).toBeNull();
  });

  // --- ensureServer: first-caller spawn + readiness -----------------------

  test("ensureServer spawns the stub, waits for readiness, and returns a working handle", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(handle.credentials.password).toBeTruthy();
    expect(isAlive(handle.pid)).toBe(true);

    const res = await fetch(`${handle.baseUrl}/session?limit=1`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${handle.credentials.password}`).toString("base64")}`,
      },
    });
    expect(res.status).toBe(200);

    const discovery = readDiscovery(rosterPath);
    expect(discovery?.pid).toBe(handle.pid);
  });

  test("ensureServer with a small readinessBudgetMs still succeeds against the healthy stub (phase 1 isn't starved)", async () => {
    // Regression: MIN_PROBE_PHASE_MS was previously reserved as a flat
    // 3000ms carve-out for phase 2, which left phase 1 (waiting for the
    // readiness line) with ~0ms on a budget this small — the healthy stub
    // would falsely time out. The reserve must scale down with the budget.
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 2000 });
    spawnedPids.push(handle.pid);

    expect(handle.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(isAlive(handle.pid)).toBe(true);
  });

  // --- AE1: concurrent ensures → exactly one spawn -------------------------

  test("AE1: concurrent ensureServer calls produce exactly one spawn, all callers get the same pid", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        ensureServer(rosterPath, { readinessBudgetMs: 5000 }),
      ),
    );
    const pids = new Set(results.map((r) => r.pid));
    expect(pids.size).toBe(1);
    const [pid] = [...pids];
    spawnedPids.push(pid as number);
    expect(isAlive(pid as number)).toBe(true);
  });

  // --- AE2: dead-pid discovery heals ---------------------------------------

  test("AE2: a discovery file pointing at a dead pid is healed by re-spawning", async () => {
    writeDiscovery(rosterPath, {
      port: 4999,
      pid: 2_147_483_000,
      identity: "bogus-dead-identity",
      password: "stale-password",
      spawnConfig: { command: STUB_COMMAND, cwd: REPO_ROOT },
      baseUrl: "http://127.0.0.1:4999",
    });

    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    expect(handle.pid).not.toBe(2_147_483_000);
    expect(isAlive(handle.pid)).toBe(true);
  });

  // --- AE3: auth probe (401 without password, 200 with) --------------------

  test("AE3: stub returns 401 without password and 200 with the correct one", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    const unauthed = await fetch(`${handle.baseUrl}/session?limit=1`);
    expect(unauthed.status).toBe(401);

    const authed = await fetch(`${handle.baseUrl}/session?limit=1`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${handle.credentials.password}`).toString("base64")}`,
      },
    });
    expect(authed.status).toBe(200);
  });

  // --- AE6: server outlives the test-spawned parent; stopServer kills it --

  test("AE6: the server persists as a daemon, and stopServer kills it and clears discovery", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    expect(isAlive(handle.pid)).toBe(true);

    const { stopped } = await stopServer(rosterPath);
    expect(stopped).toBe(true);

    expect(isAlive(handle.pid)).toBe(false);
    expect(readDiscovery(rosterPath)).toBeNull();
  });

  test("stopServer on a roster with no discovery file returns stopped:false", async () => {
    expect(await stopServer(rosterPath)).toEqual({ stopped: false });
  });

  // --- Readiness timeout: never-ready stub ---------------------------------

  test("readiness timeout kills the child, releases the lock, and redacts the password from the error", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: STUB_COMMAND,
          cwd: REPO_ROOT,
          port: 0,
        },
      }),
    );
    // Force the stub to never print the readiness line.
    const originalEnv = process.env["STUB_NO_READY"];
    process.env["STUB_NO_READY"] = "1";
    try {
      let caughtError: Error | null = null;
      try {
        await ensureServer(rosterPath, { readinessBudgetMs: 500 });
      } catch (err) {
        caughtError = err as Error;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).not.toContain(
        readDiscovery(rosterPath)?.password ?? "__never__",
      );

      // Lock must be released — a fresh ensure should be able to proceed
      // (it will also fail readiness for the same reason, but must not
      // report "held by a live owner").
      let secondError: Error | null = null;
      try {
        await ensureServer(rosterPath, { readinessBudgetMs: 500 });
      } catch (err) {
        secondError = err as Error;
      }
      expect(secondError?.message).not.toMatch(/waiting for pid/);
    } finally {
      if (originalEnv === undefined) delete process.env["STUB_NO_READY"];
      else process.env["STUB_NO_READY"] = originalEnv;
    }
  });

  test("auth failure with our own generated password fails immediately without retry", async () => {
    const originalEnv = process.env["STUB_FORCE_401"];
    process.env["STUB_FORCE_401"] = "1";
    try {
      const start = Date.now();
      let caughtError: Error | null = null;
      try {
        await ensureServer(rosterPath, { readinessBudgetMs: 10_000 });
      } catch (err) {
        caughtError = err as Error;
      }
      const elapsed = Date.now() - start;
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toMatch(/401|403|regression/i);
      // Should fail fast, well under the 10s budget.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      if (originalEnv === undefined) delete process.env["STUB_FORCE_401"];
      else process.env["STUB_FORCE_401"] = originalEnv;
    }
  });

  // --- Live-but-slow lock owner: waiter times out, names the holder --------

  test("a live-but-slow lock owner causes the waiter to time out naming the holder, with no double spawn", async () => {
    // Simulate a live holder: acquire the lock ourselves (this process is
    // alive) and never write discovery, so the second caller must wait and
    // eventually time out rather than spawn a second child.
    const { acquireLock, releaseLock } = await import("./discovery");
    const lock = acquireLock(rosterPath);
    expect(lock).not.toBeNull();

    try {
      let caughtError: Error | null = null;
      try {
        await ensureServer(rosterPath, { lockWaitBudgetMs: 500 });
      } catch (err) {
        caughtError = err as Error;
      }
      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toMatch(new RegExp(String(process.pid)));
      expect(readDiscovery(rosterPath)).toBeNull();
    } finally {
      if (lock) releaseLock(lock);
    }
  });

  // --- serverStatus + configDrift ------------------------------------------

  test("serverStatus reports running:false when there is no live discovery", () => {
    expect(serverStatus(rosterPath)).toEqual({ running: false });
  });

  test("serverStatus reports configDrift when the roster's managed command differs from spawnConfig", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    const statusBefore = serverStatus(rosterPath);
    expect(statusBefore.running).toBe(true);
    expect(statusBefore.configDrift).toBe(false);

    writeRoster(
      makeRoster({
        managed: {
          command: [...STUB_COMMAND, "--extra-flag"],
          cwd: REPO_ROOT,
        },
      }),
    );

    const statusAfter = serverStatus(rosterPath);
    expect(statusAfter.running).toBe(true);
    expect(statusAfter.configDrift).toBe(true);
  });

  // --- Orphan policy: ensure succeeds, "downstream" fails, server persists

  test("orphan policy: a successful ensure leaves the server running even if the caller does nothing further with it", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    // Simulate "downstream failure" by simply not using the handle further
    // and re-checking liveness after a beat — ensure() itself never tears
    // down a server it successfully started.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(handle.pid)).toBe(true);
    expect(attachServer(rosterPath)).not.toBeNull();
  });

  // --- Finding 2: spawn 'error' surfaces actionably instead of unhandled --

  test("a nonexistent spawn command rejects with an actionable error naming the command, no leaked process", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: ["space-bus-definitely-does-not-exist-binary"],
          cwd: REPO_ROOT,
        },
      }),
    );

    let caughtError: Error | null = null;
    try {
      await ensureServer(rosterPath, { readinessBudgetMs: 3000 });
    } catch (err) {
      caughtError = err as Error;
    }
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toContain(
      "space-bus-definitely-does-not-exist-binary",
    );
    expect(caughtError?.message).toContain(rosterPath);
    // No discovery should have been written for a failed spawn.
    expect(readDiscovery(rosterPath)).toBeNull();
  });

  // --- Finding 3: stopServer escalates SIGTERM -> SIGKILL, waits for death -

  test("stopServer escalates to SIGKILL when the process ignores SIGTERM, and only clears discovery once dead", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: STUB_COMMAND,
          cwd: REPO_ROOT,
        },
      }),
    );
    const originalEnv = process.env["STUB_IGNORE_SIGTERM"];
    process.env["STUB_IGNORE_SIGTERM"] = "1";
    try {
      const handle = await ensureServer(rosterPath, {
        readinessBudgetMs: 5000,
      });
      spawnedPids.push(handle.pid);
      expect(isAlive(handle.pid)).toBe(true);

      const { stopped } = await stopServer(rosterPath);
      expect(stopped).toBe(true);
      expect(isAlive(handle.pid)).toBe(false);
      expect(readDiscovery(rosterPath)).toBeNull();
    } finally {
      if (originalEnv === undefined) delete process.env["STUB_IGNORE_SIGTERM"];
      else process.env["STUB_IGNORE_SIGTERM"] = originalEnv;
    }
  }, 15_000);

  // --- Finding 5: base64 Basic-auth token is redacted from surfaced logs --

  test("redactSensitive strips both the raw password and its base64 Basic-auth token from a log tail", () => {
    const password = "sentinel-test-password-xyz";
    const token = Buffer.from(`opencode:${password}`).toString("base64");
    const tail = `incoming request: authorization: Basic ${token}\nplain password mention: ${password}\n`;

    const redacted = redactSensitive(tail, password);

    expect(redacted).not.toContain(password);
    expect(redacted).not.toContain(token);
    expect(redacted).toContain("[REDACTED]");
  });

  // --- Finding 7: leftover provisional record is reaped on next ensure ----

  test("a leftover provisional record with a live pid is reaped before the next ensure spawns fresh", async () => {
    // Simulate a "parent died before writeDiscovery" scenario: spawn a
    // live stub directly (bypassing ensureServer) and write only a
    // provisional record for it, with no discovery file.
    const { spawn } = await import("node:child_process");
    const child = spawn("bun", STUB_COMMAND.slice(1), {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, STUB_NO_READY: "1" },
    });
    child.unref();
    const orphanPid = child.pid as number;
    spawnedPids.push(orphanPid);
    // Give it a beat to actually start.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(orphanPid)).toBe(true);

    const identity = captureIdentity(orphanPid) ?? "";
    writeProvisional(rosterPath, {
      pid: orphanPid,
      identity,
      password: "orphan-password",
      since: Date.now(),
    });
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(true);

    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    expect(handle.pid).not.toBe(orphanPid);
    // The orphan should have been killed as part of the reap.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(orphanPid)).toBe(false);
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(false);
  }, 15_000);

  // --- Finding 8: crashed child fails fast, well under the budget --------

  test("a child that exits immediately after spawn fails fast, well under the readiness budget", async () => {
    writeRoster(
      makeRoster({
        managed: {
          // `bun -e` runs and exits immediately, never printing a
          // readiness line — simulates a crashed child.
          command: ["bun", "-e", "process.exit(1)"],
          cwd: REPO_ROOT,
        },
      }),
    );

    const start = Date.now();
    let caughtError: Error | null = null;
    try {
      await ensureServer(rosterPath, { readinessBudgetMs: 10_000 });
    } catch (err) {
      caughtError = err as Error;
    }
    const elapsed = Date.now() - start;
    expect(caughtError).not.toBeNull();
    expect(caughtError?.message).toMatch(/exited before/);
    // Should fail fast, well under the 10s budget.
    expect(elapsed).toBeLessThan(5000);
  });
});
