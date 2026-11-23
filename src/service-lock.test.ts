import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stateDirFor } from "./discovery";
import type { ExecSeam } from "./launchd";
import { serviceLabel } from "./launchd";
import { installService, serviceStatus } from "./service";
import {
  acquireServiceLock,
  processStartTime,
  serviceLockPath,
} from "./service-lock";

let dir: string;
let stateDir: string;
let lockPath: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-bus-service-lock-test-"));
  stateDir = join(dir, "state");
  mkdirSync(stateDir, { mode: 0o700 });
  lockPath = serviceLockPath(stateDir);
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  rmSync(dir, { recursive: true, force: true });
});

function lockBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pid: process.pid,
    startTime: processStartTime(process.pid) ?? "",
    since: Date.now(),
    token: "t".repeat(32),
    ...over,
  });
}

/** A pid that existed and has exited (spawnSync reaps it). */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", ""]);
  if (r.pid === undefined) throw new Error("no pid");
  return r.pid;
}

/** A live child process that is not us. */
function liveChild(): { pid: number; identity: string } {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  children.push(child);
  if (child.pid === undefined) throw new Error("no pid");
  const identity = processStartTime(child.pid);
  if (identity === null) throw new Error("cannot inspect child");
  return { pid: child.pid, identity };
}

describe("acquireServiceLock", () => {
  test("creates a 0600 lock owned by this process and removes it on release", () => {
    const result = acquireServiceLock(stateDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(lockPath).toBe(join(stateDir, "service.lock"));
    expect(statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    result.lock.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  test("is not re-entrant: a second acquire in the same process is refused, then succeeds after release", () => {
    const first = acquireServiceLock(stateDir);
    expect(first.ok).toBe(true);
    const second = acquireServiceLock(stateDir);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toContain("in progress");
    if (first.ok) first.lock.release();
    expect(acquireServiceLock(stateDir).ok).toBe(true);
  });

  test("release is ownership-safe: it never removes a lock carrying another token", () => {
    const mine = acquireServiceLock(stateDir);
    expect(mine.ok).toBe(true);
    if (!mine.ok) return;
    writeFileSync(lockPath, lockBody({ token: "x".repeat(32) })); // someone else's now
    mine.lock.release();
    expect(existsSync(lockPath)).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).token).toBe(
      "x".repeat(32),
    );
    mine.lock.release(); // idempotent
  });

  test("release after the lock vanished does not throw", () => {
    const mine = acquireServiceLock(stateDir);
    if (!mine.ok) throw new Error("expected lock");
    rmSync(lockPath);
    expect(() => mine.lock.release()).not.toThrow();
  });

  test("a live foreign owner is never stolen, and its lock is left untouched", () => {
    const owner = liveChild();
    const body = lockBody({ pid: owner.pid, startTime: owner.identity });
    writeFileSync(lockPath, body);
    const result = acquireServiceLock(stateDir);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(`pid ${owner.pid}`);
    expect(readFileSync(lockPath, "utf8")).toBe(body);
  });

  test("an owner whose identity could not be recorded is treated as live (conservative)", () => {
    const owner = liveChild();
    writeFileSync(lockPath, lockBody({ pid: owner.pid, startTime: "" }));
    expect(acquireServiceLock(stateDir).ok).toBe(false);
  });

  test("a crashed owner's lock is reclaimed", () => {
    writeFileSync(lockPath, lockBody({ pid: deadPid(), startTime: "gone" }));
    const result = acquireServiceLock(stateDir);
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(lockPath, "utf8")).pid).toBe(process.pid);
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false); // mutex cleaned up
  });

  test("a recycled pid (alive, different identity) is reclaimed", () => {
    const owner = liveChild();
    writeFileSync(
      lockPath,
      lockBody({ pid: owner.pid, startTime: "Thu Jan  1 00:00:00 1970 other" }),
    );
    expect(acquireServiceLock(stateDir).ok).toBe(true);
  });

  test("a malformed lock is never reclaimed, whatever its age: fail closed with operator guidance", () => {
    for (const body of ["", "{not json", JSON.stringify({ pid: 5 })]) {
      writeFileSync(lockPath, body);
      for (const ageMs of [0, 60_000, 30 * 86_400_000]) {
        const when = new Date(Date.now() - ageMs);
        utimesSync(lockPath, when, when);
        const result = acquireServiceLock(stateDir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain(lockPath);
          expect(result.error).toContain("Do not remove it unless");
        }
        expect(readFileSync(lockPath, "utf8")).toBe(body); // untouched
        expect(existsSync(`${lockPath}.reclaim`)).toBe(false);
      }
    }
  });

  test("a lock with no recorded start time is only reclaimed when its pid is provably gone", () => {
    writeFileSync(lockPath, lockBody({ pid: deadPid(), startTime: "" }));
    expect(acquireServiceLock(stateDir).ok).toBe(true);
    rmSync(lockPath);
    const owner = liveChild();
    writeFileSync(lockPath, lockBody({ pid: owner.pid, startTime: "" }));
    expect(acquireServiceLock(stateDir).ok).toBe(false);
  });

  test("an unsignalable pid (EPERM) is not evidence of death", () => {
    // A root-owned pid we are not allowed to signal (or any live pid when root).
    const ps = spawnSync("ps", ["-axo", "pid=,user="], { encoding: "utf8" });
    const row = ps.stdout
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .find(([pid, user]) => Number(pid) > 1 && user === "root");
    if (!row) return; // no such process visible here
    const pid = Number(row[0]);
    const startTime = processStartTime(pid);
    if (startTime === null) return;
    writeFileSync(lockPath, lockBody({ pid, startTime }));
    expect(acquireServiceLock(stateDir).ok).toBe(false);
  });

  test("lock I/O failures are an explicit ok:false, never a throw", () => {
    mkdirSync(lockPath); // a directory squatting on the lock path
    const squatted = acquireServiceLock(stateDir);
    expect(squatted.ok).toBe(false);
    if (!squatted.ok) expect(squatted.error).toContain(lockPath);

    const missing = acquireServiceLock(join(dir, "no-such-state-dir"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("failed to acquire");
  });

  test("a leftover reclaim mutex fails fast and leaves the lock alone", () => {
    const body = lockBody({ pid: deadPid(), startTime: "gone" });
    writeFileSync(lockPath, body);
    writeFileSync(`${lockPath}.reclaim`, "1");
    const result = acquireServiceLock(stateDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("reclaim");
      expect(result.error).toContain("Do not remove");
    }
    expect(readFileSync(lockPath, "utf8")).toBe(body);
  });
});

// --- cross-process --------------------------------------------------------------

/** Child script: tries to take the lock, reports won/busy, holds until stdin ends. */
function writeHolderScript(): string {
  const script = join(dir, "holder.ts");
  writeFileSync(
    script,
    `import { acquireServiceLock } from ${JSON.stringify(join(import.meta.dir, "service-lock.ts"))};
const r = acquireServiceLock(process.argv[2] as string);
process.stdout.write(r.ok ? "won\\n" : "busy\\n");
if (r.ok) {
  process.stdin.resume();
  process.stdin.on("end", () => { r.lock.release(); process.exit(0); });
} else {
  process.exit(0);
}
`,
  );
  return script;
}

function startHolder(
  script: string,
  targetStateDir: string = stateDir,
): {
  outcome: Promise<"won" | "busy">;
  finish: () => Promise<void>;
} {
  const child = spawn(process.execPath, [script, targetStateDir], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  children.push(child);
  const outcome = new Promise<"won" | "busy">((resolve, reject) => {
    child.stdout?.once("data", (d: Buffer) =>
      resolve(String(d).trim() === "won" ? "won" : "busy"),
    );
    child.once("error", reject);
  });
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  return {
    outcome,
    finish: async () => {
      child.stdin?.end();
      await exited;
    },
  };
}

describe("cross-process", () => {
  test("a lock held by another process makes install fail fast without mutation, then install succeeds after it exits", async () => {
    const roster = join(dir, "spacebus.json");
    const rosterState = stateDirFor(roster);
    mkdirSync(rosterState, { recursive: true, mode: 0o700 });
    const holder = startHolder(writeHolderScript(), rosterState);
    expect(await holder.outcome).toBe("won");

    const calls: string[][] = [];
    const exec: ExecSeam = async (args) => {
      calls.push(args);
      return args[0] === "print"
        ? { code: 0, stdout: "pid = 7\n", stderr: "" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const base = {
      exec,
      platform: "darwin" as const,
      launchAgentsDir: join(dir, "LaunchAgents"),
      uid: 501,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: () => ({ running: true as const, pid: 7 }),
      sleep: async () => {},
    };

    const blocked = await installService(roster, base);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toContain("in progress");
    expect(calls).toEqual([]);
    expect(existsSync(base.launchAgentsDir)).toBe(false);
    // status is independent of the lock
    expect((await serviceStatus(roster, base)).ok).toBe(true);

    await holder.finish();
    const after = await installService(roster, base);
    expect(after.ok).toBe(true);
    expect(after.ok && after.label).toBe(serviceLabel(roster));
  });

  test("a crashed holder (killed, lock left behind) does not wedge the next acquirer", async () => {
    const holder = startHolder(writeHolderScript());
    expect(await holder.outcome).toBe("won");
    const child = children[children.length - 1] as ChildProcess;
    child.kill("SIGKILL"); // our own child; simulates a crash without release
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(existsSync(lockPath)).toBe(true); // stale lock left behind
    expect(acquireServiceLock(stateDir).ok).toBe(true); // reclaimed: owner is dead
  });

  test("six processes racing over one abandoned lock: exactly one wins", async () => {
    writeFileSync(lockPath, lockBody({ pid: deadPid(), startTime: "gone" }));
    const script = writeHolderScript();
    const racers = Array.from({ length: 6 }, () => startHolder(script));
    const outcomes = await Promise.all(racers.map((r) => r.outcome));
    expect(outcomes.filter((o) => o === "won")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "busy")).toHaveLength(5);
    await Promise.all(racers.map((r) => r.finish()));
    expect(existsSync(lockPath)).toBe(false); // the winner released its own lock
  });
});
