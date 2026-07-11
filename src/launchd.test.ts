import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rosterKey } from "./discovery";
import {
  bootout,
  bootstrap,
  type ExecSeam,
  kickstart,
  plistPath,
  printJob,
  renderPlist,
  serviceLabel,
  verifyPlistSafe,
  writePlistAtomic,
} from "./launchd";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "space-bus-launchd-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("serviceLabel", () => {
  test("stable for the same roster path", () => {
    const rosterPath = join(dir, "spacebus.json");
    expect(serviceLabel(rosterPath)).toBe(serviceLabel(rosterPath));
  });

  test("distinct for different roster paths", () => {
    const a = join(dir, "a", "spacebus.json");
    const b = join(dir, "b", "spacebus.json");
    expect(serviceLabel(a)).not.toBe(serviceLabel(b));
  });

  test("keys off the same hash prefix as stateDirFor", () => {
    const rosterPath = join(dir, "spacebus.json");
    expect(serviceLabel(rosterPath)).toBe(
      `bot.fro.space-bus.${rosterKey(rosterPath)}`,
    );
  });
});

describe("plistPath", () => {
  test("default base dir resolves under Library/LaunchAgents/<label>.plist (pure string assertion, no fs touch)", () => {
    const label = "bot.fro.space-bus.deadbeefdeadbeef";
    expect(plistPath(label)).toMatch(
      /Library\/LaunchAgents\/bot\.fro\.space-bus\.deadbeefdeadbeef\.plist$/,
    );
  });

  test("injected baseDir overrides the default — never resolves under the real home", () => {
    const label = "bot.fro.space-bus.deadbeefdeadbeef";
    expect(plistPath(label, dir)).toBe(join(dir, `${label}.plist`));
  });
});

describe("renderPlist", () => {
  const opts = {
    runtime: "/usr/local/bin/bun",
    cliEntry: "/usr/local/lib/space-bus/dist/cli.js",
    rosterPath: "/Users/marcus/work/spacebus.json",
    stateDir: "/Users/marcus/.local/state/space-bus/abc123",
    label: "bot.fro.space-bus.abc123",
  };

  test("contains pinned absolute ProgramArguments", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain("<string>/usr/local/bin/bun</string>");
    expect(xml).toContain(
      "<string>/usr/local/lib/space-bus/dist/cli.js</string>",
    );
    expect(xml).toContain("<string>serve</string>");
    expect(xml).toContain("<string>--foreground</string>");
  });

  test("KeepAlive SuccessfulExit is false", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain("<key>KeepAlive</key>");
    expect(xml).toContain("<key>SuccessfulExit</key>\n    <false/>");
  });

  test("RunAtLoad is true and ThrottleInterval is 10", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(xml).toContain(
      "<key>ThrottleInterval</key>\n  <integer>10</integer>",
    );
  });

  test("carries SPACE_BUS_CONFIG with the roster path", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain("<key>SPACE_BUS_CONFIG</key>");
    expect(xml).toContain("<string>/Users/marcus/work/spacebus.json</string>");
  });

  test("routes stdout/stderr into the state dir", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain(
      "<string>/Users/marcus/.local/state/space-bus/abc123/service.log</string>",
    );
    expect(xml).toContain(
      "<string>/Users/marcus/.local/state/space-bus/abc123/service.err.log</string>",
    );
  });

  test("has the pinned label", () => {
    const xml = renderPlist(opts);
    expect(xml).toContain(
      "<key>Label</key>\n  <string>bot.fro.space-bus.abc123</string>",
    );
  });

  test("XML-escapes interpolated strings and stays parse-safe", () => {
    const xml = renderPlist({
      ...opts,
      rosterPath: `/Users/m&r cus/"weird" <roster> 'path'.json`,
    });
    // No raw ampersand outside of an entity reference.
    expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;");
    expect(xml).toContain("&gt;");
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&apos;");
  });

  test("R12 negative probe: no credential material, only the one env var", () => {
    const xml = renderPlist(opts);
    expect(xml.toLowerCase()).not.toContain("password");
    const envMatches = [
      ...xml.matchAll(/<key>([A-Z_]+)<\/key>\s*\n\s*<string>/g),
    ].filter((m) =>
      xml.slice(0, m.index).includes("<key>EnvironmentVariables</key>"),
    );
    // Only SPACE_BUS_CONFIG should appear inside EnvironmentVariables.
    const envDictMatch =
      /<key>EnvironmentVariables<\/key>\s*\n\s*<dict>([\s\S]*?)<\/dict>/.exec(
        xml,
      );
    expect(envDictMatch).not.toBeNull();
    const envBody = envDictMatch?.[1] ?? "";
    expect(envBody).toContain("SPACE_BUS_CONFIG");
    const keyCount = (envBody.match(/<key>/g) ?? []).length;
    expect(keyCount).toBe(1);
    // Silence unused-var lint noise if the filter above isn't needed.
    void envMatches;
  });

  test("plutil -lint validates the rendered plist (darwin only)", async () => {
    if (process.platform !== "darwin") return;
    const target = join(dir, "test.plist");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(target, renderPlist(opts));
    expect(() => execFileSync("plutil", ["-lint", target])).not.toThrow();
  });
});

describe("writePlistAtomic", () => {
  test("writes content and sets mode 0644", () => {
    const target = join(dir, "test.plist");
    const result = writePlistAtomic(target, "<plist>content</plist>");
    expect(result.ok).toBe(true);
    const stat = statSync(target);
    expect(stat.mode & 0o777).toBe(0o644);
    expect(stat.mode & 0o022).toBe(0);
  });

  test("uses temp+rename (no leftover temp files)", () => {
    const target = join(dir, "test.plist");
    writePlistAtomic(target, "<plist>content</plist>");
    const { readdirSync, readFileSync } =
      require("node:fs") as typeof import("node:fs");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["test.plist"]);
    expect(readFileSync(target, "utf8")).toBe("<plist>content</plist>");
  });
});

describe("verifyPlistSafe", () => {
  test("accepts mode 0644", () => {
    const target = join(dir, "test.plist");
    writePlistAtomic(target, "<plist/>");
    expect(verifyPlistSafe(target)).toEqual({ safe: true });
  });

  test("rejects mode 0664 (group-writable)", () => {
    const target = join(dir, "test.plist");
    writePlistAtomic(target, "<plist/>");
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(target, 0o664);
    const result = verifyPlistSafe(target);
    expect(result.safe).toBe(false);
  });

  test("rejects mode 0666 (world-writable)", () => {
    const target = join(dir, "test.plist");
    writePlistAtomic(target, "<plist/>");
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(target, 0o666);
    const result = verifyPlistSafe(target);
    expect(result.safe).toBe(false);
  });
});

describe("launchctl helpers", () => {
  function makeSeam(result: { code: number; stdout: string; stderr: string }) {
    const calls: string[][] = [];
    const seam: ExecSeam = async (args) => {
      calls.push(args);
      return result;
    };
    return { seam, calls };
  }

  test("bootstrap invokes bootstrap gui/<uid> <plist>", async () => {
    const { seam, calls } = makeSeam({ code: 0, stdout: "", stderr: "" });
    await bootstrap(501, "/path/to.plist", seam);
    expect(calls[0]).toEqual(["bootstrap", "gui/501", "/path/to.plist"]);
  });

  test("bootout invokes bootout gui/<uid>/<label>", async () => {
    const { seam, calls } = makeSeam({ code: 0, stdout: "", stderr: "" });
    await bootout(501, "bot.fro.space-bus.abc", seam);
    expect(calls[0]).toEqual(["bootout", "gui/501/bot.fro.space-bus.abc"]);
  });

  test("kickstart invokes kickstart -k gui/<uid>/<label>", async () => {
    const { seam, calls } = makeSeam({ code: 0, stdout: "", stderr: "" });
    await kickstart(501, "bot.fro.space-bus.abc", seam);
    expect(calls[0]).toEqual([
      "kickstart",
      "-k",
      "gui/501/bot.fro.space-bus.abc",
    ]);
  });

  test("printJob: non-zero exit => loaded false", async () => {
    const { seam } = makeSeam({
      code: 3,
      stdout: "",
      stderr: "Could not find",
    });
    const result = await printJob(501, "bot.fro.space-bus.abc", seam);
    expect(result).toEqual({ loaded: false });
  });

  test("printJob: zero exit with pid line => loaded true with pid", async () => {
    const { seam } = makeSeam({
      code: 0,
      stdout: "some header\n\tpid = 4242\n\tstate = running\n",
      stderr: "",
    });
    const result = await printJob(501, "bot.fro.space-bus.abc", seam);
    expect(result).toEqual({ loaded: true, pid: 4242 });
  });

  test("printJob: zero exit without pid line => loaded true, pid undefined", async () => {
    const { seam } = makeSeam({
      code: 0,
      stdout: "some unparsable output\n",
      stderr: "",
    });
    const result = await printJob(501, "bot.fro.space-bus.abc", seam);
    expect(result).toEqual({ loaded: true });
    expect(result.pid).toBeUndefined();
  });
});
