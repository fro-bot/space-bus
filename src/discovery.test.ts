import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  attachLive,
  captureIdentity,
  type DiscoveryFile,
  discoveryFilePath,
  isAlive,
  lockFilePath,
  readDiscovery,
  releaseLock,
  removeDiscoveryIfMatches,
  stateDirFor,
  verifyIdentity,
  writeDiscovery,
} from "./discovery";

let dir: string;
let rosterPath: string;

function makeDiscovery(overrides: Partial<DiscoveryFile> = {}): DiscoveryFile {
  return {
    port: 4096,
    pid: process.pid,
    identity: captureIdentity(process.pid) ?? "test-identity",
    password: "test-password",
    spawnConfig: { command: ["harness", "serve"] },
    baseUrl: "http://127.0.0.1:4096",
    ...overrides,
  };
}

describe("discovery", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "space-bus-discovery-test-"));
    rosterPath = join(dir, "spacebus.json");
    writeFileSync(rosterPath, "{}");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writeDiscovery creates the state dir 0700 and the file 0600", () => {
    writeDiscovery(rosterPath, makeDiscovery());
    const stateDir = stateDirFor(rosterPath);
    const dirMode = statSync(stateDir).mode & 0o777;
    expect(dirMode).toBe(0o700);
    const fileMode = statSync(discoveryFilePath(rosterPath)).mode & 0o777;
    expect(fileMode).toBe(0o600);
  });

  test("readDiscovery round-trips a written file", () => {
    const data = makeDiscovery();
    writeDiscovery(rosterPath, data);
    expect(readDiscovery(rosterPath)).toEqual(data);
  });

  test("readDiscovery returns null when the file is absent", () => {
    expect(readDiscovery(rosterPath)).toBeNull();
  });

  test("readDiscovery returns null when the file is corrupt", () => {
    writeDiscovery(rosterPath, makeDiscovery());
    writeFileSync(discoveryFilePath(rosterPath), "not json{{{");
    expect(readDiscovery(rosterPath)).toBeNull();
  });

  test("readDiscovery round-trips a written file with rosterPath present", () => {
    const data = makeDiscovery({ rosterPath });
    writeDiscovery(rosterPath, data);
    expect(readDiscovery(rosterPath)).toEqual(data);
  });

  test("readDiscovery parses a pre-field discovery file (no rosterPath) — regression", () => {
    // Simulates a discovery file written before this field existed: no
    // rosterPath key at all, not merely undefined.
    const { rosterPath: _omit, ...preFieldData } = makeDiscovery();
    const dir2 = stateDirFor(rosterPath);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(discoveryFilePath(rosterPath), JSON.stringify(preFieldData));

    const parsed = readDiscovery(rosterPath);
    expect(parsed).toEqual(preFieldData);
    expect(parsed?.rosterPath).toBeUndefined();
  });

  test("attachLive still attaches against a pre-field discovery file — regression", () => {
    const { rosterPath: _omit, ...preFieldData } = makeDiscovery({
      baseUrl: "http://127.0.0.1:4096",
    });
    const dir2 = stateDirFor(rosterPath);
    mkdirSync(dir2, { recursive: true });
    writeFileSync(discoveryFilePath(rosterPath), JSON.stringify(preFieldData));

    const live = attachLive(rosterPath);
    expect(live).not.toBeNull();
    expect(live?.pid).toBe(preFieldData.pid);
  });

  test("readDiscovery returns null when the file fails schema validation", () => {
    writeDiscovery(rosterPath, makeDiscovery());
    writeFileSync(
      discoveryFilePath(rosterPath),
      JSON.stringify({ port: "not-a-number" }),
    );
    expect(readDiscovery(rosterPath)).toBeNull();
  });

  test("isAlive is true for the current process", () => {
    expect(isAlive(process.pid)).toBe(true);
  });

  test("isAlive is false for a definitely-dead pid", () => {
    // A very high pid unlikely to be assigned; also verify via ESRCH shape.
    const deadPid = 2_147_483_000;
    expect(isAlive(deadPid)).toBe(false);
  });

  test("verifyIdentity rejects a mismatched identity string (simulated recycled pid)", () => {
    expect(verifyIdentity(process.pid, "bogus-identity-string")).toBe(false);
  });

  test("verifyIdentity accepts the current process's real identity", () => {
    const identity = captureIdentity(process.pid);
    expect(identity).not.toBeNull();
    expect(verifyIdentity(process.pid, identity as string)).toBe(true);
  });

  test("verifyIdentity rejects a dead pid regardless of identity string", () => {
    expect(verifyIdentity(2_147_483_000, "anything")).toBe(false);
  });

  test("acquireLock succeeds when no lock exists, and releaseLock clears it", () => {
    const handle = acquireLock(rosterPath);
    expect(handle).not.toBeNull();
    expect(readDiscovery).toBeDefined(); // sanity import usage
    releaseLock(handle as NonNullable<typeof handle>);
  });

  test("a second acquireLock returns null while the first is held by a live owner", () => {
    const first = acquireLock(rosterPath);
    expect(first).not.toBeNull();
    try {
      const second = acquireLock(rosterPath);
      expect(second).toBeNull();
    } finally {
      releaseLock(first as NonNullable<typeof first>);
    }
  });

  test("a corrupt (empty) lock file older than the grace window is reclaimed rather than wedging forever", () => {
    // Simulate the winner-crashed-before-writeFileSync scenario: an
    // O_EXCL-created file that never got its JSON body written, well past
    // the corrupt-lock grace so it's treated as genuinely abandoned.
    const target = lockFilePath(rosterPath);
    mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
    writeFileSync(target, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(target, old, old);
    const handle = acquireLock(rosterPath);
    expect(handle).not.toBeNull();
    releaseLock(handle as NonNullable<typeof handle>);
  });

  test("a corrupt (non-JSON) lock file older than the grace window is reclaimed rather than wedging forever", () => {
    const target = lockFilePath(rosterPath);
    mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
    writeFileSync(target, "not json{{{");
    const old = new Date(Date.now() - 60_000);
    utimesSync(target, old, old);
    const handle = acquireLock(rosterPath);
    expect(handle).not.toBeNull();
    releaseLock(handle as NonNullable<typeof handle>);
  });

  test("attachLive accepts a bracketed IPv6 loopback baseUrl (http://[::1]:PORT)", () => {
    // VERIFIED: new URL("http://[::1]:3000").hostname === "[::1]" (with
    // brackets) on both node and bun — LOOPBACK_HOSTS must include the
    // bracketed form or IPv6 loopback discovery is wrongly rejected.
    writeDiscovery(rosterPath, makeDiscovery({ baseUrl: "http://[::1]:4096" }));
    expect(attachLive(rosterPath)).not.toBeNull();
  });

  test("a fresh empty lock file (mtime now) is NOT reclaimed", () => {
    const target = lockFilePath(rosterPath);
    mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
    writeFileSync(target, "");
    // mtime defaults to "now" — within the corrupt-lock grace window, so a
    // contender must not be able to steal it from a possibly-live writer
    // that was preempted between O_EXCL create and writeFileSync.
    const handle = acquireLock(rosterPath);
    expect(handle).toBeNull();
  });

  test("an old empty lock file (mtime backdated past grace) IS reclaimed", () => {
    const target = lockFilePath(rosterPath);
    mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
    writeFileSync(target, "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(target, old, old);
    const handle = acquireLock(rosterPath);
    expect(handle).not.toBeNull();
    releaseLock(handle as NonNullable<typeof handle>);
  });

  test("a lock owned by a dead pid is reclaimed", () => {
    // Simulate a stale lock: dead pid + bogus identity written directly.
    const target = lockFilePath(rosterPath);
    mkdirSync(stateDirFor(rosterPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      target,
      JSON.stringify({
        pid: 2_147_483_000,
        startTime: "bogus-identity",
        since: Date.now() - 60_000,
      }),
    );
    const handle = acquireLock(rosterPath);
    expect(handle).not.toBeNull();
    releaseLock(handle as NonNullable<typeof handle>);
  });

  // --- removeDiscoveryIfMatches (compare-and-delete) ------------------------

  test("removeDiscoveryIfMatches removes the file when pid+identity match", () => {
    const data = makeDiscovery();
    writeDiscovery(rosterPath, data);
    removeDiscoveryIfMatches(rosterPath, {
      pid: data.pid,
      identity: data.identity,
    });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("removeDiscoveryIfMatches leaves the file intact when identity differs (simulated respawn)", () => {
    const data = makeDiscovery();
    writeDiscovery(rosterPath, data);
    removeDiscoveryIfMatches(rosterPath, {
      pid: data.pid,
      identity: "some-other-fresh-identity",
    });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
    expect(readDiscovery(rosterPath)).toEqual(data);
  });

  test("removeDiscoveryIfMatches leaves the file intact when pid differs", () => {
    const data = makeDiscovery();
    writeDiscovery(rosterPath, data);
    removeDiscoveryIfMatches(rosterPath, {
      pid: 2_147_483_000,
      identity: data.identity,
    });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
    expect(readDiscovery(rosterPath)).toEqual(data);
  });

  test("removeDiscoveryIfMatches is a no-op and does not throw when no file is present", () => {
    expect(() =>
      removeDiscoveryIfMatches(rosterPath, {
        pid: process.pid,
        identity: "anything",
      }),
    ).not.toThrow();
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("removeDiscoveryIfMatches does not throw when the on-disk record is corrupt", () => {
    writeDiscovery(rosterPath, makeDiscovery());
    writeFileSync(discoveryFilePath(rosterPath), "not json{{{");
    expect(() =>
      removeDiscoveryIfMatches(rosterPath, {
        pid: process.pid,
        identity: "anything",
      }),
    ).not.toThrow();
  });

  // --- attachLive dead-pid cleanup (Unit 2) ---------------------------------

  test("attachLive removes the stale discovery file when identity verification fails (dead pid)", () => {
    writeDiscovery(
      rosterPath,
      makeDiscovery({ pid: 2_147_483_000, identity: "bogus-identity" }),
    );
    expect(attachLive(rosterPath)).toBeNull();
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(false);
  });

  test("attachLive leaves an alive+verified discovery record untouched", () => {
    writeDiscovery(rosterPath, makeDiscovery());
    const endpoint = attachLive(rosterPath);
    expect(endpoint).not.toBeNull();
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
  });

  test("removeDiscoveryIfMatches preserves a record whose identity differs from the stale expected key", () => {
    // Simulate: a stale dead-pid record was read, but by the time cleanup
    // runs the on-disk file has already been overwritten by a fresh
    // respawn with a different identity. We can't hit the exact race
    // window, but we can prove the underlying primitive protects a fresh
    // record even under attachLive's real read path by writing the fresh
    // record with an identity that differs from what a stale read would
    // have captured, then invoking removeDiscoveryIfMatches with the
    // stale key directly (the same call attachLive makes internally).
    const freshIdentity = captureIdentity(process.pid) ?? "fresh-identity";
    writeDiscovery(
      rosterPath,
      makeDiscovery({ pid: process.pid, identity: freshIdentity }),
    );
    removeDiscoveryIfMatches(rosterPath, {
      pid: process.pid,
      identity: "stale-identity-from-dead-record",
    });
    expect(existsSync(discoveryFilePath(rosterPath))).toBe(true);
  });
});
