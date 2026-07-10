import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureIdentity,
  discoveryFilePath,
  isAlive,
  logFilePath,
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
const WRAPPER_COMMAND = ["bun", "test/fixtures/wrapper-server.ts"];
const REPO_ROOT = process.cwd();

/** Reads the child pid printed by wrapper-server.ts's marker line. */
function readWrapperChildPid(logPath: string): number | null {
  try {
    const content = readFileSync(logPath, "utf8");
    const match = /wrapper-server: child pid (\d+)/.exec(content);
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

let dir: string;
let rosterPath: string;
const spawnedPids: number[] = [];

/**
 * Polls isAlive(pid) until it reports dead or the budget expires.
 *
 * A signaled process can briefly remain a reapable zombie (`kill(pid, 0)`
 * still succeeds) until its new parent (init/reparenting) reaps it — this
 * is kernel bookkeeping, not liveness. Waiting here (instead of asserting
 * death instantly) removes that race while still failing hard if the
 * process genuinely never dies (a real product regression).
 */
async function waitUntilDead(pid: number, budgetMs = 3000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

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

  test("a loser fails fast (well under lockWaitBudgetMs) when the winner's spawn/readiness fails", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: STUB_COMMAND,
          cwd: REPO_ROOT,
          port: 0,
        },
      }),
    );
    // Force the winner's stub to never print the readiness line, so its
    // spawnAndWaitReady rejects, releasing the lock without ever writing
    // discovery.
    const originalEnv = process.env["STUB_NO_READY"];
    process.env["STUB_NO_READY"] = "1";
    try {
      const start = Date.now();
      const results = await Promise.allSettled([
        ensureServer(rosterPath, { readinessBudgetMs: 1000 }),
        // Give the winner a head start acquiring the lock, then let the
        // loser poll in via waitForDiscoveryOrFail with a large budget —
        // it must NOT wait out the full budget once the winner's lock is
        // released with no discovery file.
        (async () => {
          await new Promise((r) => setTimeout(r, 50));
          return ensureServer(rosterPath, { lockWaitBudgetMs: 15_000 });
        })(),
      ]);
      const elapsed = Date.now() - start;

      for (const result of results) {
        expect(result.status).toBe("rejected");
      }
      const loserResult = results[1];
      if (loserResult.status === "rejected") {
        expect(loserResult.reason.message).toMatch(
          /failed before it could finish|readiness|regression/i,
        );
      }
      // Must fail fast, well under the 15s lock-wait budget.
      expect(elapsed).toBeLessThan(5000);
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
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("serverStatus cleans up a stale discovery record for a dead pid", () => {
    writeDiscovery(rosterPath, {
      port: 4096,
      pid: 2_147_483_000,
      identity: "bogus-identity",
      password: "test-password",
      spawnConfig: { command: STUB_COMMAND },
      baseUrl: "http://127.0.0.1:4096",
    });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
    expect(serverStatus(rosterPath)).toEqual({ running: false });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("serverStatus leaves an alive+verified discovery record intact", async () => {
    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    expect(serverStatus(rosterPath)).toEqual(
      expect.objectContaining({
        running: true,
        port: expect.any(Number),
        pid: expect.any(Number),
      }),
    );
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
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
      // After the group SIGKILL the child can briefly linger as a reapable
      // zombie (kill(pid,0) still succeeds) until init reparents+reaps it —
      // await death instead of asserting it instantly, matching the reap
      // test below. Bare isAlive here flaked ~33% in isolation.
      expect(await waitUntilDead(handle.pid)).toBe(true);
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

  // --- Recycled-pid safety: stale unidentifiable provisional isn't blind-killed --

  test("a stale provisional record with empty identity is NOT killed (only removed) when unidentifiable", async () => {
    // Simulate: captureIdentity failed at spawn time (identity="") AND the
    // record is old (parent died long ago, reaped much later) — the pid
    // may have been recycled to an unrelated live process by now. We can't
    // prove recycling in a test, but we can prove the fix doesn't blind-
    // kill an old, unidentifiable record's pid: spawn an unrelated live
    // process, record its pid with identity="" and a backdated `since`,
    // and confirm it survives the reap while the stale record is removed.
    const { spawn } = await import("node:child_process");
    const bystander = spawn("sleep", ["30"], {
      detached: true,
      stdio: "ignore",
    });
    bystander.unref();
    const bystanderPid = bystander.pid as number;
    spawnedPids.push(bystanderPid);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(isAlive(bystanderPid)).toBe(true);

    writeProvisional(rosterPath, {
      pid: bystanderPid,
      identity: "",
      password: "stale-password",
      since: Date.now() - 60_000, // well outside the fresh window
    });
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(true);

    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    // The bystander must NOT have been killed — it's unrelated, and the
    // record was too old/unidentifiable to safely direct-kill.
    expect(isAlive(bystanderPid)).toBe(true);
    // The stale provisional record is still removed so it can't wedge
    // future ensures.
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(false);
  }, 15_000);

  test("a fresh provisional record with empty identity IS killed (readiness-path freshness still works)", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(isAlive(orphanPid)).toBe(true);

    writeProvisional(rosterPath, {
      pid: orphanPid,
      identity: "",
      password: "fresh-password",
      since: Date.now(), // fresh — within the window
    });
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(true);

    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid);

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(orphanPid)).toBe(false);
    expect(existsSync(provisionalFilePath(rosterPath))).toBe(false);
  }, 15_000);

  // --- Process-group stop: wrapper/child split (harness serve shape) ------

  test("stopServer kills BOTH the wrapper and its port-holder child (group signal), not just the wrapper", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: WRAPPER_COMMAND,
          cwd: REPO_ROOT,
        },
      }),
    );

    const handle = await ensureServer(rosterPath, { readinessBudgetMs: 5000 });
    spawnedPids.push(handle.pid); // wrapper pid (recorded in discovery)

    const childPid = readWrapperChildPid(logFilePath(rosterPath));
    expect(childPid).not.toBeNull();
    const childPidValue = childPid as number;
    spawnedPids.push(childPidValue);

    expect(isAlive(handle.pid)).toBe(true);
    expect(isAlive(childPidValue)).toBe(true);

    const { stopped } = await stopServer(rosterPath);
    expect(stopped).toBe(true);

    // The wrapper (group leader, recorded pid) must be dead.
    expect(await waitUntilDead(handle.pid)).toBe(true);
    // The port-holder CHILD must ALSO be dead — this is the regression:
    // a bare `process.kill(pid, "SIGTERM")` on the wrapper only kills the
    // wrapper, leaking the child as an orphan still holding the port.
    // Only group-signaling (signalGroup: `process.kill(-pid, sig)`) tears
    // down both.
    expect(await waitUntilDead(childPidValue)).toBe(true);
    expect(readDiscovery(rosterPath)).toBeNull();
  }, 15_000);

  test("stopServer escalates to group SIGKILL when the wrapper dies on SIGTERM but its child ignores it", async () => {
    writeRoster(
      makeRoster({
        managed: {
          command: WRAPPER_COMMAND,
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
      spawnedPids.push(handle.pid); // wrapper pid (recorded in discovery)

      const childPid = readWrapperChildPid(logFilePath(rosterPath));
      expect(childPid).not.toBeNull();
      const childPidValue = childPid as number;
      spawnedPids.push(childPidValue);

      expect(isAlive(handle.pid)).toBe(true);
      expect(isAlive(childPidValue)).toBe(true);

      const { stopped } = await stopServer(rosterPath);
      expect(stopped).toBe(true);

      // The wrapper dies fast on SIGTERM (it always forwards it to
      // itself — see wrapper-server.ts), but the child ignores SIGTERM
      // (STUB_IGNORE_SIGTERM=1), so this can only pass if stopServer
      // polled GROUP liveness (waitForGroupDeath) rather than the
      // wrapper's own pid — a wrapper-pid-only check (waitForDeath) would
      // see the wrapper die on SIGTERM and report stopped:true WITHOUT
      // ever escalating to SIGKILL, leaving the child alive and the port
      // held.
      expect(await waitUntilDead(handle.pid)).toBe(true);
      expect(await waitUntilDead(childPidValue)).toBe(true);
      expect(readDiscovery(rosterPath)).toBeNull();
    } finally {
      if (originalEnv === undefined) delete process.env["STUB_IGNORE_SIGTERM"];
      else process.env["STUB_IGNORE_SIGTERM"] = originalEnv;
    }
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
