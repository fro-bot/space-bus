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
