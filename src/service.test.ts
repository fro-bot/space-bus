import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resolveRosterPath } from "./config";
import { rosterKey, stateDirFor } from "./discovery";
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
    // P1-F: never `delete` XDG_STATE_HOME — the global test-suite preload
    // (test/setup.ts) sets it to an isolated temp root precisely so no
    // test ever falls through to the real ~/.local/state. Save and
    // restore the prior (isolated) value instead, in a finally, so a
    // thrown assertion above can't leave XDG_STATE_HOME unset for
    // whatever test runs next in this process (the same incident class
    // already fired this session — see
    // docs/solutions/best-practices/test-isolation-xdg-state-home-2026-07-05.md).
    const previousXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = join(dir, "xdg-state");
    try {
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
      const stateDir = join(
        dir,
        "xdg-state",
        "space-bus",
        rosterKey(rosterPath),
      );
      const outLog = join(stateDir, "service.log");
      const errLog = join(stateDir, "service.err.log");
      expect(existsSync(outLog)).toBe(true);
      expect(existsSync(errLog)).toBe(true);
      expect(statSync(outLog).mode & 0o777).toBe(0o600);
      expect(statSync(errLog).mode & 0o777).toBe(0o600);
    } finally {
      if (previousXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = previousXdgStateHome;
      }
    }
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
      if (args[0] === "print")
        return { code: 3, stdout: "", stderr: "Could not find" };
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

  test("P1-B regression: install fails fast on failed bootout of an already-loaded job", async () => {
    const { seam } = makeExecSeam((args) => {
      if (args[0] === "print") {
        return { code: 0, stdout: "\tpid = 99\n", stderr: "" };
      }
      if (args[0] === "bootout") {
        return { code: 1, stdout: "", stderr: "bootout failed hard" };
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
    expect(result.error).toContain("bootout failed hard");
    // Must fail BEFORE writing/bootstrapping the refreshed plist.
    expect(existsSync(plistPathFor(rosterPath))).toBe(false);
  });

  test("install: ordered launchctl subsequence — bootout < bootstrap < kickstart < verify-print", async () => {
    const { seam, calls } = makeExecSeam(loadedResponder(5));
    const result = await installService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 5),
      sleep: instantSleep,
    });
    expect(result.ok).toBe(true);
    const verbs = calls.map((c) => c[0]);
    const bootoutIdx = verbs.indexOf("bootout");
    const bootstrapIdx = verbs.indexOf("bootstrap");
    const kickstartIdx = verbs.indexOf("kickstart");
    const lastPrintIdx = verbs.lastIndexOf("print");
    expect(bootoutIdx).toBeGreaterThanOrEqual(0);
    expect(bootstrapIdx).toBeGreaterThan(bootoutIdx);
    expect(kickstartIdx).toBeGreaterThan(bootstrapIdx);
    expect(lastPrintIdx).toBeGreaterThan(kickstartIdx);
  });

  test("install: rendered plist EnvironmentVariables.SPACE_BUS_CONFIG matches the resolved roster path", async () => {
    const { seam } = makeExecSeam(loadedResponder(1));
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
    if (!result.ok) return;
    const { readFileSync } = await import("node:fs");
    const xml = readFileSync(result.plistPath, "utf8");
    expect(xml).toContain("<key>SPACE_BUS_CONFIG</key>");
    const match =
      /<key>SPACE_BUS_CONFIG<\/key>\s*<string>([^<]*)<\/string>/.exec(xml);
    expect(match?.[1]).toBe(rosterPath);
  });

  test("install: pins absolute XDG_STATE_HOME into the plist when set at install time", async () => {
    const previousXdgStateHome = process.env["XDG_STATE_HOME"];
    const xdgRoot = join(dir, "xdg-state-pin");
    process.env["XDG_STATE_HOME"] = xdgRoot;
    try {
      const { seam } = makeExecSeam(loadedResponder(1));
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
      if (!result.ok) return;
      const { readFileSync } = await import("node:fs");
      const xml = readFileSync(result.plistPath, "utf8");
      expect(xml).toContain("<key>XDG_STATE_HOME</key>");
      expect(xml).toContain(`<string>${xdgRoot}</string>`);
    } finally {
      if (previousXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = previousXdgStateHome;
      }
    }
  });

  test("install: rejects a relative XDG_STATE_HOME", async () => {
    const previousXdgStateHome = process.env["XDG_STATE_HOME"];
    process.env["XDG_STATE_HOME"] = "relative/path";
    try {
      const { seam } = makeExecSeam(loadedResponder(1));
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
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain("absolute");
    } finally {
      if (previousXdgStateHome === undefined) {
        delete process.env["XDG_STATE_HOME"];
      } else {
        process.env["XDG_STATE_HOME"] = previousXdgStateHome;
      }
    }
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
  test("P1-B regression: bootout failure preserves plist and returns ok:false", async () => {
    const { seam: installSeam } = makeExecSeam(loadedResponder(1));
    const install = await installService(rosterPath, {
      exec: installSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });
    expect(install.ok).toBe(true);

    // Job stays loaded (print always reports loaded) but bootout fails —
    // must not degrade to ok:true / plist removal.
    const { seam } = makeExecSeam((args) => {
      if (args[0] === "print") {
        return { code: 0, stdout: "\tpid = 1\n", stderr: "" };
      }
      if (args[0] === "bootout") {
        return { code: 1, stdout: "", stderr: "bootout failed" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const result = await uninstallService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("bootout failed");
    expect(existsSync(plistPathFor(rosterPath))).toBe(true);
  });

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
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 2),
      sleep: instantSleep,
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

  test("P1-D regression: start returns ok:false when the daemon never becomes running", async () => {
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

    // Job reports loaded (print zero-exit) but serverStatus never flips
    // to running — start must not report success for a loaded-but-not-
    // running daemon.
    const { seam } = makeExecSeam(loadedResponder(2));
    const result = await startService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      serverStatus: stubServerStatus(false),
      sleep: instantSleep,
      verifyBudgetMs: 10,
      verifyPollMs: 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("did not verify as running");
  });

  test("P1-D regression: start re-renders the plist before bootstrap (tamper-resistant)", async () => {
    const { seam: installSeam } = makeExecSeam(loadedResponder(1));
    const install = await installService(rosterPath, {
      exec: installSeam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 1),
      sleep: instantSleep,
    });
    expect(install.ok).toBe(true);
    if (!install.ok) return;

    // Tamper with the on-disk plist (simulate a stale/tampered file) —
    // start must overwrite it with a freshly-rendered, trusted plist
    // rather than bootstrapping the tampered content as-is.
    const { writeFileSync, readFileSync } = await import("node:fs");
    writeFileSync(install.plistPath, "<plist>TAMPERED</plist>");

    const { seam } = makeExecSeam(loadedResponder(2));
    const result = await startService(rosterPath, {
      exec: seam,
      platform: "darwin",
      launchAgentsDir,
      uid: UID,
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 2),
      sleep: instantSleep,
    });
    expect(result.ok).toBe(true);
    const xml = readFileSync(install.plistPath, "utf8");
    expect(xml).not.toContain("TAMPERED");
    expect(xml).toContain("<key>Label</key>");
  });

  test("start: ordered launchctl subsequence — bootstrap < kickstart < print", async () => {
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
      execPath: "/bin/bun",
      cliEntryPath: "/bin/cli.js",
      serverStatus: stubServerStatus(true, 2),
      sleep: instantSleep,
    });
    expect(result.ok).toBe(true);
    const verbs = calls.map((c) => c[0]);
    const bootstrapIdx = verbs.indexOf("bootstrap");
    const kickstartIdx = verbs.indexOf("kickstart");
    const printIdx = verbs.indexOf("print");
    expect(bootstrapIdx).toBeGreaterThanOrEqual(0);
    expect(kickstartIdx).toBeGreaterThan(bootstrapIdx);
    expect(printIdx).toBeGreaterThan(kickstartIdx);
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

// --- dangling roster alias (#81 item 2) -----------------------------------
//
// `resolveRosterPath` realpaths an EXISTING roster, so install keys the label,
// state dir and plist roster path on the canonical target. Once the canonical
// file is deleted, a symlink alias no longer resolves, and every verb used to
// hash the alias itself: status said not-installed, uninstall removed nothing
// and a re-install created a second job. The service verbs now follow the
// alias's own link chain to the same canonical identity.

/** Stateful fake launchctl: bootstrap/bootout actually (un)load a label. */
function makeFakeLaunchctl() {
  const loaded = new Set<string>();
  const calls: string[][] = [];
  const seam: ExecSeam = async (args) => {
    calls.push(args);
    const [verb, target, plist] = args;
    const label = (target ?? "").split("/").pop() ?? "";
    if (verb === "print") {
      return loaded.has(label)
        ? { code: 0, stdout: "\tpid = 4242\n", stderr: "" }
        : { code: 3, stdout: "", stderr: "Could not find service" };
    }
    if (verb === "bootstrap") loaded.add(basename(plist ?? "", ".plist"));
    if (verb === "bootout") loaded.delete(label);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { seam, loaded, calls };
}

function aliasDeps(fake: ReturnType<typeof makeFakeLaunchctl>) {
  return {
    exec: fake.seam,
    platform: "darwin" as const,
    launchAgentsDir,
    uid: UID,
    execPath: "/usr/local/bin/bun",
    cliEntryPath: "/usr/local/lib/space-bus/dist/cli.js",
    serverStatus: stubServerStatus(true, 4242),
    sleep: instantSleep,
  };
}

describe("service identity through a dangling roster alias", () => {
  /** Canonical roster `real/spacebus.json` + `alias.json` -> it; installed
   * the way the CLI does (resolveRosterPath realpaths an existing roster). */
  async function installedViaAlias(makeAlias: (canonical: string) => string) {
    mkdirSync(join(dir, "real"), { recursive: true });
    const canonicalFile = join(dir, "real", "spacebus.json");
    writeFileSync(canonicalFile, "{}");
    const alias = makeAlias(canonicalFile);
    const fake = makeFakeLaunchctl();
    const canonical = resolveRosterPath(undefined, alias);
    expect(canonical).toBe(realpathSync(canonicalFile));
    const install = await installService(canonical, aliasDeps(fake));
    expect(install.ok).toBe(true);
    const label = serviceLabel(canonical);
    return { alias, canonicalFile, canonical, fake, label };
  }

  function absoluteAlias(canonical: string): string {
    const alias = join(dir, "alias.json");
    symlinkSync(canonical, alias);
    return alias;
  }

  test("status via the alias still finds the canonical install after the roster is deleted", async () => {
    const t = await installedViaAlias(absoluteAlias);
    unlinkSync(t.canonicalFile);

    const viaAlias = resolveRosterPath(undefined, t.alias);
    const status = await serviceStatus(viaAlias, aliasDeps(t.fake));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.label).toBe(t.label);
    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);
    expect(status.plistPath).toBe(plistPath(t.label, launchAgentsDir));
  });

  test("uninstall via the alias removes the canonical job and plist", async () => {
    const t = await installedViaAlias(absoluteAlias);
    unlinkSync(t.canonicalFile);

    const result = await uninstallService(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.label).toBe(t.label);
    expect(result.removed).toEqual({ job: true, plist: true });
    expect(t.fake.loaded.size).toBe(0);
    expect(existsSync(plistPath(t.label, launchAgentsDir))).toBe(false);
  });

  test("stop via the alias boots out the canonical job", async () => {
    const t = await installedViaAlias(absoluteAlias);
    unlinkSync(t.canonicalFile);

    const result = await stopService(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(result).toEqual({ ok: true, label: t.label, wasLoaded: true });
    expect(t.fake.loaded.size).toBe(0);
  });

  test("re-install via the alias refreshes the same job: one plist, one label, stable args", async () => {
    const t = await installedViaAlias(absoluteAlias);
    const plistFile = plistPath(t.label, launchAgentsDir);
    const before = readFileSync(plistFile, "utf8");
    unlinkSync(t.canonicalFile);

    const again = await installService(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.label).toBe(t.label);
    expect([...t.fake.loaded]).toEqual([t.label]);
    expect(readdirSync(launchAgentsDir)).toEqual([`${t.label}.plist`]);
    // Stable install args: the plist still pins the canonical roster path
    // (never the alias) and is byte-identical to the first install.
    const after = readFileSync(plistFile, "utf8");
    expect(after).toContain(`<string>${t.canonical}</string>`);
    expect(after).not.toContain(t.alias);
    expect(after).toBe(before);
    expect(stateDirFor(t.canonical)).toContain(rosterKey(t.canonical));
  });

  test("start via the alias re-renders the canonical roster into the plist", async () => {
    const t = await installedViaAlias(absoluteAlias);
    unlinkSync(t.canonicalFile);
    await stopService(t.canonical, aliasDeps(t.fake));

    const result = await startService(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.label).toBe(t.label);
    const plist = readFileSync(plistPath(t.label, launchAgentsDir), "utf8");
    expect(plist).toContain(`<string>${t.canonical}</string>`);
    expect(plist).not.toContain(t.alias);
  });

  test("follows a relative link chain (alias -> mid -> canonical)", async () => {
    const t = await installedViaAlias((canonical) => {
      mkdirSync(join(dir, "ws"), { recursive: true });
      symlinkSync(canonical, join(dir, "mid.json"));
      const alias = join(dir, "ws", "alias.json");
      symlinkSync("../mid.json", alias); // relative to the link's own directory
      return alias;
    });
    unlinkSync(t.canonicalFile);

    const status = await serviceStatus(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(status.ok && status.label).toBe(t.label);
    expect(status.ok && status.installed).toBe(true);
  });

  test("canonicalizes existing ancestors of a link target that goes through a symlinked directory", async () => {
    const t = await installedViaAlias((_canonical) => {
      const linkdir = join(dir, "linkdir");
      symlinkSync(join(dir, "real"), linkdir);
      const alias = join(dir, "alias.json");
      symlinkSync(join(linkdir, "spacebus.json"), alias); // lexical != canonical
      return alias;
    });
    unlinkSync(t.canonicalFile);

    const result = await uninstallService(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(result.ok && result.removed).toEqual({ job: true, plist: true });
  });

  test("a live symlink passed directly resolves to the canonical identity", async () => {
    const t = await installedViaAlias(absoluteAlias);
    const status = await serviceStatus(t.alias, aliasDeps(t.fake));
    expect(status.ok && status.label).toBe(t.label);
    expect(status.ok && status.installed).toBe(true);
  });

  test("does not guess past a changed link: a retargeted dangling alias is not the old install", async () => {
    const t = await installedViaAlias(absoluteAlias);
    unlinkSync(t.canonicalFile);
    unlinkSync(t.alias);
    const elsewhere = join(dir, "elsewhere", "spacebus.json"); // never existed
    symlinkSync(elsewhere, t.alias);

    const status = await serviceStatus(
      resolveRosterPath(undefined, t.alias),
      aliasDeps(t.fake),
    );
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    // Followed to its current target, with existing ancestors canonicalized
    // (the temp dir may itself sit behind a symlink, e.g. /var -> /private/var).
    expect(status.label).toBe(
      serviceLabel(join(realpathSync(dir), "elsewhere", "spacebus.json")),
    );
    expect(status.label).not.toBe(t.label);
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
    // The old install is untouched.
    expect(t.fake.loaded.has(t.label)).toBe(true);
  });

  test("a plain missing path keeps its raw identity and normal no-install semantics", async () => {
    const fake = makeFakeLaunchctl();
    const missing = join(dir, "nowhere", "spacebus.json");
    const status = await serviceStatus(missing, aliasDeps(fake));
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.label).toBe(serviceLabel(missing));
    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);

    const un = await uninstallService(missing, aliasDeps(fake));
    expect(un.ok && un.removed).toEqual({ job: false, plist: false });
  });

  test("a dangling alias that was never installed is a normal no-install", async () => {
    const fake = makeFakeLaunchctl();
    const alias = join(dir, "alias.json");
    symlinkSync(join(dir, "gone", "spacebus.json"), alias);
    const un = await uninstallService(alias, aliasDeps(fake));
    expect(un.ok && un.removed).toEqual({ job: false, plist: false });
  });

  test("a symlink loop is an explicit error and never reaches launchctl", async () => {
    const fake = makeFakeLaunchctl();
    const a = join(dir, "a.json");
    const b = join(dir, "b.json");
    symlinkSync(b, a);
    symlinkSync(a, b);
    for (const verb of [
      installService,
      uninstallService,
      serviceStatus,
      stopService,
      startService,
    ]) {
      const result = await verb(a, aliasDeps(fake));
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toContain("symlink");
    }
    expect(fake.calls).toEqual([]);
  });

  test("a roster deleted behind a symlinked parent directory keeps its canonical identity", async () => {
    const t = await installedViaAlias(() => {
      symlinkSync(join(dir, "real"), join(dir, "linkdir"));
      return join(dir, "linkdir", "spacebus.json"); // leaf is a plain file
    });
    unlinkSync(t.canonicalFile);

    const viaConfig = resolveRosterPath(undefined, t.alias);
    expect(viaConfig).toBe(t.alias); // missing => resolveRosterPath keeps it raw
    const status = await serviceStatus(viaConfig, aliasDeps(t.fake));
    expect(status.ok && status.label).toBe(t.label);
    expect(status.ok && status.installed).toBe(true);
    const un = await uninstallService(viaConfig, aliasDeps(t.fake));
    expect(un.ok && un.removed).toEqual({ job: true, plist: true });
    expect(t.fake.loaded.size).toBe(0);
  });

  test("does not collapse `..` across a symlink before resolving", async () => {
    // linkdir -> real/sub, so `<dir>/linkdir/../spacebus.json` is physically
    // real/spacebus.json but lexically (collapsed) <dir>/spacebus.json.
    // (Service-level on purpose: node's realpathSync, hence resolveRosterPath,
    // collapses `..` lexically and cannot produce this input.)
    mkdirSync(join(dir, "real", "sub"), { recursive: true });
    symlinkSync(join(dir, "real", "sub"), join(dir, "linkdir"));
    const fake = makeFakeLaunchctl();
    const canonical = join(realpathSync(dir), "real", "spacebus.json");
    await installService(canonical, aliasDeps(fake)); // file missing: given identity
    const viaDotDot = `${dir}/linkdir/../spacebus.json`;

    const status = await serviceStatus(viaDotDot, aliasDeps(fake));
    expect(status.ok && status.label).toBe(serviceLabel(canonical));
    expect(status.ok && status.installed).toBe(true);
  });

  describe("installs made before canonicalization (keyed on the path as given)", () => {
    const given = () => join(dir, "linkdir", "spacebus.json");
    beforeEach(() => {
      mkdirSync(join(dir, "real"), { recursive: true });
      symlinkSync(join(dir, "real"), join(dir, "linkdir"));
    });

    test("a raw-keyed install is still found and removed, never switched to a new label", async () => {
      const fake = makeFakeLaunchctl();
      const rawLabel = serviceLabel(given());
      await installService(given(), aliasDeps(fake)); // roster file never existed
      expect([...fake.loaded]).toEqual([rawLabel]);

      const status = await serviceStatus(given(), aliasDeps(fake));
      expect(status.ok && status.label).toBe(rawLabel);
      expect(status.ok && status.installed).toBe(true);
      const again = await installService(given(), aliasDeps(fake));
      expect(again.ok && again.label).toBe(rawLabel);
      expect(
        readFileSync(plistPath(rawLabel, launchAgentsDir), "utf8"),
      ).toContain(`<string>${given()}</string>`);
      const un = await uninstallService(given(), aliasDeps(fake));
      expect(un.ok && un.removed).toEqual({ job: true, plist: true });
      expect(fake.loaded.size).toBe(0);
    });

    test("plists for both the canonical and the as-given identity are ambiguous: nothing is touched", async () => {
      const fake = makeFakeLaunchctl();
      const canonicalFile = join(dir, "real", "spacebus.json");
      await installService(given(), aliasDeps(fake)); // old raw-keyed install
      writeFileSync(canonicalFile, "{}");
      await installService(realpathSync(canonicalFile), aliasDeps(fake));
      unlinkSync(canonicalFile);
      expect(fake.loaded.size).toBe(2);
      const callsBefore = fake.calls.length;

      for (const verb of [
        installService,
        uninstallService,
        serviceStatus,
        stopService,
        startService,
      ]) {
        const result = await verb(given(), aliasDeps(fake));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("ambiguous");
      }
      expect(fake.calls.length).toBe(callsBefore);
      expect(fake.loaded.size).toBe(2);
      expect(readdirSync(launchAgentsDir).length).toBe(2);
    });
  });

  test("a plain missing path with no alias keeps its given identity", async () => {
    const fake = makeFakeLaunchctl();
    const missing = join(realpathSync(dir), "nowhere", "spacebus.json");
    const status = await serviceStatus(missing, aliasDeps(fake));
    expect(status.ok && status.label).toBe(serviceLabel(missing));
    expect(status.ok && status.installed).toBe(false);
  });

  test("a symlink loop in a parent directory is an explicit error without launchctl", async () => {
    const fake = makeFakeLaunchctl();
    symlinkSync(join(dir, "loopb"), join(dir, "loopa"));
    symlinkSync(join(dir, "loopa"), join(dir, "loopb"));
    const roster = join(dir, "loopa", "spacebus.json");
    for (const verb of [
      installService,
      uninstallService,
      serviceStatus,
      stopService,
      startService,
    ]) {
      const result = await verb(roster, aliasDeps(fake));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("cannot resolve roster path");
        expect(result.error).toContain("loops");
      }
    }
    expect(fake.calls).toEqual([]);
  });

  test("a roster path below a regular file (ENOTDIR) is an explicit error, not a missing tail", async () => {
    const fake = makeFakeLaunchctl();
    writeFileSync(join(dir, "afile"), "x");
    const result = await serviceStatus(
      join(dir, "afile", "spacebus.json"),
      aliasDeps(fake),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ENOTDIR");
    expect(fake.calls).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "an access-denied parent directory is an explicit error without launchctl",
    async () => {
      const fake = makeFakeLaunchctl();
      const locked = join(dir, "locked");
      mkdirSync(join(locked, "inner"), { recursive: true });
      chmodSync(locked, 0o000);
      try {
        for (const verb of [
          installService,
          uninstallService,
          serviceStatus,
          stopService,
          startService,
        ]) {
          const result = await verb(
            join(locked, "inner", "spacebus.json"),
            aliasDeps(fake),
          );
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.error).toContain("EACCES");
        }
        expect(fake.calls).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "an unreadable link chain is an explicit error, not a guessed identity",
    async () => {
      const fake = makeFakeLaunchctl();
      const locked = join(dir, "locked");
      mkdirSync(locked);
      const mid = join(locked, "mid.json");
      symlinkSync(join(dir, "gone", "spacebus.json"), mid);
      const alias = join(dir, "alias.json");
      symlinkSync(mid, alias);
      chmodSync(locked, 0o000);
      try {
        const result = await serviceStatus(alias, aliasDeps(fake));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toContain("roster");
        expect(fake.calls).toEqual([]);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

// --- per-roster mutation lock (#81 item 1) ----------------------------------
//
// install/start/stop/uninstall are print -> bootout -> write -> bootstrap ->
// verify sequences. Two of them on one roster used to interleave (a stale
// installer could write its plist behind another's loaded job, or boot out the
// other's fresh job). They now hold a cross-process, fail-fast
// `<stateDir>/service.lock` (distinct from the daemon's spawn.lock) from before
// the first shared operation until verification/cleanup finishes. `status` is
// read-only and takes no lock.

/** An exec seam whose FIRST call parks on a barrier, so a verb can be held mid-flight. */
function gatedExec(fake: ReturnType<typeof makeFakeLaunchctl>) {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => {
    reached = r;
  });
  const releaseP = new Promise<void>((r) => {
    release = r;
  });
  let first = true;
  const seam: ExecSeam = async (args) => {
    if (first) {
      first = false;
      reached();
      await releaseP;
    }
    return fake.seam(args);
  };
  return { seam, reachedP, release };
}

function lockPathFor(roster: string): string {
  return join(stateDirFor(roster), "service.lock");
}

describe("service mutation lock", () => {
  async function heldInstall(roster: string, fake = makeFakeLaunchctl()) {
    const gate = gatedExec(fake);
    const held = installService(roster, {
      ...aliasDeps(fake),
      exec: gate.seam,
    });
    await gate.reachedP; // A is now mid-install, before its first launchctl call
    return { held, release: gate.release, fake };
  }

  test("a second install of the same roster fails fast with no mutation; the first completes", async () => {
    const a = await heldInstall(rosterPath);
    const bFake = makeFakeLaunchctl();
    const b = await installService(rosterPath, aliasDeps(bFake));
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("in progress");
    expect(bFake.calls).toEqual([]); // not a single launchctl call
    expect(bFake.loaded.size).toBe(0);
    expect(existsSync(plistPathFor(rosterPath))).toBe(false); // nothing written

    a.release();
    const result = await a.held;
    expect(result.ok).toBe(true);
    expect([...a.fake.loaded]).toEqual([serviceLabel(rosterPath)]);
    // plist on disk is exactly the one A loaded
    expect(existsSync(plistPathFor(rosterPath))).toBe(true);
  });

  test("the lock is a 0600 file in a 0700 state dir, distinct from spawn.lock, released afterwards", async () => {
    const a = await heldInstall(rosterPath);
    const lock = lockPathFor(rosterPath);
    expect(existsSync(lock)).toBe(true);
    expect(statSync(lock).mode & 0o777).toBe(0o600);
    expect(statSync(stateDirFor(rosterPath)).mode & 0o777).toBe(0o700);
    expect(lock).not.toBe(join(stateDirFor(rosterPath), "spawn.lock"));
    a.release();
    await a.held;
    expect(existsSync(lock)).toBe(false);
  });

  test("every mutating verb fails fast while another holds the lock; status stays independent", async () => {
    const a = await heldInstall(rosterPath);
    for (const verb of [
      installService,
      uninstallService,
      stopService,
      startService,
    ]) {
      const fake = makeFakeLaunchctl();
      const result = await verb(rosterPath, aliasDeps(fake));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("in progress");
      expect(fake.calls).toEqual([]);
    }
    const statusFake = makeFakeLaunchctl();
    const status = await serviceStatus(rosterPath, aliasDeps(statusFake));
    expect(status.ok).toBe(true); // read-only: no lock, no refusal
    a.release();
    await a.held;
  });

  test("different rosters do not block each other", async () => {
    const rosterB = join(dir, "other", "spacebus.json");
    const a = await heldInstall(rosterPath);
    const fakeB = makeFakeLaunchctl();
    const b = await installService(rosterB, aliasDeps(fakeB));
    expect(b.ok).toBe(true);
    expect([...fakeB.loaded]).toEqual([serviceLabel(rosterB)]);
    a.release();
    expect((await a.held).ok).toBe(true);
  });

  test("a failed verb releases the lock (error result and thrown exec)", async () => {
    const failing = makeFakeLaunchctl();
    const failSeam: ExecSeam = async (args) =>
      args[0] === "bootstrap"
        ? { code: 1, stdout: "", stderr: "boom" }
        : failing.seam(args);
    const failed = await installService(rosterPath, {
      ...aliasDeps(failing),
      exec: failSeam,
    });
    expect(failed.ok).toBe(false);
    expect(existsSync(lockPathFor(rosterPath))).toBe(false);

    const throwing: ExecSeam = async () => {
      throw new Error("exec exploded");
    };
    await expect(
      uninstallService(rosterPath, {
        ...aliasDeps(makeFakeLaunchctl()),
        exec: throwing,
      }),
    ).rejects.toThrow("exec exploded");
    expect(existsSync(lockPathFor(rosterPath))).toBe(false);

    const next = await installService(
      rosterPath,
      aliasDeps(makeFakeLaunchctl()),
    );
    expect(next.ok).toBe(true);
  });

  test("an alias, the canonical path and a dangling alias share one lock", async () => {
    mkdirSync(join(dir, "real"), { recursive: true });
    const canonicalFile = join(dir, "real", "spacebus.json");
    writeFileSync(canonicalFile, "{}");
    const alias = join(dir, "alias.json");
    symlinkSync(canonicalFile, alias);
    const canonical = resolveRosterPath(undefined, alias);
    const fake = makeFakeLaunchctl();
    expect((await installService(canonical, aliasDeps(fake))).ok).toBe(true);

    // live alias vs canonical
    const held = await heldInstall(canonical, fake);
    const viaAlias = await stopService(alias, aliasDeps(makeFakeLaunchctl()));
    expect(viaAlias.ok).toBe(false);
    if (!viaAlias.ok) expect(viaAlias.error).toContain("in progress");
    held.release();
    await held.held;

    // missing target: the alias dangles, the canonical path no longer exists
    unlinkSync(canonicalFile);
    const heldDangling = await (async () => {
      const gate = gatedExec(fake);
      const p = uninstallService(resolveRosterPath(undefined, alias), {
        ...aliasDeps(fake),
        exec: gate.seam,
      });
      await gate.reachedP;
      return { p, release: gate.release };
    })();
    const viaCanonical = await startService(
      canonical,
      aliasDeps(makeFakeLaunchctl()),
    );
    expect(viaCanonical.ok).toBe(false);
    if (!viaCanonical.ok) expect(viaCanonical.error).toContain("in progress");
    heldDangling.release();
    const un = await heldDangling.p;
    expect(un.ok && un.removed).toEqual({ job: true, plist: true });
  });

  test("a verb takes the lock once: a nested status call neither deadlocks nor blocks", async () => {
    const fake = makeFakeLaunchctl();
    let nestedStatus: unknown;
    const seam: ExecSeam = async (args) => {
      if (args[0] === "kickstart" && nestedStatus === undefined) {
        nestedStatus = await serviceStatus(
          rosterPath,
          aliasDeps(makeFakeLaunchctl()),
        );
      }
      return fake.seam(args);
    };
    const result = await installService(rosterPath, {
      ...aliasDeps(fake),
      exec: seam,
    });
    expect(result.ok).toBe(true);
    expect((nestedStatus as { ok: boolean }).ok).toBe(true);
    expect(existsSync(lockPathFor(rosterPath))).toBe(false);
  });

  test("a lock I/O failure is an ok:false result with no launchctl call", async () => {
    mkdirSync(lockPathFor(rosterPath), { recursive: true }); // dir squats the lock path
    const fake = makeFakeLaunchctl();
    for (const verb of [
      installService,
      uninstallService,
      stopService,
      startService,
    ]) {
      const result = await verb(rosterPath, aliasDeps(fake));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("service.lock");
    }
    expect(fake.calls).toEqual([]);
  });

  test("the platform gate runs before any lock or state-dir creation", async () => {
    const fake = makeFakeLaunchctl();
    const result = await installService(rosterPath, {
      ...aliasDeps(fake),
      platform: "linux",
    });
    expect(result.ok).toBe(false);
    expect(existsSync(stateDirFor(rosterPath))).toBe(false);
  });
});
