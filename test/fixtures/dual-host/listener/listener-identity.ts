/**
 * U1 feasibility diagnostic (NOT production U4): can an UNPRIVILEGED process
 * correlate a loopback TCP listener to the process that owns it?
 *
 * - macOS: `lsof -nP -a -iTCP:<port> -sTCP:LISTEN -Fpn` (own-user processes).
 * - Linux: /proc/net/tcp{,6} listening inodes -> /proc/<pid>/fd socket links
 *   (own-user processes; other users' fd tables are unreadable).
 *
 * Every non-success outcome is a typed failure. Nothing here ever connects to
 * the port, sends data, or opens a socket: it only reads OS tables.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

export type FailReason =
  | "no-listener"
  | "wrong-pid"
  | "ambiguous"
  | "non-loopback"
  | "uninspectable"
  | "timeout"
  | "error"
  | "unsupported-platform";

export type ListenerResult =
  | { ok: true; pid: number; addresses: string[] }
  | { ok: false; reason: FailReason; detail: string };

export interface InspectOptions {
  platform?: NodeJS.Platform;
  /** Override the lsof binary (tests: missing/slow/garbage tool). */
  lsofPath?: string;
  /** Override /proc (tests: synthetic tree). */
  procRoot?: string;
  timeoutMs?: number;
}

const fail = (reason: FailReason, detail: string): ListenerResult => ({
  ok: false,
  reason,
  detail,
});

const LOOPBACK_V4 = "127.0.0.1";
const LOOPBACK_V6 = "::1";

/** Normalized listening socket: address text (loopback only is acceptable). */
export interface Listening {
  pid?: number;
  inode?: string;
  address: string;
  port: number;
}

// --- macOS: lsof -F parsing -------------------------------------------------

/** Parses `lsof -Fpn` output: `p<pid>` then one or more `n<addr>:<port>`. */
export function parseLsofListeners(stdout: string): Listening[] | null {
  const out: Listening[] = [];
  let pid: number | undefined;
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      if (!/^[0-9]+$/.test(value)) return null;
      pid = Number(value);
    } else if (tag === "n") {
      const m = /^(.*):([0-9]+)$/.exec(value);
      if (pid === undefined || m === null) return null;
      out.push({ pid, address: (m[1] as string) || "", port: Number(m[2]) });
    } else if (tag !== "f" && tag !== "c") {
      return null; // unknown field: do not guess
    }
  }
  return out;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
): Promise<
  { code: number | null; stdout: string; stderr: string } | "timeout" | Error
> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1 << 20, env: { LC_ALL: "C" } },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.killed === true) resolve("timeout");
        else if (typeof e.code === "number") {
          resolve({
            code: e.code,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        } else resolve(e);
      },
    );
  });
}

async function inspectDarwin(
  port: number,
  opts: InspectOptions,
): Promise<ListenerResult> {
  const result = await run(
    opts.lsofPath ?? "/usr/sbin/lsof",
    ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
    opts.timeoutMs ?? 5000,
  );
  if (result === "timeout") return fail("timeout", "lsof timed out");
  if (result instanceof Error) {
    return fail("error", `cannot run lsof: ${result.message}`);
  }
  if (
    result.code === 1 &&
    result.stdout.trim() === "" &&
    result.stderr.trim() === ""
  ) {
    return fail("no-listener", "lsof found no listener on that port");
  }
  if (result.code !== 0) {
    return fail(
      "error",
      `lsof exit ${result.code}: ${result.stderr.slice(0, 200)}`,
    );
  }
  const rows = parseLsofListeners(result.stdout);
  if (rows === null || rows.length === 0) {
    return fail("error", "unparseable or empty lsof output");
  }
  return classify(rows.filter((r) => r.port === port));
}

// --- Linux: /proc ---------------------------------------------------------------

/** Parses /proc/net/tcp (family 4) or tcp6 (family 6); LISTEN rows only. */
export function parseProcNetTcp(text: string, family: 4 | 6): Listening[] {
  const rows: Listening[] = [];
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[3] !== "0A") continue;
    const [addrHex, portHex] = (f[1] as string).split(":");
    if (addrHex === undefined || portHex === undefined) continue;
    rows.push({
      address: hexAddress(addrHex, family),
      port: Number.parseInt(portHex, 16),
      inode: f[9] as string,
    });
  }
  return rows;
}

function hexAddress(hex: string, family: 4 | 6): string {
  if (family === 4 && hex.length === 8) {
    const b = hex.match(/../g) as string[]; // little-endian bytes
    return b
      .reverse()
      .map((x) => Number.parseInt(x, 16))
      .join(".");
  }
  if (family === 6 && hex === "00000000000000000000000001000000")
    return LOOPBACK_V6;
  if (family === 6 && /^0{32}$/.test(hex)) return "::";
  return `unrecognized:${hex}`;
}

/** inode -> pids that hold it, plus how many fd tables were unreadable. */
function scanHolders(
  procRoot: string,
  wanted: Set<string>,
): { holders: Map<string, number[]>; unreadable: number } {
  const holders = new Map<string, number[]>();
  let unreadable = 0;
  for (const name of readdirSync(procRoot)) {
    if (!/^[0-9]+$/.test(name)) continue;
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, name, "fd"));
    } catch {
      unreadable += 1; // other user's process, or exited meanwhile
      continue;
    }
    for (const fd of fds) {
      try {
        const m = /^socket:\[([0-9]+)\]$/.exec(
          readlinkSync(join(procRoot, name, "fd", fd)),
        );
        if (m?.[1] !== undefined && wanted.has(m[1])) {
          const list = holders.get(m[1]) ?? [];
          if (!list.includes(Number(name))) list.push(Number(name));
          holders.set(m[1], list);
        }
      } catch {
        // fd closed between readdir and readlink
      }
    }
  }
  return { holders, unreadable };
}

function inspectLinux(port: number, opts: InspectOptions): ListenerResult {
  const root = opts.procRoot ?? "/proc";
  let rows: Listening[];
  try {
    rows = [
      ...parseProcNetTcp(readFileSync(join(root, "net/tcp"), "utf8"), 4),
      ...parseProcNetTcp(readFileSync(join(root, "net/tcp6"), "utf8"), 6),
    ].filter((r) => r.port === port);
  } catch (e) {
    return fail("error", `cannot read /proc/net/tcp*: ${(e as Error).message}`);
  }
  if (rows.length === 0)
    return fail("no-listener", "no LISTEN row for that port");
  const bad = rows.find(
    (r) => r.address !== LOOPBACK_V4 && r.address !== LOOPBACK_V6,
  );
  if (bad) return fail("non-loopback", `listener bound to ${bad.address}`);
  let scan: ReturnType<typeof scanHolders>;
  try {
    scan = scanHolders(root, new Set(rows.map((r) => r.inode as string)));
  } catch (e) {
    return fail("error", `cannot scan ${root}: ${(e as Error).message}`);
  }
  const pids = new Set<number>();
  for (const r of rows) {
    const held = scan.holders.get(r.inode as string);
    if (held === undefined) {
      return fail(
        "uninspectable",
        `no readable owner for socket inode (${scan.unreadable} fd tables unreadable)`,
      );
    }
    for (const p of held) pids.add(p);
  }
  if (pids.size !== 1)
    return fail("ambiguous", `${pids.size} processes hold the listener`);
  return {
    ok: true,
    pid: [...pids][0] as number,
    addresses: rows.map((r) => r.address),
  };
}

// --- shared ----------------------------------------------------------------------

/** lsof rows -> verdict: loopback only, exactly one owning pid. */
function classify(rows: Listening[]): ListenerResult {
  if (rows.length === 0) return fail("no-listener", "no rows for that port");
  const bad = rows.find(
    (r) => r.address !== LOOPBACK_V4 && r.address !== `[${LOOPBACK_V6}]`,
  );
  if (bad)
    return fail("non-loopback", `listener bound to ${bad.address || "?"}`);
  const pids = new Set(rows.map((r) => r.pid as number));
  if (pids.size !== 1)
    return fail("ambiguous", `${pids.size} processes hold the listener`);
  return {
    ok: true,
    pid: [...pids][0] as number,
    addresses: rows.map((r) => r.address),
  };
}

/** Who owns the loopback listener on `port`? Fails closed on anything else. */
export async function findListenerOwner(
  port: number,
  opts: InspectOptions = {},
): Promise<ListenerResult> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fail("error", "port out of range");
  }
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin") return inspectDarwin(port, opts);
  if (platform === "linux") return inspectLinux(port, opts);
  return fail("unsupported-platform", `no listener inspection for ${platform}`);
}

/** Passes only if exactly `expectedPid` owns the (only) loopback listener. */
export async function verifyListener(
  port: number,
  expectedPid: number,
  opts: InspectOptions = {},
): Promise<ListenerResult> {
  if (!Number.isInteger(expectedPid) || expectedPid < 2) {
    return fail("error", "invalid expected pid");
  }
  const found = await findListenerOwner(port, opts);
  if (!found.ok) return found;
  if (found.pid !== expectedPid) {
    return fail(
      "wrong-pid",
      `listener is owned by pid ${found.pid}, not ${expectedPid}`,
    );
  }
  return found;
}
