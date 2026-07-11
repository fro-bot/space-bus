import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rosterKey } from "./discovery";
import type { ExecResult, ExecSeam } from "./launchd";
import { plistPath, serviceLabel } from "./launchd";
import type { ServerStatus } from "./server";
import {
  installService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "./service";

let dir: string;
let rosterPath: string;
let launchAgentsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-bus-service-test-"));
  rosterPath = join(dir, "spacebus.json");
  launchAgentsDir = join(dir, "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// --- Test seam helpers -----------------------------------------------------

type ExecResponder = (args: string[]) => ExecResult;

function makeExecSeam(responder: ExecResponder) {
  const calls: string[][] = [];
  const seam: ExecSeam = async (args) => {
    calls.push(args);
    return responder(args);
  };
  return { seam, calls };
}

/** Default responder: printJob reports not-loaded, everything else ok(0). */
function notLoadedResponder(args: string[]): ExecResult {
  if (args[0] === "print")
    return { code: 3, stdout: "", stderr: "Could not find" };
  return { code: 0, stdout: "", stderr: "" };
}

function loadedResponder(pid: number): ExecResponder {
  return (args: string[]) => {
    if (args[0] === "print") {
      return {
        code: 0,
        stdout: `\tpid = ${pid}\n\tstate = running\n`,
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
}

/** Instant sleep for tests. */
async function instantSleep(): Promise<void> {}

function stubServerStatus(running: boolean, pid?: number): () => ServerStatus {
  return () =>
    running ? { running: true, pid, port: 1234 } : { running: false };
}

// plistPath is injectable via ServiceDeps.launchAgentsDir — every test
// below passes a per-test mkdtemp `launchAgentsDir` so nothing ever reads
// or writes the operator's real ~/Library/LaunchAgents.
function plistPathFor(roster: string): string {
  return plistPath(serviceLabel(roster), launchAgentsDir);
}

const UID = 501;

// --- install ---------------------------------------------------------------

describe("installService", () => {
  test("happy path: writes plist, bootstraps, kickstarts, verifies up", async () => {
    const pid = 4242;
    const { seam, calls } = makeExecSeam((args) => {
      if (args[0] === "print") {
        return { code: 0, stdout: `\tpid = ${pid}\n`, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/usr/local/bin/bun",
      cliEntryPath: "/usr/local/lib/space-bus/dist/cli.js",
      serverStatus: stubServerStatus(true, pid),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.label).toBe(serviceLabel(rosterPath));
    expect(result.plistPath).toBe(plistPathFor(rosterPath));
    expect(result.pid).toBe(pid);
    expect(result.warning).toBeUndefined();
    expect(existsSync(result.plistPath)).toBe(true);

    // Verify the essential sequence: bootstrap and kickstart both called
    // with the plist/label.
    const argsList = calls.map((c) => c.join(" "));
    expect(argsList.some((a) => a.startsWith(`bootstrap gui/${UID}`))).toBe(
      true,
    );
    expect(
      argsList.some(
        (a) => a === `kickstart -k gui/${UID}/${serviceLabel(rosterPath)}`,
      ),
    ).toBe(true);
  });

  test("logs pre-created 0600 before load", async () => {
    const { seam } = makeExecSeam(loadedResponder(1));
    process.env["XDG_STATE_HOME"] = join(dir, "xdg-state");
    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });
    expect(result.ok).toBe(true);
    const stateDir = join(dir, "xdg-state", "space-bus", rosterKey(rosterPath));
    const outLog = join(stateDir, "service.log");
    const errLog = join(stateDir, "service.err.log");
    expect(existsSync(outLog)).toBe(true);
    expect(existsSync(errLog)).toBe(true);
    expect(statSync(outLog).mode & 0o777).toBe(0o600);
    expect(statSync(errLog).mode & 0o777).toBe(0o600);
    delete process.env["XDG_STATE_HOME"];
  });

  test("already-loaded roster: bootout precedes bootstrap, exactly one plist", async () => {
    const printCalls: string[][] = [];
    const { seam, calls } = makeExecSeam((args) => {
      if (args[0] === "print") {
        printCalls.push(args);
        // First print (pre-install check) reports loaded; verification
        // prints later also report loaded.
        return { code: 0, stdout: "\tpid = 99\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 99),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(true);
    const argsList = calls.map((c) => c.join(" "));
    const bootoutIdx = argsList.findIndex((a) =>
      a.startsWith(`bootout gui/${UID}`),
    );
    const bootstrapIdx = argsList.findIndex((a) =>
      a.startsWith(`bootstrap gui/${UID}`),
    );
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);

    // Only one plist file should exist for this roster.
    expect(existsSync(plistPathFor(rosterPath))).toBe(true);
  });

  test("bootstrap fails => ok:false with stderr surfaced, no success", async () => {
    const { seam } = makeExecSeam((args) => {
      if (args[0] === "print") return { code: 3, stdout: "", stderr: "" };
      if (args[0] === "bootstrap") {
        return { code: 5, stdout: "", stderr: "Bootstrap failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(false),
      sleep: instantSleep,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Bootstrap failed");
  });

  test("verification timeout: printJob loaded but serverStatus never running", async () => {
    const { seam } = makeExecSeam((args) => {
      if (args[0] === "print")
        return { code: 0, stdout: "\tpid = 5\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });

    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(false),
      sleep: instantSleep,
      verifyBudgetMs: 10,
      verifyPollMs: 1,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("did not verify as running");
  });

  test("ephemeral-cache execPath produces a warning on success", async () => {
    const { seam } = makeExecSeam(loadedResponder(7));
    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/Users/marcus/.bun/install/cache/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 7),
      sleep: instantSleep,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain("ephemeral");
  });
});

// --- uninstall ---------------------------------------------------------------

describe("uninstallService", () => {
  test("loaded job: bootout called, plist removed", async () => {
    const { seam } = makeExecSeam(loadedResponder(1));
    // Pre-write a plist by installing first (with a passing verify).
    const install = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });
    expect(install.ok).toBe(true);

    const { seam: uninstallSeam, calls } = makeExecSeam(loadedResponder(1));
    const result = await uninstallService(rosterPath, {
      exec: uninstallSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removed.job).toBe(true);
    expect(result.removed.plist).toBe(true);
    expect(calls.some((c) => c[0] === "bootout")).toBe(true);
    expect(existsSync(plistPathFor(rosterPath))).toBe(false);
  });

  test("not-loaded + no plist: still ok with removed flags false", async () => {
    const { seam } = makeExecSeam(notLoadedResponder);
    const result = await uninstallService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.removed.job).toBe(false);
    expect(result.removed.plist).toBe(false);
  });
});

// --- status ------------------------------------------------------------------

describe("serviceStatus", () => {
  test("all-false when nothing exists (no error)", async () => {
    const { seam } = makeExecSeam(notLoadedResponder);
    const result = await serviceStatus(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      serverStatus: stubServerStatus(false),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toBe(false);
    expect(result.loaded).toBe(false);
    expect(result.running).toBe(false);
  });

  test("installed-only: plist present, print non-zero", async () => {
    const { seam: installSeam } = makeExecSeam(loadedResponder(1));
    await installService(rosterPath, {
      exec: installSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });

    const { seam: statusSeam } = makeExecSeam(notLoadedResponder);
    const result = await serviceStatus(rosterPath, {
      exec: statusSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      serverStatus: stubServerStatus(false),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toBe(true);
    expect(result.loaded).toBe(false);
    expect(result.running).toBe(false);
  });

  test("full-up mapping with pid", async () => {
    const { seam } = makeExecSeam(loadedResponder(321));
    const result = await serviceStatus(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      serverStatus: stubServerStatus(true, 321),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.loaded).toBe(true);
    expect(result.running).toBe(true);
    expect(result.pid).toBe(321);
  });
});

// --- stop / start --------------------------------------------------------------

describe("stopService", () => {
  test("bootout called; plist stays on disk after", async () => {
    const { seam: installSeam } = makeExecSeam(loadedResponder(1));
    await installService(rosterPath, {
      exec: installSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });

    const { seam, calls } = makeExecSeam(loadedResponder(1));
    const result = await stopService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[0] === "bootout")).toBe(true);
    expect(existsSync(plistPathFor(rosterPath))).toBe(true);
  });
});

describe("startService", () => {
  test("bootstrap+kickstart sequence, ok on stopped roster", async () => {
    const { seam: installSeam } = makeExecSeam(loadedResponder(1));
    await installService(rosterPath, {
      exec: installSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });

    const { seam, calls } = makeExecSeam(loadedResponder(2));
    const result = await startService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(result.ok).toBe(true);
    const argsList = calls.map((c) => c.join(" "));
    expect(argsList.some((a) => a.startsWith("bootstrap"))).toBe(true);
    expect(argsList.some((a) => a.startsWith("kickstart"))).toBe(true);
  });

  test("no plist => ok:false actionable", async () => {
    const { seam } = makeExecSeam(notLoadedResponder);
    const result = await startService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("not installed");
  });
});

// --- platform gate ---------------------------------------------------------

describe("platform gate", () => {
  test("every verb on linux fails with the not-supported error, exec never called", async () => {
    const { seam, calls } = makeExecSeam(notLoadedResponder);
    const deps = {
      exec: seam,
      platform: "linux" as NodeJS.Platform,
      uid: UID,
      launchAgentsDir,
    };

    const install = await installService(rosterPath, {
      ...deps,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(false),
    });
    const uninstall = await uninstallService(rosterPath, deps);
    const status = await serviceStatus(rosterPath, {
      ...deps,
      serverStatus: stubServerStatus(false),
    });
    const stop = await stopService(rosterPath, deps);
    const start = await startService(rosterPath, deps);

    for (const result of [install, uninstall, status, stop, start]) {
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          "space-bus service is not supported on this platform (v1 supports macOS/launchd)",
        );
      }
    }
    expect(calls.length).toBe(0);
  });
});

// --- two rosters -------------------------------------------------------------

describe("two rosters", () => {
  test("distinct labels/plists; uninstall of one leaves the other's plist", async () => {
    const rosterA = join(dir, "a", "spacebus.json");
    const rosterB = join(dir, "b", "spacebus.json");

    expect(serviceLabel(rosterA)).not.toBe(serviceLabel(rosterB));

    const { seam: seamA } = makeExecSeam(loadedResponder(1));
    const { seam: seamB } = makeExecSeam(loadedResponder(2));

    const installA = await installService(rosterA, {
      exec: seamA,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });
    const installB = await installService(rosterB, {
      exec: seamB,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 2),
      sleep: instantSleep,
    });
    expect(installA.ok).toBe(true);
    expect(installB.ok).toBe(true);

    const { seam: uninstallSeam } = makeExecSeam(loadedResponder(1));
    const uninstall = await uninstallService(rosterA, {
      exec: uninstallSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(uninstall.ok).toBe(true);

    expect(existsSync(plistPathFor(rosterA))).toBe(false);
    expect(existsSync(plistPathFor(rosterB))).toBe(true);
  });
});
