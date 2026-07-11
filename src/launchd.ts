/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only lane (joins `discovery.ts`'s lane): launchd plist generation,
 * atomic writes, and a thin `launchctl` exec seam. MUST NOT be imported by
 * core.ts, contract.ts, format.ts, or attach.ts — those stay browser-safe.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  lstatSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { rosterKey } from "./discovery";

// --- Identity / paths --------------------------------------------------

/** `bot.fro.space-bus.<rosterKey>` — one label per roster identity (R7). */
export function serviceLabel(rosterPath: string): string {
  return `bot.fro.space-bus.${rosterKey(rosterPath)}`;
}

/**
 * `<baseDir>/<label>.plist`. Defaults to `~/Library/LaunchAgents` when
 * `baseDir` is omitted — tests MUST pass an injected temp directory so
 * writes never land in the operator's real LaunchAgents folder.
 */
export function plistPath(label: string, baseDir?: string): string {
  return join(
    baseDir ?? join(homedir(), "Library", "LaunchAgents"),
    `${label}.plist`,
  );
}

// --- Plist rendering -----------------------------------------------------

/** XML-escapes a string for safe interpolation into plist element text. */
function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export interface RenderPlistOpts {
  runtime: string;
  cliEntry: string;
  rosterPath: string;
  stateDir: string;
  label: string;
  /**
   * Absolute `PATH` to pin into the launched process's sparse launchd
   * environment. launchd agents don't inherit the login shell's PATH, so
   * without this a mise/asdf-shim-resolved `runtime`/`cliEntry` absolute
   * path is fine, but any subprocess *it* shells out to (or a future
   * change resolving a bare command name) would silently resolve
   * differently than at install time. Optional — omitted entirely from
   * the plist when not supplied, since not every caller can safely derive
   * a sane absolute PATH (tests, callers targeting an older contract).
   */
  path?: string;
  /**
   * Absolute `XDG_STATE_HOME` to pin into the launched environment when
   * the installer resolved `stateDir` using an `XDG_STATE_HOME` override.
   * Without this, `stateDirFor` inside the launchd-launched process (which
   * runs under launchd's own sparse env, NOT the installer's shell env)
   * falls back to `~/.local/state`, diverging from the installer's view of
   * `stateDir` — the exact split this option exists to prevent. Caller
   * (installService) is responsible for validating this is absolute
   * before passing it in.
   */
  xdgStateHome?: string;
}

/**
 * Renders the launchd agent plist XML for a roster. Pins absolute
 * ProgramArguments (`[runtime, cliEntry, "serve", "--foreground"]`),
 * restarts only on abnormal exit (`KeepAlive.SuccessfulExit=false`,
 * consuming the existing 0/1 exit contract — R6), throttles restarts
 * (R8), and routes stdout/stderr into the roster's state dir (R10). The
 * environment carries `SPACE_BUS_CONFIG` plus, when supplied, `PATH` and
 * `XDG_STATE_HOME` — never credentials (R12). All interpolated strings
 * are XML-escaped.
 */
export function renderPlist(opts: RenderPlistOpts): string {
  const runtime = xmlEscape(opts.runtime);
  const cliEntry = xmlEscape(opts.cliEntry);
  const rosterPath = xmlEscape(opts.rosterPath);
  const label = xmlEscape(opts.label);
  const outLog = xmlEscape(join(opts.stateDir, "service.log"));
  const errLog = xmlEscape(join(opts.stateDir, "service.err.log"));

  const envEntries: string[] = [
    `    <key>SPACE_BUS_CONFIG</key>\n    <string>${rosterPath}</string>`,
  ];
  if (opts.path !== undefined) {
    envEntries.push(
      `    <key>PATH</key>\n    <string>${xmlEscape(opts.path)}</string>`,
    );
  }
  if (opts.xdgStateHome !== undefined) {
    envEntries.push(
      `    <key>XDG_STATE_HOME</key>\n    <string>${xmlEscape(opts.xdgStateHome)}</string>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${runtime}</string>
    <string>${cliEntry}</string>
    <string>serve</string>
    <string>--foreground</string>
  </array>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
${envEntries.join("\n")}
  </dict>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
}

// --- Atomic write + tamper checks ----------------------------------------

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Writes the plist atomically: a temp file (0644, since launchd — not just
 * the owner — must be able to read it) in the same directory as the
 * target, then rename over it. Mirrors `writeDiscovery`'s temp+rename
 * pattern; final mode is 0644 (owner read/write, group/world read-only —
 * never writable, per R15).
 */
export function writePlistAtomic(path: string, content: string): WriteResult {
  const dir = join(path, "..");
  const tempPath = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number;
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_EXCL | fsConstants.O_CREAT | fsConstants.O_WRONLY,
      0o644,
    );
  } catch (err) {
    return { ok: false, error: `failed to create temp plist: ${String(err)}` };
  }
  try {
    writeFileSync(fd, content);
  } catch (err) {
    closeQuietly(fd);
    return { ok: false, error: `failed to write temp plist: ${String(err)}` };
  }
  closeQuietly(fd);
  try {
    chmodSync(tempPath, 0o644);
    renameSync(tempPath, path);
  } catch (err) {
    return { ok: false, error: `failed to install plist: ${String(err)}` };
  }
  return { ok: true };
}

export type PlistSafety = { safe: true } | { safe: false; reason: string };

/**
 * Refuses a plist that isn't owned by the current user or is
 * group/world-writable — a tampered plist must never become login-time
 * code execution (R15).
 */
export function verifyPlistSafe(path: string): PlistSafety {
  let mode: number;
  let uid: number;
  try {
    const linkStat = lstatSync(path);
    if (linkStat.isSymbolicLink()) {
      return { safe: false, reason: "plist path is a symlink" };
    }
  } catch (err) {
    return { safe: false, reason: `failed to stat plist: ${String(err)}` };
  }
  try {
    const stat = statSync(path);
    mode = stat.mode & 0o777;
    uid = stat.uid;
  } catch (err) {
    return { safe: false, reason: `failed to stat plist: ${String(err)}` };
  }
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    return {
      safe: false,
      reason: `plist is not owned by the current user (uid ${uid})`,
    };
  }
  if ((mode & 0o022) !== 0) {
    return {
      safe: false,
      reason: `plist is group/world-writable (mode ${mode.toString(8)})`,
    };
  }
  return { safe: true };
}

function closeQuietly(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // best-effort
  }
}

// --- launchctl exec seam ---------------------------------------------------

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecSeam = (args: string[]) => Promise<ExecResult>;

/** Hard timeout for a single `launchctl` invocation. `launchctl` talking to
 * a hung/unresponsive launchd should never hang the caller forever — the
 * exec seam must resolve (never reject) a synthetic failure result instead
 * (R-no-throw-across-boundary). */
const LAUNCHCTL_TIMEOUT_MS = 15_000;
/** Caps captured stdout/stderr so a runaway/garbled child can't balloon
 * memory or an error string. */
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024;

function capOutput(value: string): string {
  return value.length > MAX_CAPTURED_OUTPUT_BYTES
    ? `${value.slice(0, MAX_CAPTURED_OUTPUT_BYTES)}\n...[truncated]`
    : value;
}

/** Default `ExecSeam`: spawns the real `launchctl` binary. Never rejects —
 * a spawn error or a timeout both resolve a `{code:-1,...}` ExecResult with
 * an actionable stderr, so callers' no-throw-across-the-boundary contract
 * holds even when the exec primitive itself misbehaves. */
export const defaultLaunchctl: ExecSeam = (args) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn("launchctl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      settle({
        code: -1,
        stdout: capOutput(stdout),
        stderr: capOutput(`${stderr}\nlaunchctl spawn error: ${String(err)}`),
      });
    });
    child.on("close", (code) => {
      settle({
        code: code ?? -1,
        stdout: capOutput(stdout),
        stderr: capOutput(stderr),
      });
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort
      }
      settle({
        code: -1,
        stdout: capOutput(stdout),
        stderr: capOutput(
          `${stderr}\nlaunchctl timed out after ${LAUNCHCTL_TIMEOUT_MS}ms (args: ${args.join(" ")})`,
        ),
      });
    }, LAUNCHCTL_TIMEOUT_MS);
  });

export async function bootstrap(
  uid: number,
  plist: string,
  exec: ExecSeam,
): Promise<ExecResult> {
  return exec(["bootstrap", `gui/${uid}`, plist]);
}

export async function bootout(
  uid: number,
  label: string,
  exec: ExecSeam,
): Promise<ExecResult> {
  return exec(["bootout", `gui/${uid}/${label}`]);
}

export async function kickstart(
  uid: number,
  label: string,
  exec: ExecSeam,
): Promise<ExecResult> {
  return exec(["kickstart", "-k", `gui/${uid}/${label}`]);
}

export type PrintJobResult =
  | { ok: true; loaded: boolean; pid?: number }
  | { ok: false; error: string };

/** Substrings launchd's `print` emits when a job is genuinely absent —
 * distinct from an exec failure (permission, IO, timeout, spawn error). */
const NOT_LOADED_MARKERS = ["could not find", "no such process"];

/**
 * Probes a launchd job by label. A zero exit is authoritative "loaded";
 * a permissive `pid = (\d+)` match against stdout is best-effort only —
 * an unparsable but zero-exit response is still `loaded: true` with
 * `pid: undefined`, since `print`'s exact line format drifts across macOS
 * versions. A non-zero exit is `loaded: false` ONLY when launchd's own
 * "job not found" wording is present in the combined output; any other
 * non-zero exit (permission denied, IO error, our own timeout/spawn-error
 * synthetic result) is reported as `ok:false` so callers can fail honestly
 * instead of silently treating a probe failure as "not loaded".
 */
export async function printJob(
  uid: number,
  label: string,
  exec: ExecSeam,
): Promise<PrintJobResult> {
  const result = await exec(["print", `gui/${uid}/${label}`]);
  if (result.code === 0) {
    const match = /pid\s*=\s*(\d+)/.exec(result.stdout);
    return match
      ? { ok: true, loaded: true, pid: Number(match[1]) }
      : { ok: true, loaded: true };
  }
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  if (NOT_LOADED_MARKERS.some((marker) => combined.includes(marker))) {
    return { ok: true, loaded: false };
  }
  const detail = result.stderr.trim() || result.stdout.trim();
  return {
    ok: false,
    error: `launchctl print failed (exit ${result.code})${detail ? ` — ${detail}` : ""}`,
  };
}
