/**
 * U1 listener-identity feasibility probe. Run: `bun test/fixtures/dual-host/listener/probe.ts`
 *
 * Prints bounded evidence, one line per scenario, then a summary; exits 0 only
 * if every expectation held. Live scenarios use ONLY a child listener this
 * script spawns on 127.0.0.1 (OS-assigned port, synthetic data). It never
 * connects to the port, never sends anything, never scans, and never touches
 * credentials or any real OpenCode.
 */
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type FailReason,
  findListenerOwner,
  type InspectOptions,
  type ListenerResult,
  verifyListener,
} from "./listener-identity";

const HERE = dirname(fileURLToPath(import.meta.url));
const LISTENER = join(HERE, "child-listener.mjs");
const tmp = mkdtempSync(join(tmpdir(), "u1-listener-"));
let failures = 0;
let checks = 0;

function show(label: string, expect: string, r: ListenerResult): void {
  const got = r.ok
    ? `ok pid=${r.pid} [${r.addresses.join(",")}]`
    : `FAIL(${r.reason}) ${r.detail}`;
  console.log(
    `  ${label.padEnd(44)} expect ${expect.padEnd(14)} => ${got.slice(0, 160)}`,
  );
}

function expectOk(label: string, r: ListenerResult, pid?: number): void {
  checks += 1;
  show(label, "ok", r);
  if (!r.ok || (pid !== undefined && r.pid !== pid)) failures += 1;
}

function expectFail(
  label: string,
  r: ListenerResult,
  reason?: FailReason,
): void {
  checks += 1;
  show(label, reason ? `fail:${reason}` : "fail-closed", r);
  if (r.ok || (reason !== undefined && r.reason !== reason)) failures += 1;
}

function script(name: string, body: string): string {
  const path = join(tmp, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Spawns the synthetic listener; resolves its first JSON line (5s bound). */
function startListener(
  runtime: string,
  args: string[] = [],
): Promise<{
  child: ChildProcess;
  report: { pid: number; port: number; holders?: number[] };
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, [LISTENER, ...args], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const timer = setTimeout(
      () => reject(new Error("listener start timeout")),
      5000,
    );
    child.stdout?.once("data", (d: Buffer) => {
      clearTimeout(timer);
      resolve({ child, report: JSON.parse(String(d).trim()) });
    });
    child.once("error", reject);
  });
}

function exited(child: ChildProcess): Promise<void> {
  return child.exitCode !== null
    ? Promise.resolve()
    : new Promise((r) => child.once("exit", () => r()));
}

async function freeUnusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen({ host: "127.0.0.1", port: 0 }, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.once("error", reject);
  });
}

/** First stdout/stderr line containing `needle` (lsof prints its version on stderr). */
function toolLine(cmd: string, args: string[], needle: string): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 3000 });
  const text = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  return (
    text
      .split("\n")
      .find((l) => l.includes(needle))
      ?.trim() ?? "unavailable"
  );
}

function tool(cmd: string, args: string[]): string {
  try {
    return (
      execFileSync(cmd, args, { encoding: "utf8", timeout: 3000 }).split(
        "\n",
      )[0] ?? ""
    );
  } catch (e) {
    return `unavailable (${(e as Error).message.split("\n")[0]})`;
  }
}

// --- synthetic lsof (portable: exercises macOS classification anywhere) ----------

async function syntheticLsof(): Promise<void> {
  console.log(
    "== synthetic lsof output (classification logic only; not an OS verification)",
  );
  const port = 54321;
  const mk = (name: string, out: string, code = 0) =>
    script(name, `cat <<'EOF'\n${out}\nEOF\nexit ${code}`);
  const o = (lsofPath: string): InspectOptions => ({
    platform: "darwin",
    lsofPath,
    timeoutMs: 1000,
  });
  expectOk(
    "one pid, 127.0.0.1",
    await findListenerOwner(port, o(mk("a", `p100\nn127.0.0.1:${port}`))),
    100,
  );
  expectOk(
    "one pid, [::1]",
    await findListenerOwner(port, o(mk("b", `p100\nn[::1]:${port}`))),
    100,
  );
  expectFail(
    "two pids hold it",
    await findListenerOwner(
      port,
      o(mk("c", `p100\nn127.0.0.1:${port}\np200\nn127.0.0.1:${port}`)),
    ),
    "ambiguous",
  );
  expectFail(
    "wildcard listener",
    await findListenerOwner(port, o(mk("d", `p100\nn*:${port}`))),
    "non-loopback",
  );
  expectFail(
    "LAN address listener",
    await findListenerOwner(port, o(mk("e", `p100\nn192.0.2.1:${port}`))),
    "non-loopback",
  );
  expectFail(
    "garbage output, exit 0",
    await findListenerOwner(port, o(mk("f", "garbage"))),
    "error",
  );
  expectFail(
    "empty output, exit 0",
    await findListenerOwner(port, o(mk("g", ""))),
    "error",
  );
  expectFail(
    "no match: exit 1, empty",
    await findListenerOwner(port, o(mk("h", "", 1))),
    "no-listener",
  );
  expectFail(
    "exit 2 (tool error)",
    await findListenerOwner(port, o(mk("i", "", 2))),
    "error",
  );
  expectFail(
    "exit 1 WITH output (uncertain)",
    await findListenerOwner(port, o(mk("j", `p100\nn127.0.0.1:${port}`, 1))),
    "error",
  );
  expectFail(
    "tool missing",
    await findListenerOwner(port, o(join(tmp, "nope"))),
    "error",
  );
  expectFail(
    "tool hangs (timeout)",
    await findListenerOwner(port, {
      ...o(script("slow", "sleep 5")),
      timeoutMs: 300,
    }),
    "timeout",
  );
  expectFail(
    "different port in output",
    await findListenerOwner(port, o(mk("k", `p100\nn127.0.0.1:${port + 1}`))),
    "no-listener",
  );
  expectFail(
    "expected pid mismatch",
    await verifyListener(port, 999, o(mk("l", `p100\nn127.0.0.1:${port}`))),
    "wrong-pid",
  );
  expectFail(
    "platform unsupported",
    await findListenerOwner(port, { platform: "win32" }),
    "unsupported-platform",
  );
}

// --- synthetic /proc (portable: exercises the Linux logic anywhere) -----------------

const TCP_HEADER =
  "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (addr: string, port: number, inode: number, st = "0A") =>
  `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

function fakeProc(opts: {
  tcp: string[];
  tcp6?: string[];
  fds: Record<string, string[]>;
  unreadablePids?: string[];
}): string {
  const root = mkdtempSync(join(tmp, "proc-"));
  mkdirSync(join(root, "net"));
  writeFileSync(join(root, "net/tcp"), [TCP_HEADER, ...opts.tcp].join("\n"));
  writeFileSync(
    join(root, "net/tcp6"),
    [TCP_HEADER, ...(opts.tcp6 ?? [])].join("\n"),
  );
  for (const [pid, inodes] of Object.entries(opts.fds)) {
    mkdirSync(join(root, pid, "fd"), { recursive: true });
    for (const [i, inode] of inodes.entries()) {
      symlinkSync(`socket:[${inode}]`, join(root, pid, "fd", String(i + 3)));
    }
  }
  for (const pid of opts.unreadablePids ?? []) mkdirSync(join(root, pid)); // no fd dir: unreadable
  return root;
}

async function syntheticProc(): Promise<void> {
  console.log(
    "== synthetic /proc tree (Linux logic only; NOT a Linux verification)",
  );
  const port = 45678;
  const lo = "0100007F";
  const at = (procRoot: string): InspectOptions => ({
    platform: "linux",
    procRoot,
  });
  expectOk(
    "one holder",
    await findListenerOwner(
      port,
      at(fakeProc({ tcp: [row(lo, port, 111)], fds: { 1000: [111] } })),
    ),
    1000,
  );
  expectOk(
    "tcp6 ::1 holder",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [],
          tcp6: [row("00000000000000000000000001000000", port, 222)],
          fds: { 1000: [222] },
        }),
      ),
    ),
    1000,
  );
  expectOk(
    "same pid on v4+v6 loopback",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [row(lo, port, 111)],
          tcp6: [row("00000000000000000000000001000000", port, 222)],
          fds: { 1000: [111, 222] },
        }),
      ),
    ),
    1000,
  );
  expectFail(
    "two holders of one inode",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [row(lo, port, 111)],
          fds: { 1000: [111], 1001: [111] },
        }),
      ),
    ),
    "ambiguous",
  );
  expectFail(
    "v4 and v6 owned by different pids",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [row(lo, port, 111)],
          tcp6: [row("00000000000000000000000001000000", port, 222)],
          fds: { 1000: [111], 1001: [222] },
        }),
      ),
    ),
    "ambiguous",
  );
  expectFail(
    "wildcard row on same port",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [row(lo, port, 111), row("00000000", port, 112)],
          fds: { 1000: [111, 112] },
        }),
      ),
    ),
    "non-loopback",
  );
  expectFail(
    "owner fd table unreadable",
    await findListenerOwner(
      port,
      at(
        fakeProc({
          tcp: [row(lo, port, 111)],
          fds: {},
          unreadablePids: ["2000"],
        }),
      ),
    ),
    "uninspectable",
  );
  expectFail(
    "LISTEN row but no holder at all",
    await findListenerOwner(
      port,
      at(fakeProc({ tcp: [row(lo, port, 111)], fds: { 1000: [999] } })),
    ),
    "uninspectable",
  );
  expectFail(
    "no LISTEN row (ESTABLISHED only)",
    await findListenerOwner(
      port,
      at(fakeProc({ tcp: [row(lo, port, 111, "01")], fds: { 1000: [111] } })),
    ),
    "no-listener",
  );
  expectFail(
    "stale pid: row owned by someone else",
    await verifyListener(
      port,
      1234,
      at(fakeProc({ tcp: [row(lo, port, 111)], fds: { 1000: [111] } })),
    ),
    "wrong-pid",
  );
  expectFail(
    "/proc/net missing",
    await findListenerOwner(port, at(join(tmp, "absent"))),
    "error",
  );
}

// --- live (this OS) ---------------------------------------------------------------------

async function live(): Promise<void> {
  const platform = process.platform;
  console.log(
    `== live on ${platform}: own ephemeral 127.0.0.1 listener, never connected to`,
  );
  if (platform !== "darwin" && platform !== "linux") {
    console.log("  (no live inspection on this platform)");
    return;
  }
  const { child, report } = await startListener(process.execPath);
  const { pid, port } = report;
  console.log(`  child pid=${pid} (spawn pid ${child.pid}) port=${port}`);
  expectOk("correct pid", await verifyListener(port, pid), pid);
  expectFail(
    "wrong pid: this probe process",
    await verifyListener(port, process.pid),
    "wrong-pid",
  );
  expectFail(
    "wrong pid: pid+1",
    await verifyListener(port, pid + 1),
    "wrong-pid",
  );
  expectFail(
    "wrong pid: parent process",
    await verifyListener(port, process.ppid),
    "wrong-pid",
  );
  expectFail("invalid pid 0", await verifyListener(port, 0), "error");
  expectFail(
    "missing: unbound port",
    await findListenerOwner(await freeUnusedPort()),
    "no-listener",
  );
  if (platform === "darwin") {
    expectFail(
      "tool missing (live path)",
      await findListenerOwner(port, { lsofPath: join(tmp, "nope") }),
      "error",
    );
  }
  child.stdin?.end();
  child.kill("SIGTERM");
  await exited(child);
  expectFail(
    "dead listener, stale pid+port",
    await verifyListener(port, pid),
    "no-listener",
  );

  const node = tool("node", ["--version"]);
  if (node.startsWith("v")) {
    const held = await startListener("node", ["--hand-off"]);
    console.log(
      `  hand-off listener (node ${node}): holders=${JSON.stringify(held.report.holders)} port=${held.report.port}`,
    );
    expectFail(
      "two live processes hold one listener",
      await verifyListener(held.report.port, held.report.pid),
      "ambiguous",
    );
    held.child.stdin?.end();
    held.child.kill("SIGTERM");
    await exited(held.child);
  } else {
    console.log(
      `  SKIPPED live ambiguity (needs node for IPC handle passing): ${node}`,
    );
  }
}

async function main(): Promise<void> {
  console.log("== environment");
  console.log(`  ${tool("uname", ["-a"]).slice(0, 200)}`);
  console.log(
    `  ${process.platform === "darwin" ? tool("sw_vers", ["-productVersion"]) : tool("cat", ["/etc/os-release"])}`,
  );
  console.log(
    `  bun ${process.versions.bun ?? "n/a"} / node-compat ${process.version}`,
  );
  console.log(
    `  ${process.platform === "darwin" ? `lsof ${toolLine("/usr/sbin/lsof", ["-v"], "revision")}` : "(linux: /proc only, no external tool)"}  uid=${process.getuid?.()}`,
  );
  await syntheticLsof();
  await syntheticProc();
  await live();
  rmSync(tmp, { recursive: true, force: true });
  console.log(
    `== ${checks - failures}/${checks} expectations held; ${failures === 0 ? "PASS" : "FAIL"}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`probe error: ${(e as Error).message}`);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(2);
});
