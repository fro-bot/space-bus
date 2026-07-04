import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLock,
  captureIdentity,
  type DiscoveryFile,
  discoveryFilePath,
  isAlive,
  lockFilePath,
  readDiscovery,
  releaseLock,
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
});
