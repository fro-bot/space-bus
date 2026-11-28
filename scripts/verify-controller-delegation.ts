#!/usr/bin/env bun
/**
 * U2 delegation check: does the ACTUAL current-source @fro.bot/space-bus
 * package, running as a plugin inside a REAL OpenCode v2.3.2 controller,
 * delegate (bus_task -> bus_wait -> bus_result) to a REAL OpenCode v1.17.13
 * target, in both v1 target modes, and only to the intended project?
 *
 *   bun run scripts/verify-controller-delegation.ts [--run-id <id>] [--keep]
 *
 * What is real, and what is not:
 *   real       the packed package built from the working tree (not a stub, not
 *              a git-archive of HEAD); the v2.3.2 controller binary; the
 *              v1.17.13 target binary; every HTTP request between them.
 *   fixture    the model. Both hosts talk to ONE deterministic loopback
 *              OpenAI-compatible server in this process (test/fixtures/
 *              dual-host/delegation/model-fixture.mjs). The controller's
 *              "model" emits a scripted tool plan; the target's echoes
 *              `ACK <nonce>`. No provider, no credential, no network.
 *
 * Flows (each is one controller session driving the plugin's own tools):
 *   ext-ambient   spacebus.json in the controller workspace (external v1
 *                 target, shared basic-auth password), two projects.
 *   managed-override  `roster: "managed-b"` resolved from the controller's
 *                 registry -> a MANAGED v1 target the plugin spawns itself.
 *   negative      unknown project / wrong-roster project / out-of-roster
 *                 project: every call must be refused and no nonce may reach
 *                 any target, by model log AND by session scan.
 * Each nonce is unique per delivery, so a hit identifies the exact dispatch.
 *
 * Isolation is the U1 contract (reused, not reimplemented): macOS
 * sandbox-exec denies the real home and invoking $HOME, denies ALL writes
 * except to this run's work dir, denies non-loopback network, and a self-test
 * with canaries outside the work dir and positive controls proves it before
 * any host starts. It covers HOST EXECUTION only: the pack and npm install
 * steps run unsandboxed, with network access, before any host starts. Each
 * host has its own env -i, HOME, XDG_*, TMPDIR,
 * OPENCODE_CONFIG_DIR. Only children this script spawned (or the managed
 * server recorded in this run's private discovery file, command-checked) are
 * signalled. Nothing is installed globally; no service is registered.
 *
 * Evidence: .context/u2-delegation/<run-id>/ (git-ignored, scrubbed).
 * Modes are reported separately. Managed mode first needs the product's
 * native `ps -p <pid> -o lstart=,comm=` call to work inside the sandbox
 * (preflight, nothing spawned); if it is denied, managed is BLOCKED, never a
 * pass, and no bridge, shim or relaxed profile is used.
 *
 *   --mode external     external round trip only (managed NOT-RUN)
 *   --preflight-only    sandbox self-test + managed preflight, no build/hosts
 *
 * Exit: 0 every requested mode passed; 1 harness/control invalid, build/
 * install failed, or the managed preflight was inconclusive (the unsandboxed
 * control `ps` also failed, so the sandbox cannot be blamed; nothing about U2
 * is proven); 2 harness valid but a U2 check failed; 3 harness valid, what ran
 * passed, but managed mode is BLOCKED (sandboxed `ps` denied while the
 * unsandboxed control works).
 */

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_PATH,
  freePort,
  HOSTS,
  type Host,
  type Iso,
  identify,
  inSandbox,
  type Json,
  makeIso,
  PINS,
  portOpen,
  sandboxSelfTest,
  sh,
  sleep,
  WORK_MARKER,
} from "./verify-host-matrix";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = "@fro.bot/space-bus";
const pickHost = (id: string): Host => {
  const h = HOSTS.find((x) => x.id === id);
  if (!h) throw new Error(`U1 host table has no ${id}`);
  return h;
};
const CONTROLLER = pickHost("v2-pilot");
const TARGET = pickHost("v1-floor");
const DEADLINE_MS = 15 * 60_000;
const startedAt = Date.now();

const log = (m: string) => console.error(`[delegation] ${m}`);
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const nonce = (tag: string) => `U2N-${tag}${randomBytes(5).toString("hex")}`;
const overDeadline = () => Date.now() - startedAt > DEADLINE_MS;

// ---------------------------------------------------------------------------
// Build the artifact from the CURRENT working tree and pack it
// ---------------------------------------------------------------------------

function buildPackage(iso: Iso) {
  const gitEnv = { PATH: `${BASE_PATH}:/opt/homebrew/bin` };
  const git = (...a: string[]) =>
    sh(`git ${a[0]}`, "git", a, { cwd: repoRoot, env: gitEnv });
  const files = git(
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  )
    .split("\0")
    .filter(Boolean)
    .filter((f) => {
      try {
        return statSync(join(repoRoot, f)).isFile();
      } catch {
        return false; // tracked but deleted in the working tree
      }
    });
  const src = join(iso.work, "src");
  mkdirSync(src);
  const tree = createHash("sha256");
  for (const f of files.sort()) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    cpSync(join(repoRoot, f), join(src, f));
    tree.update(`${f}\0${sha(readFileSync(join(repoRoot, f)))}\n`);
  }
  const home = join(iso.work, "build-home");
  mkdirSync(home);
  const env = {
    PATH: `${dirname(process.execPath)}:${dirname(iso.node)}:${BASE_PATH}`,
    HOME: home,
    BUN_INSTALL_CACHE_DIR: join(iso.work, "bun-cache"),
    NPM_CONFIG_USERCONFIG: join(iso.work, "npmrc-user"),
    NPM_CONFIG_GLOBALCONFIG: join(iso.work, "npmrc-global"),
    NPM_CONFIG_CACHE: join(iso.work, "npm-cache"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  log(`build: ${files.length} working-tree files, bun install + build + pack`);
  sh("bun install", process.execPath, ["install", "--frozen-lockfile"], {
    cwd: src,
    env,
  });
  sh("bun build", process.execPath, ["run", "build"], { cwd: src, env });
  const out = sh(
    "npm pack",
    "npm",
    ["pack", "--ignore-scripts", "--silent", "--pack-destination", iso.work],
    { cwd: src, env },
  )
    .trim()
    .split("\n")
    .pop();
  const tarball = identify(join(iso.work, out ?? ""));

  // The artifact must be the real current entry, not the U1 stand-in.
  const entry = (name: string) =>
    spawnSync("tar", ["-xzOf", tarball.file, `package/${name}`], {
      env: { PATH: BASE_PATH },
      maxBuffer: 64 << 20,
    });
  const listing = spawnSync("tar", ["-tzf", tarball.file], {
    env: { PATH: BASE_PATH },
  })
    .stdout.toString()
    .split("\n");
  const index = entry("dist/index.js").stdout.toString();
  const manifest = JSON.parse(entry("package.json").stdout.toString()) as Json;
  const meta = manifest["peerDependenciesMeta"] as
    | Record<string, { optional?: boolean }>
    | undefined;
  const shape = {
    defaultEntryIsObjectWithServerAndSetup:
      /id:\s*"space-bus"/.test(index) &&
      /server:\s*serverV1/.test(index) &&
      /setup:\s*setupV2/.test(index),
    noU1StubMarkers:
      !index.includes("U1_LIFECYCLE_FILE") &&
      !listing.some((l) => l.endsWith("candidate-schemas.json")),
    noV1PeerReference: !index.includes("@opencode-ai/plugin"),
    v1PeerOptionalInManifest: meta?.["@opencode-ai/plugin"]?.optional === true,
  };
  return {
    tarball,
    shape,
    provenance: {
      head: git("rev-parse", "HEAD").trim(),
      workingTreeFiles: files.length,
      workingTreeDigest: tree.digest("hex"),
      dirtyPaths: git("status", "--short").split("\n").filter(Boolean).length,
      bun: process.versions["bun"],
      source:
        "git ls-files --cached --others --exclude-standard, current contents",
    },
  };
}

// ---------------------------------------------------------------------------
// Cells: one private HOME/XDG/config/TMPDIR tree per host
// ---------------------------------------------------------------------------

type Cell = {
  dir: string;
  p: (rel: string) => string;
  env: (extra?: Record<string, string>) => Record<string, string>;
};

function makeCell(iso: Iso, name: string): Cell {
  const dir = join(iso.work, "cells", name);
  const p = (rel: string) => join(dir, rel);
  for (const d of [
    "home",
    "tmp",
    "xdg/config",
    "xdg/data",
    "xdg/cache",
    "xdg/state",
    "config",
  ]) {
    mkdirSync(p(d), { recursive: true });
  }
  return {
    dir,
    p,
    env: (extra = {}) => ({
      PATH: `${dirname(iso.node)}:${BASE_PATH}`,
      LANG: "en_US.UTF-8",
      HOME: p("home"),
      TMPDIR: p("tmp"),
      XDG_CONFIG_HOME: p("xdg/config"),
      XDG_DATA_HOME: p("xdg/data"),
      XDG_CACHE_HOME: p("xdg/cache"),
      XDG_STATE_HOME: p("xdg/state"),
      OPENCODE_CONFIG_DIR: p("config"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true",
      OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
      OPENCODE_DISABLE_PRUNE: "true",
      ...extra,
    }),
  };
}

function installHosts(iso: Iso, tarballFile: string, tarballIntegrity: string) {
  const npmEnv = {
    PATH: `${dirname(iso.node)}:${BASE_PATH}`,
    HOME: join(iso.work, "build-home"),
    NPM_CONFIG_USERCONFIG: join(iso.work, "npmrc-user"),
    NPM_CONFIG_GLOBALCONFIG: join(iso.work, "npmrc-global"),
    NPM_CONFIG_CACHE: join(iso.work, "npm-cache"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  const install = (dir: string, specs: string[]) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      '{"name":"u2-consumer","private":true,"type":"module"}',
    );
    sh(
      `npm install ${basename(dir)}`,
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        ...specs,
      ],
      { cwd: dir, env: npmEnv },
    );
    const nm = join(dir, "node_modules");
    const lock = (
      JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
        packages: Record<string, { version?: string; integrity?: string }>;
      }
    ).packages;
    const present = readdirSync(nm)
      .filter((n) => !n.startsWith("."))
      .flatMap((n) =>
        n.startsWith("@")
          ? readdirSync(join(nm, n)).map((s) => `${n}/${s}`)
          : [n],
      );
    return { nm, lock, present };
  };
  log("install: v2.3.2 controller + packed package (no v1 SDK)");
  const ctl = install(join(iso.work, "hosts/controller"), [
    ...CONTROLLER.packages
      .filter((n) => n !== CONTROLLER.packages[1])
      .map((n) => `${n}@${CONTROLLER.version}`),
    tarballFile,
  ]);
  log("install: v1.17.13 target (host only)");
  const tgt = install(join(iso.work, "hosts/target"), [
    `opencode-ai@${TARGET.version}`,
  ]);
  const pinned = (
    h: Host,
    lock: Record<string, { version?: string; integrity?: string }>,
    names: string[],
  ) =>
    names.every((n) => {
      const e = lock[`node_modules/${n}`];
      return (
        e?.version === h.version && e.integrity === PINS[`${n}@${h.version}`]
      );
    });
  return {
    controllerBin: join(
      ctl.nm,
      CONTROLLER.packages[1] as string,
      "bin/opencode",
    ),
    targetBin: join(tgt.nm, TARGET.packages[1] as string, "bin/opencode"),
    pkgDir: join(ctl.nm, PACKAGE),
    identity: {
      controllerPinned: pinned(CONTROLLER, ctl.lock, [...CONTROLLER.packages]),
      targetPinned: pinned(TARGET, tgt.lock, [
        TARGET.packages[0] as string,
        TARGET.packages[1] as string,
      ]),
      controllerHasV1Sdk: ctl.present.filter(
        (n) => n.startsWith("@opencode-ai/") || n.startsWith("opencode-"),
      ),
      targetHasV2: tgt.present.filter((n) => n.startsWith("@opencode/")),
      tarballLocked:
        ctl.lock[`node_modules/${PACKAGE}`]?.integrity === tarballIntegrity,
      installedEntrySha: sha(
        readFileSync(join(ctl.nm, PACKAGE, "dist/index.js")),
      ),
      installedPackagePresent: existsSync(join(ctl.nm, PACKAGE)),
    },
  };
}

// ---------------------------------------------------------------------------
// Host processes
// ---------------------------------------------------------------------------

type Proc = {
  child: ChildProcess;
  bin: string;
  port: number;
  stop: () => Promise<{ stopped: boolean; portClosed: boolean }>;
};

function psCommand(pid: number): string {
  return spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
    env: { PATH: "/bin:/usr/bin" },
  })
    .stdout.toString()
    .trim();
}

/** pids whose process group is `pgid` (this run's detached managed target). */
function groupMembers(pgid: number): number[] {
  return spawnSync("/bin/ps", ["-axo", "pid=,pgid="], {
    env: { PATH: "/bin:/usr/bin" },
  })
    .stdout.toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/).map(Number))
    .filter((c) => c[1] === pgid && typeof c[0] === "number")
    .map((c) => c[0] as number);
}

/**
 * Signals only a process whose command line contains `mustContain` (a path
 * inside this run's work dir). With `group`, the whole process group is
 * signalled, but only after checking that the pid really leads it and that
 * every member's command line is also inside this run's work dir.
 */
async function killChecked(
  pid: number,
  mustContain: string,
  port: number,
  group = false,
): Promise<{ stopped: boolean; portClosed: boolean }> {
  const members = () => (group ? groupMembers(pid) : [pid]);
  const alive = () => members().some((m) => psCommand(m).length > 0);
  const safe = () =>
    members()
      .filter((m) => psCommand(m).length > 0)
      .every((m) => psCommand(m).includes(mustContain)) &&
    (!group || members().includes(pid));
  const send = (sig: NodeJS.Signals) => process.kill(group ? -pid : pid, sig);
  if (alive() && safe()) {
    send("SIGTERM");
    for (let i = 0; i < 40 && alive(); i++) await sleep(250);
    if (alive() && safe()) {
      send("SIGKILL");
      for (let i = 0; i < 20 && alive(); i++) await sleep(250);
    }
  }
  await sleep(200);
  return { stopped: !alive(), portClosed: !(await portOpen(port)) };
}

async function startHost(
  iso: Iso,
  cell: Cell,
  bin: string,
  cwd: string,
  extraEnv: Record<string, string>,
): Promise<Proc> {
  const port = await freePort();
  const w = inSandbox(iso, bin, [
    "serve",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ]);
  const fd = openSync(cell.p("host.log"), "w");
  const child = spawn(w.cmd, w.args, {
    cwd,
    stdio: ["ignore", fd, fd],
    env: cell.env(extraEnv),
  });
  closeSync(fd);
  return {
    child,
    bin,
    port,
    stop: async () => {
      const pid = child.pid;
      if (!pid) return { stopped: true, portClosed: !(await portOpen(port)) };
      // sandbox-exec execs the host in place, so the pid is the host's.
      return killChecked(pid, bin, port);
    },
  };
}

/** Why `url` may not be requested, or undefined if it may. Never echoes userinfo. */
export function destinationProblem(
  url: string,
  allowed: ReadonlySet<number>,
): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "not a valid URL";
  }
  if (u.protocol !== "http:") return `scheme ${u.protocol} is not http:`;
  if (u.username !== "" || u.password !== "")
    return "URL carries userinfo; credentials go in headers only";
  if (u.hostname !== "127.0.0.1") return `host ${u.hostname} is not 127.0.0.1`;
  const port = u.port === "" ? 80 : Number(u.port);
  if (!allowed.has(port))
    return `port ${port} is not one of this run's host ports`;
  return undefined;
}

/** A network-derived id used as one URL path segment, and nothing else. */
export function isSafeSessionId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export type ManagedDiscovery = { port: number; pid: number; password: string };

/**
 * Parses the plugin's discovery record (a file the plugin wrote, so not
 * trusted): the port becomes a request destination and the pid a signal
 * target. Reasons never include the record's contents.
 */
export function parseManagedDiscovery(
  raw: string,
): { ok: true; value: ManagedDiscovery } | { ok: false; reason: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "discovery record is not JSON" };
  }
  if (typeof v !== "object" || v === null || Array.isArray(v))
    return { ok: false, reason: "discovery record is not an object" };
  const r = v as Record<string, unknown>;
  const { port, pid, password } = r;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    return {
      ok: false,
      reason: "discovery port is not an integer in 1024-65535",
    };
  // pid 0/1/negative would turn a group signal into a broadcast.
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 2)
    return { ok: false, reason: "discovery pid is not an integer >= 2" };
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 256 ||
    [...password].some((ch) => {
      const c = ch.charCodeAt(0);
      return c < 0x20 || c === 0x7f;
    })
  )
    return {
      ok: false,
      reason: "discovery password is not a bounded printable string",
    };
  return { ok: true, value: { port, pid, password } };
}

/**
 * Verifies a discovery record against what the HARNESS independently knows,
 * before its port is requested or its pid signalled. The record is a file the
 * plugin wrote, so it is evidence to check, never a source of the destination:
 *   1. it parses (`parseManagedDiscovery`);
 *   2. its port equals `expectedPort`, which the harness reserved and wrote
 *      into the managed roster (so the plugin had to bind exactly it);
 *   3. its pid is a live process whose command line contains every
 *      `mustContain` path (this run's wrapper and target binary) and
 *      `--port <expectedPort>` as whole arguments.
 * A mismatch is rejected here, before any request or signal. Reasons never
 * include the record's contents.
 */
export function verifyManagedDiscovery(
  raw: string,
  opts: {
    expectedPort: number;
    mustContain: readonly string[];
    commandOf: (pid: number) => string;
  },
): { ok: true; value: ManagedDiscovery } | { ok: false; reason: string } {
  const parsed = parseManagedDiscovery(raw);
  if (!parsed.ok) return parsed;
  if (parsed.value.port !== opts.expectedPort)
    return {
      ok: false,
      reason:
        "discovery port is not the port reserved for this run's managed target",
    };
  const command = opts.commandOf(parsed.value.pid);
  if (command.length === 0)
    return { ok: false, reason: "discovery pid is not a running process" };
  if (!opts.mustContain.every((needle) => command.includes(needle)))
    return {
      ok: false,
      reason: "discovery pid is not this run's managed target process",
    };
  const argv = command.split(/\s+/);
  const at = argv.indexOf("--port");
  if (at < 0 || argv[at + 1] !== String(opts.expectedPort))
    return {
      ok: false,
      reason: "discovery pid is not serving the reserved port",
    };
  return parsed;
}
/**
 * A run-local HTTP client. Every request this harness makes goes to a host it
 * started itself, on 127.0.0.1, on a port the HARNESS chose (`freePort()` for
 * the controller, the external target and the managed target alike; the
 * managed port is written into the roster so the plugin must use it). `json`
 * refuses anything else before connecting, and never follows a redirect, so a
 * response cannot move a request (or its basic-auth header) off the validated
 * destination. Nothing about a destination is ever taken from a file or a
 * response.
 */
export function createLoopbackHttp(): {
  allow: (port: number) => void;
  json: (
    url: string,
    headers: Record<string, string>,
    method?: string,
    body?: unknown,
  ) => Promise<{ status: number; body: unknown }>;
} {
  const allowed = new Set<number>();
  return {
    allow(port) {
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("refusing to allow a port outside 1024-65535");
      allowed.add(port);
    },
    async json(url, headers, method = "GET", body) {
      const refused = destinationProblem(url, allowed);
      if (refused !== undefined)
        return { status: 0, body: `destination refused: ${refused}` };
      try {
        const r = await fetch(url, {
          method,
          headers: {
            ...headers,
            ...(body ? { "content-type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(60_000),
        });
        const text = await r.text();
        try {
          return { status: r.status, body: JSON.parse(text) };
        } catch {
          return { status: r.status, body: text };
        }
      } catch (e) {
        return { status: 0, body: String(e) };
      }
    },
  };
}

const basic = (user: string, pw: string) =>
  `Basic ${Buffer.from(`${user}:${pw}`).toString("base64")}`;

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined>,
  everyMs = 500,
): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(everyMs)) {
    if (overDeadline())
      throw new Error(`global deadline hit waiting for ${what}`);
    const v = await probe();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Managed-mode preflight: native process inspection inside the sandbox.
//
// The plugin's managed-server lifecycle records a process identity with
// `ps -p <pid> -o lstart=,comm=` (src/discovery.ts captureIdentity) and later
// re-verifies it; with no identity it refuses to attach to the server it just
// spawned. So managed mode can only be exercised where THAT call works, inside
// the same sandbox the controller runs in. This probe makes the call the way
// the product does (`execFileSync("ps", ...)` from node, PATH lookup, LC_ALL=C)
// in the sandbox, and once more unsandboxed as a control that attributes any
// failure to the sandbox. It starts no host and no managed target, runs each
// probe once, and never brokers, shims or relaxes anything: if the native call
// is denied, managed mode is BLOCKED -- reported as such, never as a pass.
// ---------------------------------------------------------------------------

export type ProbeRun = {
  status: number | null;
  stdout: string;
  stderr: string;
};

const probeWorked = (p: ProbeRun) => p.status === 0 && p.stdout.length > 0;

/**
 * `available`: the native call works inside the sandbox. Otherwise the failure
 * is attributable to the sandbox (managed mode BLOCKED) only if the same call
 * works unsandboxed; if the control also fails, nothing is attributable and the
 * preflight is `inconclusive` (the run is invalid, exit 1), never BLOCKED.
 */
export function classifyPreflight(
  sandboxed: ProbeRun,
  control: ProbeRun,
): { available: boolean; inconclusive: boolean } {
  const available = probeWorked(sandboxed);
  return { available, inconclusive: !available && !probeWorked(control) };
}

function preflightProcessInspection(iso: Iso): {
  command: string;
  sandboxed: ProbeRun;
  control: ProbeRun;
  available: boolean;
  inconclusive: boolean;
} {
  const code =
    "const {execFileSync}=require('node:child_process');" +
    "process.stdout.write(execFileSync('ps',['-p',String(process.pid),'-o','lstart=,comm='],{env:{...process.env,LC_ALL:'C'},encoding:'utf8'}))";
  const run = (wrapped: boolean): ProbeRun => {
    const args = ["-e", code];
    const c = wrapped
      ? inSandbox(iso, iso.node, args)
      : { cmd: iso.node, args };
    const r = spawnSync(c.cmd, c.args, {
      cwd: iso.work,
      env: { PATH: BASE_PATH },
      timeout: 30_000,
    });
    return {
      status: r.status,
      stdout: r.stdout.toString().trim().slice(0, 120),
      stderr: (
        r.stderr
          .toString()
          .split("\n")
          .find((l) => /Error|EPERM|not permitted|Operation/.test(l)) ?? ""
      ).slice(0, 200),
    };
  };
  const sandboxed = run(true);
  const control = run(false);
  return {
    command: "node -e execFileSync('ps',['-p',<own pid>,'-o','lstart=,comm='])",
    sandboxed,
    control,
    ...classifyPreflight(sandboxed, control),
  };
}

class PreflightOnly extends Error {}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const EVIDENCE_STRING_CAP = 4000;
const CREDENTIAL_KEY =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|password|passwd|secret|(access[-_]?|refresh[-_]?|auth[-_]?)?token|credentials?)$/i;

/**
 * Everything persisted comes from hosts and HTTP reads, so it is treated as
 * untrusted and sensitive until scrubbed. Per string, in this order: known
 * secrets and local paths are replaced FIRST (so truncation cannot split one
 * into an unredacted fragment), then credential-shaped text (Basic/Bearer
 * values, URL userinfo, token-like query parameters), then control characters
 * are dropped and the length is capped. Credential-named keys are redacted
 * whatever their value. The final text is still checked against every needle
 * that must never reach disk, and the check fails closed without echoing it.
 */
export function renderEvidence(
  value: unknown,
  opts: {
    swaps: ReadonlyArray<readonly [string, string]>;
    secrets: ReadonlySet<string>;
    guard: readonly string[];
  },
): string {
  const scrub = (s: string): string => {
    let t = s;
    for (const secret of opts.secrets)
      if (secret.length > 0) t = t.split(secret).join("<redacted>");
    for (const [from, to] of opts.swaps) t = t.split(from).join(to);
    t = t
      .replace(/\/Users\/[^\s"'\\/]+/g, "/Users/<user>")
      .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._~-]{16,}/g, "$1 <redacted>")
      .replace(
        /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]*@/gi,
        "$1<redacted>@",
      )
      .replace(
        /([?&;](?:access[-_]?token|token|password|passwd|api[-_]?key|key|secret)=)[^&\s"']+/gi,
        "$1<redacted>",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters from untrusted text is the point
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
    return t.length > EVIDENCE_STRING_CAP
      ? `${t.slice(0, EVIDENCE_STRING_CAP)}…[truncated ${t.length - EVIDENCE_STRING_CAP} chars]`
      : t;
  };
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null)
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [
          scrub(k),
          CREDENTIAL_KEY.test(k) ? "<redacted>" : walk(x),
        ]),
      );
    return v;
  };
  const text = `${JSON.stringify(walk(value), null, 2)}\n`;
  for (const needle of [...opts.guard, ...opts.secrets]) {
    if (needle.length > 3 && text.includes(needle))
      throw new Error("refusing to persist: leak guard tripped");
  }
  return text;
}

// ---------------------------------------------------------------------------
// What is persisted
//
// Everything below is assembled from hosts and HTTP reads, so raw values
// (prompts, tool arguments, tool results, transcripts, response bodies, error
// text) stay in memory for the harness's assertions and are NEVER written.
// What reaches disk is only: observed categorical verdicts, counts, ids that
// match a fixed shape, members of sets the HARNESS supplied (projects, rosters,
// nonces, directories, fixture roles/labels), booleans, and bounded digests
// (length + a 16-hex SHA-256 prefix) for correlation. Free text is never
// copied; reasons are copied only when they are in a closed, harness-authored
// vocabulary (`recognizedReasons`). `renderEvidence` still scrubs and caps
// whatever is written, as a second layer, but nothing here relies on it.
// ---------------------------------------------------------------------------

export type HarnessKnown = {
  projects: ReadonlySet<string>;
  rosters: ReadonlySet<string>;
  nonces: ReadonlySet<string>;
  dirs: Readonly<Record<string, string>>;
};

const OTHER = "<other>";
const boundedDigest = (s: string) => ({
  length: s.length,
  sha256: sha(s).slice(0, 16),
});
const memberOf = (set: ReadonlySet<string>, v: unknown): string | null =>
  typeof v === "string" && set.has(v) ? v : null;
const noncesIn = (s: string, known: HarnessKnown): string[] =>
  [...known.nonces].filter((n) => s.includes(n)).sort();

/**
 * The closed vocabulary of reasons the harness itself authors. Matching is
 * anchored and the only variable parts are small integers or a fixed choice,
 * so a response cannot smuggle text through a reason.
 */
const REASON_VOCABULARY: readonly RegExp[] = [
  /^request failed or timed out \((destination refused|timed out|connection failed)\)$/,
  /^HTTP \d{1,3}$/,
  /^response is not (JSON|a list)$/,
  /^unexpected response shape$/,
  /^entry \d{1,5} is malformed$/,
  /^entry \d{1,5} (is not an object|has no `info` object|has no `parts` list)$/,
  /^entry \d{1,5} has no v1 `info\.role` \(user or assistant\)$/,
  /^entry \d{1,5} part \d{1,5} (is not an object|has no string `type`)$/,
  /^entry \d{1,5} part \d{1,5} is a (text|reasoning) part without a string `text`$/,
  /^model fixture request log is missing$/,
  /^model fixture request \d{1,5} is malformed$/,
  /^managed target has no discovery record$/,
  /^controller model was never called$/,
  /^session create failed \(status \d{1,3}\)$/,
];

/** Fixed reasons `parseManagedDiscovery`/`verifyManagedDiscovery` can return. */
const REASON_EXACT: ReadonlySet<string> = new Set([
  "discovery record is not JSON",
  "discovery record is not an object",
  "discovery port is not an integer in 1024-65535",
  "discovery pid is not an integer >= 2",
  "discovery password is not a bounded printable string",
  "discovery port is not the port reserved for this run's managed target",
  "discovery pid is not a running process",
  "discovery pid is not this run's managed target process",
  "discovery pid is not serving the reserved port",
]);

/** The vocabulary reasons found in a harness-built message; nothing else is kept. */
export function recognizedReasons(text: string): string[] {
  const out = new Set<string>();
  for (const clause of text.split("; "))
    for (const piece of clause.split(": ")) {
      const t = piece.trim();
      if (REASON_EXACT.has(t) || REASON_VOCABULARY.some((re) => re.test(t)))
        out.add(t);
    }
  return [...out].slice(0, 16);
}

/** A transport failure as a category, never the error text (which can echo a URL). */
export function transportFailure(
  body: unknown,
): "destination refused" | "timed out" | "connection failed" {
  const s = String(body);
  if (s.startsWith("destination refused")) return "destination refused";
  return /timeout|timed out|abort/i.test(s) ? "timed out" : "connection failed";
}

const FLOW_STEP_CAP = 64;
const KNOWN_STEP_STATUS = new Set(["completed", "error", "running", "pending"]);
// Closed sets of harness-authored names; anything else persists as "<other>".
const FLOW_NAMES: ReadonlySet<string> = new Set([
  "ext-ambient",
  "managed-override",
  "negative",
]);
const BUS_TOOL_NAMES: ReadonlySet<string> = new Set([
  "bus_registry",
  "bus_result",
  "bus_roster",
  "bus_status",
  "bus_task",
  "bus_wait",
]);
const FIXTURE_ROLES: ReadonlySet<string> = new Set([
  "controller",
  "target",
  "unknown",
]);
const FIXTURE_LABELS: ReadonlySet<string> = new Set(["ext", "mgd"]);
const FIXTURE_TOOLS: ReadonlySet<string> = new Set(["execute"]);

/** A host session id as it is persisted: the fixed `ses_` form, bounded. */
const HOST_SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/;
const isHostSessionId = (v: unknown): v is string =>
  typeof v === "string" && HOST_SESSION_ID.test(v);
const SESSION_IN_TEXT = /Session (ses_[A-Za-z0-9]{1,64}) in /;

export type StepEvidence = {
  tool: string;
  status: string | null;
  argKeys: string[];
  project: string | null;
  roster: string | null;
  nonce: string | null;
  sessionIds: string[];
  timeoutMs: number | null;
  result: {
    length: number;
    sha256: string;
    noncesSeen: string[];
    dispatchedSession: string | null;
  };
};
export type FlowEvidence = {
  name: string;
  sessionId: string | null;
  outcome: "succeeded" | "other" | null;
  stepCount: number;
  steps: StepEvidence[];
  finalText: {
    length: number;
    sha256: string;
    noncesSeen: string[];
  } | null;
  problems: string[];
  unreadable: string[];
};

const ARG_KEYS = [
  "project",
  "prompt",
  "roster",
  "sessionId",
  "sessionIds",
  "timeoutMs",
] as const;

const boundedMs = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 3_600_000
    ? v
    : null;

function projectStep(s: ToolStep, known: HarnessKnown): StepEvidence {
  const args = isRecord(s.args) ? s.args : {};
  const text = typeof s.text === "string" ? s.text : "";
  const prompt = typeof args["prompt"] === "string" ? args["prompt"] : "";
  const ids = Array.isArray(args["sessionIds"]) ? args["sessionIds"] : [];
  return {
    tool: memberOf(BUS_TOOL_NAMES, s.tool) ?? OTHER,
    status:
      typeof s.status === "string"
        ? (memberOf(KNOWN_STEP_STATUS, s.status) ?? OTHER)
        : null,
    argKeys: ARG_KEYS.filter((k) => k in args),
    project: memberOf(known.projects, args["project"]),
    roster: memberOf(known.rosters, args["roster"]),
    nonce: noncesIn(prompt, known)[0] ?? null,
    sessionIds: [args["sessionId"], ...ids]
      .filter(isHostSessionId)
      .slice(0, 16),
    timeoutMs: boundedMs(args["timeoutMs"]),
    result: {
      ...boundedDigest(text),
      noncesSeen: noncesIn(text, known),
      dispatchedSession: SESSION_IN_TEXT.exec(text)?.[1] ?? null,
    },
  };
}

/**
 * The persisted form of a flow: categorical and bounded (see the section
 * comment). The raw `args`, step `text` and `finalText` are not copied; their
 * routing-relevant content is reduced to harness-known members (project,
 * roster, nonces seen), `ses_` ids and a digest.
 */
export function projectFlowEvidence(
  f: Flow,
  known: HarnessKnown,
): FlowEvidence {
  const steps = Array.isArray(f.steps) ? f.steps : [];
  return {
    name: memberOf(FLOW_NAMES, f.name) ?? OTHER,
    sessionId: isHostSessionId(f.sessionId) ? f.sessionId : null,
    outcome:
      typeof f.outcome === "string"
        ? f.outcome === "succeeded"
          ? "succeeded"
          : "other"
        : null,
    stepCount: steps.length,
    steps: steps.slice(0, FLOW_STEP_CAP).map((s) => projectStep(s, known)),
    finalText:
      typeof f.finalText === "string"
        ? {
            ...boundedDigest(f.finalText),
            noncesSeen: noncesIn(f.finalText, known),
          }
        : null,
    problems: recognizedReasons((f.problems ?? []).join("; ")),
    unreadable: recognizedReasons((f.unreadable ?? []).join("; ")),
  };
}

export type CheckEvidence = {
  name: string;
  kind: Check["kind"];
  mode: Check["mode"];
  ok: boolean;
  unobserved: boolean;
  reasons: string[];
  detail: { length: number; sha256: string } | null;
};

/**
 * A check's name is harness-authored (never built from host content). Its
 * `detail` is raw (host versions, ids, paths, response snippets) and stays in
 * memory: only the vocabulary reasons it contains and a digest are persisted.
 */
export function projectCheckEvidence(c: Check): CheckEvidence {
  const detail = typeof c.detail === "string" ? c.detail : undefined;
  return {
    name: String(c.name).slice(0, 200),
    kind: c.kind,
    mode: c.mode,
    ok: c.ok === true,
    unobserved: c.unobserved === true,
    reasons: detail === undefined ? [] : recognizedReasons(detail),
    detail: detail === undefined ? null : boundedDigest(detail),
  };
}

function projectFixtureRequest(q: unknown, index: number, known: HarnessKnown) {
  const r = isRecord(q) ? q : {};
  const d = isRecord(r["decision"]) ? r["decision"] : {};
  const nonces = Array.isArray(r["nonces"])
    ? r["nonces"].filter((n): n is string => typeof n === "string")
    : [];
  const label = r["label"];
  const cwd = r["cwd"];
  const text = d["text"];
  const step = d["step"];
  return {
    index,
    role: memberOf(FIXTURE_ROLES, r["role"]) ?? OTHER,
    label:
      label === null || label === undefined
        ? null
        : (memberOf(FIXTURE_LABELS, label) ?? OTHER),
    hasTools: r["hasTools"] === true,
    noncesSeen: nonces.filter((n) => known.nonces.has(n)).sort(),
    otherNonces: nonces.filter((n) => !known.nonces.has(n)).length,
    cwd:
      typeof cwd === "string"
        ? (Object.entries(known.dirs).find(([, dir]) => dir === cwd)?.[0] ??
          OTHER)
        : null,
    decision: {
      kind: typeof text === "string" ? "text" : "via" in d ? "tool" : OTHER,
      tool: memberOf(FIXTURE_TOOLS, d["via"]),
      step:
        typeof step === "number" &&
        Number.isInteger(step) &&
        step >= 0 &&
        step <= 1000
          ? step
          : null,
      ack: typeof text === "string" && text.startsWith("ACK"),
    },
  };
}

export function projectFixtureRequests(reqs: unknown, known: HarnessKnown) {
  return (Array.isArray(reqs) ? reqs : [])
    .slice(0, 512)
    .map((q, index) => projectFixtureRequest(q, index, known));
}

/** Teardown results as booleans and counts; a thrown error's text is not kept. */
export function projectTeardown(t: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(t).map(([label, v]) => [
      label,
      typeof v === "number" && Number.isFinite(v)
        ? v
        : isRecord(v) && "error" in v
          ? { threw: true }
          : isRecord(v)
            ? {
                stopped: v["stopped"] === true,
                portClosed: v["portClosed"] === true,
              }
            : OTHER,
    ]),
  );
}

/** A local probe's stderr as a coarse kind; the text itself is not kept. */
const stderrKind = (s: string) =>
  s.length === 0
    ? "none"
    : /EPERM|EACCES|not permitted|Operation/.test(s)
      ? "denied"
      : /ENOENT|not found/.test(s)
        ? "not-found"
        : "other";

export function projectPreflight(p: {
  command: string;
  sandboxed: ProbeRun;
  control: ProbeRun;
  available: boolean;
  inconclusive: boolean;
}) {
  const probe = (r: ProbeRun) => ({
    status: r.status,
    stdoutBytes: r.stdout.length,
    stderrKind: stderrKind(r.stderr),
  });
  return {
    command: p.command,
    sandboxed: probe(p.sandboxed),
    control: probe(p.control),
    available: p.available,
    inconclusive: p.inconclusive,
  };
}

/** A thrown message as a category: its text can carry child-process output. */
export function fatalCategory(message: string): string {
  if (message.startsWith("global deadline hit")) return "global deadline hit";
  if (message.startsWith("timed out waiting")) return "timed out waiting";
  if (message === "OS sandbox self-test failed")
    return "OS sandbox self-test failed";
  if (message === "harness identity checks failed")
    return "harness identity checks failed";
  return "harness step failed";
}

/**
 * Console output is treated like persisted output: it may be captured by a
 * terminal, CI or a log shipper, so it carries the same categorical
 * projections and never raw host strings, prompts, tool results or
 * credentials. (Child-process output goes to per-host log files in the work
 * dir, not to the console.) Free text and thrown messages are never echoed.
 */
const oneLine = (s: string) => [...s].filter((c) => c >= " ").join("");

/** Any thrown value as a fixed category (a filesystem code is kept; a path is not). */
export function errorCategory(e: unknown): string {
  const message = e instanceof Error ? e.message : "";
  if (message.startsWith("refusing to persist")) return "leak guard tripped";
  if (message.startsWith("refusing to overwrite"))
    return "refusing to overwrite an evidence file";
  if (message === "invalid --run-id") return "invalid --run-id";
  if (message.endsWith("is not git-ignored"))
    return "evidence directory is not git-ignored";
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^E[A-Z0-9]{2,12}$/.test(code))
    return `filesystem error ${code}`;
  return fatalCategory(message);
}

/** One console line for a check: verdict, harness-authored name, recognised reasons, detail digest. */
export function renderCheckLog(c: Check): string {
  const e = projectCheckEvidence(c);
  const status = e.ok ? "ok  " : e.unobserved ? "UNOBSERVED" : "FAIL";
  const why =
    e.ok || e.reasons.length === 0 ? "" : ` — ${e.reasons.join("; ")}`;
  const digest =
    e.ok || !e.detail
      ? ""
      : ` (detail ${e.detail.length} chars #${e.detail.sha256.slice(0, 8)})`;
  return oneLine(`${status} [${e.kind}/${e.mode}] ${e.name}${why}${digest}`);
}

/** Console lines for a flow: phase, outcome, routing correlation, result digests. */
export function renderFlowLog(f: Flow, known: HarnessKnown): string[] {
  const e = projectFlowEvidence(f, known);
  const list = (xs: string[]) => (xs.length > 0 ? xs.join("; ") : "none");
  return [
    `flow ${e.name}: outcome=${e.outcome} steps=${e.stepCount} problems=${list(e.problems)} unreadable=${list(e.unreadable)}`,
    ...e.steps.map(
      (s) =>
        `  ${s.tool} [${s.status}] project=${s.project ?? "-"} roster=${s.roster ?? "-"} nonce=${s.nonce ?? "-"} session=${s.result.dispatchedSession ?? "-"} nonces-in-result=[${s.result.noncesSeen.join(",")}] result=${s.result.length} chars #${s.result.sha256.slice(0, 8)}`,
    ),
  ].map(oneLine);
}

export const renderPreflightLog = (p: Parameters<typeof projectPreflight>[0]) =>
  `managed preflight: ${JSON.stringify(projectPreflight(p))}`;

/** The sandbox self-test as its verdict and the names of the checks that failed. */
export function renderSelfTestLog(s: {
  ok: boolean;
  checks: Record<string, boolean>;
}): string {
  const failed = Object.entries(s.checks)
    .filter(([, v]) => v !== true)
    .map(([k]) => k);
  return oneLine(
    `sandbox self-test: ok=${s.ok === true} failed=[${failed.join(",")}]`,
  );
}
function openEvidence(iso: Iso, runId: string, secrets: Set<string>) {
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(runId))
    throw new Error("invalid --run-id");
  const parent = join(repoRoot, ".context/u2-delegation");
  mkdirSync(parent, { recursive: true });
  const ignored = spawnSync(
    "git",
    ["check-ignore", "-q", "--", `.context/u2-delegation/${runId}/x`],
    { cwd: repoRoot, env: { PATH: `${BASE_PATH}:/opt/homebrew/bin` } },
  );
  if (ignored.status !== 0)
    throw new Error(".context/u2-delegation is not git-ignored");
  mkdirSync(join(parent, runId), { mode: 0o700 });
  const dir = realpathSync(join(parent, runId));
  mkdirSync(join(dir, "flows"), { mode: 0o700 });
  const swaps = (
    [
      [dir, "<run>"],
      [iso.work, "<work>"],
      [repoRoot, "<repo>"],
      [tmpdir(), "<tmp>"],
      [iso.realHome, "<home>"],
      [process.env["HOME"] ?? "", "<home>"],
    ] as const
  )
    .filter(([from]) => from.length > 3)
    .sort((a, b) => b[0].length - a[0].length);
  return {
    dir,
    write(rel: string, value: unknown) {
      const final = join(dir, rel);
      if (existsSync(final)) throw new Error(`refusing to overwrite ${rel}`);
      const text = renderEvidence(value, {
        swaps,
        secrets,
        guard: [iso.realHome, process.env["HOME"] ?? "", iso.work, repoRoot],
      });
      const tmp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, text);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, final);
    },
  };
}

export type Check = {
  name: string;
  kind: "harness" | "u2";
  /** Which target mode a check belongs to (managed is gated by the preflight). */
  mode: "external" | "managed";
  ok: boolean;
  detail?: string;
  /**
   * The evidence behind this check could not be read (failed / timed-out /
   * non-2xx / malformed read, or a missing fixture log). Such a check is
   * `ok: false` but is NOT a product finding: it means the claim is not
   * established, so its mode is INCOMPLETE and the run is incomplete.
   */
  unobserved?: true;
};

// ---------------------------------------------------------------------------
// Evidence handling
//
// Several routing claims are ABSENCE claims ("no session in beta's directory",
// "this nonce never reached the managed target's model"). An absence claim is
// only worth anything if the read behind it succeeded. Every read therefore
// returns an Observation: `ok:false` (failed, timed out, non-2xx, not JSON,
// wrong shape, malformed entries, missing fixture log) is UNREADABLE and is
// never coerced to an empty result; `ok:true` with an empty value is a true
// empty. A check whose reads are not all readable is recorded as
// `unobserved` (not established), never as a pass and never as a product
// finding. A claim is also scoped: it is made only about the target/project
// cells it actually read, and names them.
// ---------------------------------------------------------------------------

export type V1Session = { id: string; directory?: string };
export type TargetId = "ext" | "mgd";
export type Observation<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };
export type HttpRead = { status: number; body: unknown };
export type ModelHit = { cwd: string | null };

const unreadable = (reason: string): Observation<never> => ({
  ok: false,
  reason,
});

function readJsonList(r: HttpRead, what: string): Observation<unknown[]> {
  if (r.status === 0)
    return unreadable(
      `${what}: request failed or timed out (${transportFailure(r.body)})`,
    );
  if (r.status < 200 || r.status > 299)
    return unreadable(`${what}: HTTP ${r.status}`);
  if (typeof r.body === "string")
    return unreadable(`${what}: response is not JSON`);
  if (!Array.isArray(r.body))
    return unreadable(`${what}: response is not a list`);
  return { ok: true, value: r.body };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function readSessionList(
  r: HttpRead,
  what = "session list",
): Observation<V1Session[]> {
  const list = readJsonList(r, what);
  if (!list.ok) return list;
  const at = list.value.findIndex(
    (s) =>
      !isRecord(s) ||
      typeof s["id"] !== "string" ||
      (s["directory"] !== undefined && typeof s["directory"] !== "string"),
  );
  if (at >= 0) return unreadable(`${what}: entry ${at} is malformed`);
  return { ok: true, value: list.value as V1Session[] };
}

/**
 * The v1 message envelope, from the pinned v1.17.13 contract (SDK
 * `SessionMessagesResponses[200]` = `Array<{ info: Message; parts: Array<Part> }>`,
 * `Message` = user | assistant by `role`) and a real v1.17.13 target's stored
 * messages: `info.role`; text and reasoning parts carry a string `text`; every
 * other part (tool, file, step-start, step-finish, snapshot, patch, agent,
 * retry, compaction, subtask) carries only its own `type`. Presence/absence is
 * decided on the serialized list, so an entry that does not look like a
 * message (`{}`, no `info`/`parts`, a part with no `type`, a text part with no
 * text) means the content cannot be trusted and the whole transcript is
 * unreadable. Ids are in the contract but are not required: they are stored as
 * columns and were not observed in a saved response, so nothing here depends
 * on them.
 */
const V1_ROLES = new Set(["user", "assistant"]);

function transcriptPartProblem(part: unknown): string | undefined {
  if (!isRecord(part)) return "is not an object";
  const type = part["type"];
  if (typeof type !== "string" || type.length === 0)
    return "has no string `type`";
  if (
    (type === "text" || type === "reasoning") &&
    typeof part["text"] !== "string"
  )
    return `is a ${type} part without a string \`text\``;
  return undefined;
}

function transcriptEntryProblem(entry: unknown): string | undefined {
  if (!isRecord(entry)) return "is not an object";
  const info = entry["info"];
  if (!isRecord(info)) return "has no `info` object";
  if (typeof info["role"] !== "string" || !V1_ROLES.has(info["role"]))
    return "has no v1 `info.role` (user or assistant)";
  const parts = entry["parts"];
  if (!Array.isArray(parts)) return "has no `parts` list";
  for (const [i, part] of parts.entries()) {
    const problem = transcriptPartProblem(part);
    if (problem) return `part ${i} ${problem}`;
  }
  return undefined;
}

export function readTranscript(
  r: HttpRead,
  what = "transcript",
): Observation<string> {
  const list = readJsonList(r, what);
  if (!list.ok) return list;
  for (const [i, entry] of list.value.entries()) {
    const problem = transcriptEntryProblem(entry);
    if (problem) return unreadable(`${what}: entry ${i} ${problem}`);
  }
  return { ok: true, value: JSON.stringify(list.value) };
}

type FixtureRequest = {
  role: string;
  hasTools?: boolean;
  label: string | null;
  nonces: string[];
  cwd: string | null;
};

/** The controller (v2) message list: `{ data: [...] }`; unreadable is never "no messages". */
export function readControllerMessages(r: HttpRead): Observation<Json[]> {
  if (r.status === 0)
    return unreadable(
      `controller message list: request failed or timed out (${transportFailure(r.body)})`,
    );
  if (r.status < 200 || r.status > 299)
    return unreadable(`controller message list: HTTP ${r.status}`);
  if (!isRecord(r.body) || !Array.isArray(r.body["data"]))
    return unreadable("controller message list: unexpected response shape");
  const data = r.body["data"] as unknown[];
  const at = data.findIndex((m) => !isRecord(m));
  if (at >= 0)
    return unreadable(`controller message list: entry ${at} is malformed`);
  return { ok: true, value: data as Json[] };
}

export function readFixtureRequests(
  requests: unknown,
): Observation<FixtureRequest[]> {
  if (!Array.isArray(requests))
    return unreadable("model fixture request log is missing");
  for (const [i, q] of requests.entries()) {
    if (
      !isRecord(q) ||
      typeof q["role"] !== "string" ||
      !Array.isArray(q["nonces"]) ||
      !q["nonces"].every((n) => typeof n === "string") ||
      (q["hasTools"] !== undefined && typeof q["hasTools"] !== "boolean") ||
      (q["label"] !== null && typeof q["label"] !== "string") ||
      (q["cwd"] !== null && typeof q["cwd"] !== "string")
    )
      return unreadable(`model fixture request ${i} is malformed`);
  }
  return { ok: true, value: requests as FixtureRequest[] };
}

export function readModelHits(
  requests: unknown,
  label: TargetId,
  nonce: string,
): Observation<ModelHit[]> {
  const log = readFixtureRequests(requests);
  if (!log.ok) return log;
  return {
    ok: true,
    value: log.value
      .filter(
        (q) =>
          q.role === "target" && q.label === label && q.nonces.includes(nonce),
      )
      .map((q) => ({ cwd: q.cwd })),
  };
}

export type EvidenceSource = {
  sessions(t: TargetId, dir: string): Promise<Observation<V1Session[]>>;
  /** Same read WITHOUT credentials: must come back unreadable (reader control). */
  sessionsUnauthenticated(
    t: TargetId,
    dir: string,
  ): Promise<Observation<V1Session[]>>;
  transcript(
    t: TargetId,
    sid: string,
    dir: string,
  ): Promise<Observation<string>>;
  hits(t: TargetId, nonce: string): Observation<ModelHit[]>;
  requests(): Observation<FixtureRequest[]>;
};

export type RoutingContext = {
  managedRun: boolean;
  /** The managed target's discovery record exists, so it can be read at all. */
  managedReachable: boolean;
  nonces: { alpha: string; beta: string; omega: string };
  dirs: {
    alpha: string;
    beta: string;
    omega: string;
    outside: string;
    ws: string;
    rosterB: string;
  };
  /** Session ids the controller reported dispatching (undefined: not dispatched). */
  sessionIds: { alpha?: string; beta?: string; omega?: string };
};

type Values<R extends Record<string, Observation<unknown>>> = {
  [K in keyof R]: R[K] extends Observation<infer V> ? V : never;
};

const notEstablished = (reasons: string[]) =>
  `NOT ESTABLISHED (evidence unreadable): ${reasons.join("; ")}`;

/**
 * Records one check from named reads. If any read is unreadable the check is
 * `unobserved` and `decide` is never called; otherwise `decide` sees only
 * successfully observed values.
 */
function judge<R extends Record<string, Observation<unknown>>>(
  out: Check[],
  c: { mode: Check["mode"]; kind?: Check["kind"]; name: string },
  reads: R,
  decide: (v: Values<R>) => { ok: boolean; detail?: string },
): void {
  const failed = Object.entries(reads).flatMap(([k, r]) =>
    r.ok ? [] : [`${k}: ${r.reason}`],
  );
  const base = { name: c.name, kind: c.kind ?? "u2", mode: c.mode } as const;
  if (failed.length > 0) {
    out.push({
      ...base,
      ok: false,
      unobserved: true,
      detail: notEstablished(failed),
    });
    return;
  }
  const values = Object.fromEntries(
    Object.entries(reads).map(([k, r]) => [k, (r as { value: unknown }).value]),
  ) as Values<R>;
  const d = decide(values);
  out.push({ ...base, ok: d.ok, ...(d.detail ? { detail: d.detail } : {}) });
}

/**
 * Absence of any session from every listed cell. A session found in an
 * observed cell is a definite finding even if another cell was unreadable;
 * with no finding, ANY unreadable cell leaves the claim not established.
 */
function absentFromCells(
  out: Check[],
  c: { mode: Check["mode"]; name: string },
  cells: Array<{ cell: string; read: Observation<V1Session[]> }>,
): void {
  const found = cells.flatMap((x) =>
    x.read.ok && x.read.value.length > 0
      ? [`${x.cell}=${JSON.stringify(x.read.value.map((s) => s.id))}`]
      : [],
  );
  const unread = cells.flatMap((x) =>
    x.read.ok ? [] : [`${x.cell}: ${x.read.reason}`],
  );
  const observed = cells.filter((x) => x.read.ok).map((x) => x.cell);
  const base = { name: c.name, kind: "u2", mode: c.mode } as const;
  if (found.length > 0) {
    out.push({
      ...base,
      ok: false,
      detail: `sessions found: ${found.join(", ")}${unread.length ? ` (unreadable, not scanned: ${unread.join("; ")})` : ""}`,
    });
  } else if (unread.length > 0) {
    out.push({
      ...base,
      ok: false,
      unobserved: true,
      detail: `${notEstablished(unread)}; empty in observed cells: ${observed.join(", ") || "none"}`,
    });
  } else {
    out.push({
      ...base,
      ok: true,
      detail: `empty in observed cells: ${observed.join(", ")}`,
    });
  }
}

const EXT = "external" as const;
const MGD = "managed" as const;

export async function externalEvidenceChecks(
  src: EvidenceSource,
  ctx: RoutingContext,
): Promise<Check[]> {
  const out: Check[] = [];
  const { alpha: a, beta: b } = ctx.sessionIds;
  const { nonces: N, dirs } = ctx;
  if (a && b) {
    const aSess = await src.sessions("ext", dirs.alpha);
    const bSess = await src.sessions("ext", dirs.beta);
    judge(
      out,
      {
        mode: EXT,
        name: "ext target: session exists in alpha's directory and NOT in beta's",
      },
      { aSess, bSess },
      (v) => ({
        ok:
          v.aSess.some((s) => s.id === a && s.directory === dirs.alpha) &&
          !v.bSess.some((s) => s.id === a),
        detail: JSON.stringify(v.aSess.map((s) => [s.id, s.directory])),
      }),
    );
    judge(
      out,
      {
        mode: EXT,
        name: "ext target: beta session exists in beta's directory and NOT in alpha's",
      },
      { aSess, bSess },
      (v) => ({
        ok:
          v.bSess.some((s) => s.id === b && s.directory === dirs.beta) &&
          !v.aSess.some((s) => s.id === b),
      }),
    );
    const aText = await src.transcript("ext", a, dirs.alpha);
    const bText = await src.transcript("ext", b, dirs.beta);
    judge(
      out,
      {
        mode: EXT,
        name: "ext target: alpha session transcript holds the nonce prompt and ACK reply",
      },
      { aText },
      (v) => ({
        ok:
          v.aText.includes(`Reply with the nonce ${N.alpha}`) &&
          v.aText.includes(`ACK ${N.alpha}`),
      }),
    );
    judge(
      out,
      {
        mode: EXT,
        name: "ext target: alpha's nonce never appears in beta's transcript (and vice versa)",
      },
      { aText, bText },
      (v) => ({
        ok: !v.bText.includes(N.alpha) && !v.aText.includes(N.beta),
      }),
    );
  }
  const alphaHits = src.hits("ext", N.alpha);
  const betaHits = src.hits("ext", N.beta);
  judge(
    out,
    {
      mode: EXT,
      name: "ext target model saw alpha nonce exactly once, with cwd = alpha dir",
    },
    { alphaHits },
    (v) => ({
      ok: v.alphaHits.length === 1 && v.alphaHits[0]?.cwd === dirs.alpha,
      detail: JSON.stringify(v.alphaHits.map((r) => r.cwd)),
    }),
  );
  judge(
    out,
    {
      mode: EXT,
      name: "ext target model saw beta nonce exactly once, with cwd = beta dir",
    },
    { betaHits },
    (v) => ({
      ok: v.betaHits.length === 1 && v.betaHits[0]?.cwd === dirs.beta,
      detail: JSON.stringify(v.betaHits.map((r) => r.cwd)),
    }),
  );
  return out;
}

/** Managed-override evidence. Records nothing when managed mode did not run. */
export async function managedEvidenceChecks(
  src: EvidenceSource,
  ctx: RoutingContext,
): Promise<Check[]> {
  const out: Check[] = [];
  if (!ctx.managedRun) return out;
  const { nonces: N, dirs } = ctx;
  const ambientAlpha = src.hits("mgd", N.alpha);
  const ambientBeta = src.hits("mgd", N.beta);
  judge(
    out,
    { mode: MGD, name: "ambient dispatches did not reach the managed target" },
    { ambientAlpha, ambientBeta },
    (v) => ({ ok: v.ambientAlpha.length === 0 && v.ambientBeta.length === 0 }),
  );
  const om = src.hits("mgd", N.omega);
  judge(
    out,
    {
      mode: MGD,
      name: "managed target model saw omega nonce exactly once, with cwd = omega dir",
    },
    { om },
    (v) => ({
      ok: v.om.length === 1 && v.om[0]?.cwd === dirs.omega,
      detail: JSON.stringify(v.om.map((r) => r.cwd)),
    }),
  );
  const omegaOnExt = src.hits("ext", N.omega);
  judge(
    out,
    { mode: MGD, name: "override dispatch did not reach the external target" },
    { omegaOnExt },
    (v) => ({ ok: v.omegaOnExt.length === 0 }),
  );
  const d3 = ctx.sessionIds.omega;
  if (d3) {
    const sessionNames = [
      "managed target: session exists in omega's directory",
      "managed target: no session in the alpha/beta/outside/workspace directories",
    ];
    if (!ctx.managedReachable) {
      for (const name of sessionNames)
        out.push({
          name,
          kind: "u2",
          mode: MGD,
          ok: false,
          unobserved: true,
          detail: notEstablished([
            "managed target has no discovery record, so it cannot be read",
          ]),
        });
    } else {
      const oSess = await src.sessions("mgd", dirs.omega);
      judge(
        out,
        { mode: MGD, name: sessionNames[0] as string },
        { oSess },
        (v) => ({
          ok: v.oSess.some((s) => s.id === d3 && s.directory === dirs.omega),
        }),
      );
      absentFromCells(
        out,
        { mode: MGD, name: sessionNames[1] as string },
        await Promise.all(
          [dirs.alpha, dirs.beta, dirs.outside, dirs.ws].map(async (d) => ({
            cell: `mgd:${d}`,
            read: await src.sessions("mgd", d),
          })),
        ),
      );
    }
  }
  return out;
}

/**
 * Nonce delivery and stray-session absence for the refused calls. Each claim
 * is about ONE target and is attributed to that target's mode; the
 * wrong-roster scenario exists only in a managed run, so both of its claims
 * are managed. The managed target is neither read nor claimed about unless
 * managed mode ran.
 */
export async function negativeEvidenceChecks(
  src: EvidenceSource,
  ctx: RoutingContext,
  negatives: Array<{ key: string; nonce: string }>,
): Promise<Check[]> {
  const out: Check[] = [];
  for (const n of negatives) {
    const extMode = n.key === "alpha-via-managed-b" ? MGD : EXT;
    const onExt = src.hits("ext", n.nonce);
    judge(
      out,
      {
        mode: extMode,
        name: `negative: ${n.key} nonce never reached the external target's model`,
      },
      { onExt },
      (v) => ({
        ok: v.onExt.length === 0,
        detail: JSON.stringify({ ext: v.onExt.length }),
      }),
    );
    if (ctx.managedRun) {
      const onMgd = src.hits("mgd", n.nonce);
      judge(
        out,
        {
          mode: MGD,
          name: `negative: ${n.key} nonce never reached the managed target's model`,
        },
        { onMgd },
        (v) => ({
          ok: v.onMgd.length === 0,
          detail: JSON.stringify({ mgd: v.onMgd.length }),
        }),
      );
    }
  }
  const stray = [ctx.dirs.outside, ctx.dirs.ws, ctx.dirs.rosterB];
  absentFromCells(
    out,
    {
      mode: EXT,
      name: "negative: no session exists on the external target in any out-of-roster directory",
    },
    await Promise.all(
      stray.map(async (d) => ({
        cell: `ext:${d}`,
        read: await src.sessions("ext", d),
      })),
    ),
  );
  if (ctx.managedRun) {
    absentFromCells(
      out,
      {
        mode: MGD,
        name: "negative: no session exists on the managed target in any out-of-roster directory",
      },
      await Promise.all(
        stray.map(async (d) => ({
          cell: `mgd:${d}`,
          read: await src.sessions("mgd", d),
        })),
      ),
    );
  }
  return out;
}

/**
 * Harness controls for the evidence readers themselves, so a pass cannot come
 * from a reader that swallows failures: the detector sees a delivered nonce
 * and reports 0 for a never-sent one; the session reader sees a known-present
 * session, returns a VALID EMPTY list for an untouched directory, and reports
 * an unauthenticated (refused) read as UNREADABLE rather than empty.
 */
export async function readerControls(
  src: EvidenceSource,
  ctx: RoutingContext,
  opts: { untouchedDir: string },
): Promise<Check[]> {
  const out: Check[] = [];
  const H = { kind: "harness" as const, mode: EXT };
  const presentExt = src.hits("ext", ctx.nonces.alpha);
  const presentMgd = src.hits("mgd", ctx.nonces.alpha);
  judge(
    out,
    {
      ...H,
      name: "control: the nonce detector sees a delivered nonce on exactly its own target",
    },
    { presentExt, presentMgd },
    (v) => ({
      ok: v.presentExt.length === 1 && v.presentMgd.length === 0,
    }),
  );
  const absentExt = src.hits("ext", "U2N-neverSent0000");
  const absentMgd = src.hits("mgd", "U2N-neverSent0000");
  judge(
    out,
    {
      ...H,
      name: "control: the nonce detector reports 0 for a never-sent nonce on both targets",
    },
    { absentExt, absentMgd },
    (v) => ({
      ok: v.absentExt.length === 0 && v.absentMgd.length === 0,
    }),
  );
  const requests = src.requests();
  judge(
    out,
    {
      ...H,
      name: "control: the controller model is a fixture (no other model route was hit)",
    },
    { requests },
    (v) => ({ ok: v.requests.every((r) => r.role !== "unknown") }),
  );
  const alphaId = ctx.sessionIds.alpha;
  if (!alphaId) {
    out.push({
      name: "control: session reader sees a known-present session (alpha's session under alpha's directory)",
      ...H,
      ok: false,
      detail: "no dispatched alpha session id to look for",
    });
    out.push({
      name: "control: asking for alpha's session id under beta's directory finds nothing (directory filter discriminates)",
      ...H,
      ok: false,
      detail: "no dispatched alpha session id to look for",
    });
  } else {
    const known = await src.sessions("ext", ctx.dirs.alpha);
    judge(
      out,
      {
        ...H,
        name: "control: session reader sees a known-present session (alpha's session under alpha's directory)",
      },
      { known },
      (v) => ({ ok: v.known.some((s) => s.id === alphaId) }),
    );
    const wrongDir = await src.sessions("ext", ctx.dirs.beta);
    judge(
      out,
      {
        ...H,
        name: "control: asking for alpha's session id under beta's directory finds nothing (directory filter discriminates)",
      },
      { wrongDir },
      (v) => ({ ok: !v.wrongDir.some((s) => s.id === alphaId) }),
    );
  }
  const empty = await src.sessions("ext", opts.untouchedDir);
  judge(
    out,
    {
      ...H,
      name: "control: session reader returns a valid empty list for an untouched directory",
    },
    { empty },
    (v) => ({ ok: v.empty.length === 0 }),
  );
  const refused = await src.sessionsUnauthenticated("ext", ctx.dirs.alpha);
  out.push({
    name: "control: a refused read is reported unreadable, not as an empty list",
    ...H,
    ok: !refused.ok,
    ...(refused.ok
      ? {
          detail: `unauthenticated read was accepted: ${refused.value.length} sessions`,
        }
      : { detail: refused.reason }),
  });
  if (ctx.managedRun && ctx.sessionIds.omega) {
    const M = { kind: "harness" as const, mode: MGD };
    const omegaId = ctx.sessionIds.omega;
    if (!ctx.managedReachable) {
      out.push({
        name: "control: managed session reader is usable",
        ...M,
        ok: false,
        unobserved: true,
        detail: notEstablished(["managed target has no discovery record"]),
      });
    } else {
      const knownM = await src.sessions("mgd", ctx.dirs.omega);
      judge(
        out,
        {
          ...M,
          name: "control: managed session reader sees a known-present session (omega)",
        },
        { knownM },
        (v) => ({ ok: v.knownM.some((s) => s.id === omegaId) }),
      );
      const emptyM = await src.sessions("mgd", opts.untouchedDir);
      judge(
        out,
        {
          ...M,
          name: "control: managed session reader returns a valid empty list for an untouched directory",
        },
        { emptyM },
        (v) => ({ ok: v.emptyM.length === 0 }),
      );
    }
  }
  return out;
}

type ModeStatus = "PASS" | "FAIL" | "INCOMPLETE";
// A confirmed product failure is `ok:false` WITHOUT `unobserved`; an
// `unobserved` check is `ok:false` because its evidence could not be read, so
// it establishes nothing either way.
const isUnobserved = (c: Check): boolean => !c.ok && c.unobserved === true;
const isFailure = (c: Check): boolean => !c.ok && c.unobserved !== true;

const verdictOf = (cs: Check[]): ModeStatus =>
  cs.some(isFailure)
    ? "FAIL"
    : cs.length === 0 || cs.some(isUnobserved)
      ? "INCOMPLETE"
      : "PASS";

/**
 * Per-mode status and exit code. A confirmed failure makes its mode FAIL even
 * if another check in it was unobserved; with no failure, an `unobserved`
 * check makes the mode INCOMPLETE. Modes are judged independently. Exit: an
 * invalid harness (a failed or unreadable harness check, teardown included) is
 * 1; otherwise any FAIL is 2 (a finding), else any INCOMPLETE is 1, else
 * managed BLOCKED is 3, else 0. Unobserved checks are reported with their
 * reasons and counts, separately from failures.
 */
/**
 * Persists the final summary and decides what the run may claim. A summary
 * that cannot be written leaves nothing on disk that says what happened, so
 * the run is harness-invalid (exit 1) whatever its in-memory verdict was, the
 * owned work directory is retained for inspection, and the headline names the
 * failure and marks the mode statuses as unrecorded instead of printing a bare
 * "external: PASS". Teardown has already run by the time this is called.
 */
export function finalizeOutcome(input: {
  exit: number;
  keep: boolean;
  ownWorkDir: boolean;
  externalStatus: string;
  managedStatus: string;
  writeSummary: () => void;
}): {
  exit: number;
  summaryPersisted: boolean;
  summaryError?: string;
  headline: string;
  removeWorkDir: boolean;
} {
  const { exit, keep, ownWorkDir, externalStatus, managedStatus } = input;
  try {
    input.writeSummary();
  } catch (e) {
    const summaryError = e instanceof Error ? e.message : String(e);
    return {
      exit: 1,
      summaryPersisted: false,
      summaryError,
      headline: `run INVALID: the final summary was not persisted (${summaryError.slice(0, 200)}); in-memory statuses, unrecorded and not established: external ${externalStatus}; managed ${managedStatus}`,
      removeWorkDir: false,
    };
  }
  return {
    exit,
    summaryPersisted: true,
    headline: `external: ${externalStatus}; managed: ${managedStatus}`,
    removeWorkDir: (exit === 0 || exit === 3) && !keep && ownWorkDir,
  };
}

type PreflightResult = { available: boolean; inconclusive?: boolean };

function managedStatusOf(
  preflight: PreflightResult | undefined,
  modeArg: "both" | "external",
  preflightOnly: boolean,
  mgdChecks: Check[],
): string {
  if (!preflight) return "INCOMPLETE";
  if (modeArg === "external") return "NOT-RUN (--mode external)";
  if (!preflight.available)
    return preflight.inconclusive ? "INCONCLUSIVE" : "BLOCKED";
  if (preflightOnly) return "PREFLIGHT-OK (flows not run: --preflight-only)";
  return verdictOf(mgdChecks);
}

function exitCodeOf(
  harnessBad: boolean,
  preflightOnly: boolean,
  externalStatus: string,
  managedStatus: string,
): number {
  if (harnessBad) return 1;
  if (preflightOnly) {
    if (managedStatus === "INCONCLUSIVE") return 1;
    return managedStatus === "BLOCKED" ? 3 : 0;
  }
  if (externalStatus === "FAIL" || managedStatus === "FAIL") return 2;
  if (
    externalStatus === "INCOMPLETE" ||
    managedStatus === "INCOMPLETE" ||
    managedStatus === "INCONCLUSIVE"
  )
    return 1;
  return managedStatus === "BLOCKED" ? 3 : 0;
}

function meaningOf(exit: number, unobserved: number): string {
  switch (exit) {
    case 0:
      return "harness valid; every requested mode passed";
    case 1:
      return "harness invalid or run incomplete (including unreadable evidence or an inconclusive managed preflight); U2 behavior NOT established";
    case 2:
      return `harness valid; a U2 check failed (finding)${unobserved > 0 ? `; ${unobserved} other check(s) were unobserved and are NOT established (see unobservedChecks)` : ""}`;
    default:
      return "harness valid; any mode that ran passed, but managed mode is BLOCKED (not a pass)";
  }
}

export function summarize(input: {
  checks: Check[];
  preflight: PreflightResult | undefined;
  preflightOnly: boolean;
  modeArg: "both" | "external";
}) {
  const { checks, preflight, preflightOnly, modeArg } = input;
  const harnessBad = checks.some((c) => c.kind === "harness" && !c.ok);
  const ext = checks.filter((c) => c.kind === "u2" && c.mode === "external");
  const mgdChecks = checks.filter(
    (c) => c.kind === "u2" && c.mode === "managed",
  );
  const externalStatus = preflightOnly
    ? "NOT-RUN (--preflight-only)"
    : verdictOf(ext);
  const managedStatus = managedStatusOf(
    preflight,
    modeArg,
    preflightOnly,
    mgdChecks,
  );
  return {
    externalStatus,
    managedStatus,
    exit: exitCodeOf(harnessBad, preflightOnly, externalStatus, managedStatus),
    harnessBad,
    ext,
    mgdChecks,
    failed: checks.filter(isFailure).length,
    unobserved: checks.filter(isUnobserved).length,
    unobservedByMode: {
      external: checks.filter((c) => isUnobserved(c) && c.mode === "external")
        .length,
      managed: checks.filter((c) => isUnobserved(c) && c.mode === "managed")
        .length,
    },
    unobservedChecks: checks.filter(isUnobserved).map((c) => ({
      name: c.name,
      mode: c.mode,
      kind: c.kind,
      reason: c.detail ?? "evidence unreadable",
    })),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type ToolStep = {
  tool: string;
  args: Record<string, unknown>;
  status: string | null;
  /** The tool's result text as the controller model received it. */
  text: string;
};
export type Flow = {
  name: string;
  sessionId: string | null;
  outcome: string | null;
  steps: ToolStep[];
  finalText: string | null;
  problems: string[];
  /** Controller-side evidence that could not be read (not a product finding). */
  unreadable: string[];
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const preflightOnly = argv.includes("--preflight-only");
  const modeAt = argv.indexOf("--mode");
  const modeArg = modeAt >= 0 ? argv[modeAt + 1] : "both";
  if (modeArg !== "both" && modeArg !== "external") {
    log("--mode must be `both` (default) or `external`");
    return 1;
  }
  const at = argv.indexOf("--run-id");
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !existsSync("/usr/bin/sandbox-exec")
  ) {
    log("needs macOS arm64 + sandbox-exec; there is no unsandboxed mode");
    return 1;
  }
  const iso = makeIso();
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const runId =
    at >= 0
      ? String(argv[at + 1])
      : `u2-delegation-${stamp}Z-${randomBytes(3).toString("hex")}`;
  const secrets = new Set<string>();
  const evidence = openEvidence(iso, runId, secrets);
  log(`run ${runId} -> .context/u2-delegation/${runId}/`);

  // Run-local request allow-list: ports are added only from ports this
  // harness chose, never from a file or a response.
  const net = createLoopbackHttp();
  const httpJson = net.json;
  const checks: Check[] = [];
  let curMode: Check["mode"] = "external";
  const record = (c: Check) => {
    checks.push(c);
    log(renderCheckLog(c));
  };
  const check = (
    kind: Check["kind"],
    name: string,
    ok: boolean,
    detail?: string,
  ) => {
    record({
      name,
      kind,
      mode: curMode,
      ok,
      ...(detail ? { detail } : {}),
    });
    return ok;
  };

  const procs: Array<{ label: string; port: number; stop: Proc["stop"] }> = [];
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  let exit = 1;
  const teardown: Record<string, unknown> = {};
  let preflight: ReturnType<typeof preflightProcessInspection> | undefined;
  let managedRun = false;
  try {
    const selfTest = await sandboxSelfTest(iso);
    log(renderSelfTestLog(selfTest));
    check(
      "harness",
      "sandbox self-test (read/write home and network denied; control allowed)",
      selfTest.ok,
    );
    if (!selfTest.ok) throw new Error("OS sandbox self-test failed");

    // Managed mode needs the product's native `ps` identity call to work in
    // this sandbox. Probe once, before anything is spawned.
    preflight = preflightProcessInspection(iso);
    managedRun = modeArg === "both" && preflight.available;
    log(renderPreflightLog(preflight));
    evidence.write("preflight.json", projectPreflight(preflight));
    if (preflightOnly) throw new PreflightOnly();

    const built = buildPackage(iso);
    for (const [k, v] of Object.entries(built.shape))
      check("harness", `artifact: ${k}`, v);
    const hosts = installHosts(
      iso,
      built.tarball.file,
      built.tarball.integrity,
    );
    check(
      "harness",
      "controller + target host packages match pinned integrity",
      hosts.identity.controllerPinned && hosts.identity.targetPinned,
    );
    check(
      "harness",
      "controller install has no v1 SDK / v1 host (only the appropriate peer)",
      hosts.identity.controllerHasV1Sdk.length === 0,
      hosts.identity.controllerHasV1Sdk.join(","),
    );
    check(
      "harness",
      "target install has no v2 package",
      hosts.identity.targetHasV2.length === 0,
    );
    check(
      "harness",
      "controller's lockfile integrity for the package equals the packed tarball",
      hosts.identity.tarballLocked,
    );
    check(
      "harness",
      "installed entry is the packed entry",
      hosts.identity.installedEntrySha === built.tarball.distIndexSha256,
    );
    if (checks.some((c) => c.kind === "harness" && !c.ok))
      throw new Error("harness identity checks failed");

    // ---- fixture model ---------------------------------------------------
    fixture = await startFixture();
    const fxUrl = (path: string) => `http://127.0.0.1:${fixture?.port}${path}`;

    // ---- target config (v1) ---------------------------------------------
    const v1Config = (label: string) => ({
      $schema: "https://opencode.ai/config.json",
      model: "fixture/scripted",
      small_model: "fixture/scripted",
      autoupdate: false,
      share: "disabled",
      provider: {
        fixture: {
          npm: "@ai-sdk/openai-compatible",
          name: "Fixture",
          options: {
            baseURL: fxUrl(`/target/${label}/v1`),
            apiKey: "fixture-key",
          },
          models: {
            scripted: {
              name: "Scripted",
              tool_call: true,
              limit: { context: 100000, output: 8000 },
            },
          },
        },
      },
    });

    const ctl = makeCell(iso, "controller");
    const ext = makeCell(iso, "target-ext");
    const mgd = makeCell(iso, "target-mgd");
    const dirs = {
      ws: ctl.p("workspace"),
      alpha: ext.p("projects/alpha"),
      beta: ext.p("projects/beta"),
      omega: mgd.p("projects/omega"),
      outside: join(iso.work, "outside-roster"),
      rosterB: mgd.p("roster"),
    };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    writeFileSync(
      ext.p("config/opencode.json"),
      JSON.stringify(v1Config("ext")),
    );
    writeFileSync(
      mgd.p("config/opencode.json"),
      JSON.stringify(v1Config("mgd")),
    );

    // The controller and the external target share one basic-auth password:
    // the plugin reads OPENCODE_SERVER_PASSWORD from its own (controller)
    // environment for an external roster.
    const pw = `u2-${randomBytes(12).toString("hex")}`;
    secrets.add(pw);

    // ---- external target (v1.17.13) ------------------------------------
    const extHost = await startHost(iso, ext, hosts.targetBin, dirs.alpha, {
      OPENCODE_SERVER_PASSWORD: pw,
    });
    procs.push({ label: "target-ext", port: extHost.port, stop: extHost.stop });
    net.allow(extHost.port);
    const extAuth = { authorization: basic("opencode", pw) };
    const extHealth = await until(
      "external v1 target health",
      120_000,
      async () => {
        const r = await httpJson(
          `http://127.0.0.1:${extHost.port}/global/health`,
          extAuth,
        );
        return r.status === 200 ? (r.body as Json) : undefined;
      },
    );
    check(
      "harness",
      "external target reports v1.17.13",
      extHealth["version"] === TARGET.version,
      String(extHealth["version"]),
    );

    // ---- rosters ----------------------------------------------------------
    const proj = (name: string, path: string) => ({
      name,
      path,
      description: `U2 fixture project ${name}`,
    });
    writeFileSync(
      join(dirs.ws, "spacebus.json"),
      JSON.stringify({
        server: { baseUrl: `http://127.0.0.1:${extHost.port}` },
        projects: [proj("alpha", dirs.alpha), proj("beta", dirs.beta)],
      }),
    );
    // The managed target's port is chosen HERE, written into its roster, and
    // is the only port the managed target is ever requested on. The plugin's
    // discovery file is later verified against it, never trusted for it.
    const managedPort = managedRun ? await freePort() : undefined;
    if (managedPort !== undefined) net.allow(managedPort);
    const managedWrapper = mgd.p("managed-wrapper.sh");
    if (managedRun) {
      // The wrapper stays resident (no exec), so the pid the plugin records is
      // stable across its identity check, and it gives the spawned host ITS OWN
      // private home/config instead of the controller's inherited environment.
      writeFileSync(
        managedWrapper,
        [
          "#!/bin/sh",
          `export HOME='${mgd.p("home")}' TMPDIR='${mgd.p("tmp")}'`,
          `export XDG_CONFIG_HOME='${mgd.p("xdg/config")}' XDG_DATA_HOME='${mgd.p("xdg/data")}'`,
          `export XDG_CACHE_HOME='${mgd.p("xdg/cache")}' XDG_STATE_HOME='${mgd.p("xdg/state")}'`,
          `export OPENCODE_CONFIG_DIR='${mgd.p("config")}'`,
          '"$@" &',
          "child=$!",
          "trap 'kill $child 2>/dev/null' TERM INT",
          "wait $child",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      // Managed roster: the plugin spawns the v1 target itself. `env` is the
      // command so the spawned host gets ITS OWN private home/config; the
      // plugin appends `--port <managedPort>` and sets the per-spawn password.
      writeFileSync(
        join(dirs.rosterB, "spacebus.json"),
        JSON.stringify({
          server: {
            managed: {
              command: [
                managedWrapper,
                hosts.targetBin,
                "serve",
                "--hostname",
                "127.0.0.1",
              ],
              cwd: dirs.rosterB,
              port: managedPort,
            },
          },
          projects: [proj("omega", dirs.omega)],
        }),
      );
      mkdirSync(ctl.p("xdg/config/space-bus"), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        ctl.p("xdg/config/space-bus/rosters.json"),
        JSON.stringify({
          version: 1,
          rosters: [
            { name: "managed-b", path: join(dirs.rosterB, "spacebus.json") },
          ],
        }),
        { mode: 0o600 },
      );
    }

    // ---- v2.3.2 controller ---------------------------------------------
    writeFileSync(
      ctl.p("config/opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "fixture/scripted",
        providers: {
          fixture: {
            name: "Fixture",
            env: ["FIXTURE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: fxUrl("/controller/v1") },
            models: {
              scripted: { name: "Scripted", capabilities: { tools: true } },
            },
          },
        },
      }),
    );
    mkdirSync(join(dirs.ws, ".opencode/plugin"), { recursive: true });
    symlinkSync(
      hosts.pkgDir,
      join(dirs.ws, ".opencode/plugin/space-bus"),
      "dir",
    );
    const ctlHost = await startHost(iso, ctl, hosts.controllerBin, dirs.ws, {
      OPENCODE_SERVER_PASSWORD: pw,
      FIXTURE_API_KEY: "fixture-key",
    });
    procs.push({ label: "controller", port: ctlHost.port, stop: ctlHost.stop });
    net.allow(ctlHost.port);
    const ctlBase = `http://127.0.0.1:${ctlHost.port}`;
    const ctlAuth = {
      authorization: basic("opencode", pw),
      "x-opencode-directory": dirs.ws,
    };
    const info = await until("v2 controller /api/info", 120_000, async () => {
      const r = await httpJson(`${ctlBase}/api/info`, ctlAuth);
      return r.status === 200 ? (r.body as Json) : undefined;
    });
    check(
      "harness",
      "controller reports v2.3.2",
      info["version"] === CONTROLLER.version,
      String(info["version"]),
    );
    const pluginActive = await until(
      "space-bus plugin active in controller",
      120_000,
      async () => {
        const r = await httpJson(`${ctlBase}/api/plugin`, ctlAuth);
        const list = ((r.body as Json)?.["data"] ?? []) as Array<{
          id?: string;
          state?: { status?: string; error?: string };
        }>;
        const e = list.find((x) => x.id === "space-bus");
        return e && e.state?.status !== "loading" ? e : undefined;
      },
    );
    check(
      "harness",
      "controller loaded the packed plugin (host reports it active)",
      pluginActive.state?.status === "active",
      JSON.stringify(pluginActive.state),
    );

    // ---- drive the controller --------------------------------------------
    const driveFlow = async (
      name: string,
      plan: Array<{ tool: string; args: Record<string, unknown> }>,
    ): Promise<Flow> => {
      const flow: Flow = {
        name,
        sessionId: null,
        outcome: null,
        steps: [],
        finalText: null,
        problems: [],
        unreadable: [],
      };
      const mark = fixture?.requests.length ?? 0;
      const created = await httpJson(
        `${ctlBase}/api/session`,
        ctlAuth,
        "POST",
        {
          location: { directory: dirs.ws },
        },
      );
      const sid = ((created.body as Json)?.["data"] as Json | undefined)?.[
        "id"
      ];
      if (!isSafeSessionId(sid)) {
        flow.problems.push(`session create failed (status ${created.status})`);
        return flow;
      }
      flow.sessionId = sid;
      await httpJson(`${ctlBase}/api/session/${sid}/prompt`, ctlAuth, "POST", {
        text: `Run the scripted delegation plan.\n@@PLAN=${JSON.stringify(plan)}`,
      });
      const done = await until(
        `controller session ${name} to finish`,
        240_000,
        async () => {
          const r = await httpJson(`${ctlBase}/api/session/${sid}`, ctlAuth);
          const s = (r.body as Json)?.["data"] as Json | undefined;
          const t = s?.["time"] as Json | undefined;
          return s?.["outcome"] !== undefined && t?.["idle"] !== undefined
            ? s
            : undefined;
        },
      );
      flow.outcome = String(done["outcome"]);
      const msgs = await httpJson(
        `${ctlBase}/api/session/${sid}/message`,
        ctlAuth,
      );
      const read = readControllerMessages(msgs);
      if (!read.ok) flow.unreadable.push(read.reason);
      const data = read.ok ? read.value : [];
      const ordered = [...data].sort(
        (a, b) =>
          Number((a["time"] as Json)?.["created"] ?? 0) -
          Number((b["time"] as Json)?.["created"] ?? 0),
      );
      for (const m of ordered) {
        if (m["type"] !== "assistant") continue;
        for (const part of (m["content"] ?? []) as Array<Json>) {
          if (part["type"] === "tool") {
            const state = (part["state"] ?? {}) as Json;
            const input = (state["input"] ?? {}) as Json;
            const code = String(input["code"] ?? "");
            const call = /tools\.(\w+)\(([\s\S]*)\)/.exec(code);
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(call?.[2] ?? "{}") as Record<string, unknown>;
            } catch {
              /* keep empty */
            }
            flow.steps.push({
              tool: call?.[1] ?? String(part["name"]),
              args,
              status:
                typeof state["status"] === "string" ? state["status"] : null,
              text: Array.isArray(state["content"])
                ? (state["content"] as Array<Json>)
                    .map((c) => String(c["text"] ?? ""))
                    .join("\n")
                : JSON.stringify(state["error"] ?? state["output"] ?? state),
            });
          } else if (part["type"] === "text") {
            flow.finalText = String(part["text"]);
          }
        }
      }
      const requests = readFixtureRequests(fixture?.requests);
      if (!requests.ok) {
        flow.unreadable.push(requests.reason);
      } else {
        const seen = requests.value
          .slice(mark)
          .filter((r) => r.role === "controller" && r.hasTools);
        flow.problems.push(
          ...(seen.length === 0 ? ["controller model was never called"] : []),
        );
      }
      return flow;
    };

    const showFlow = (f: Flow) => {
      check(
        "harness",
        `control: controller evidence for flow ${f.name} was readable`,
        f.unreadable.length === 0,
        f.unreadable.join("; "),
      );
      evidence.write(`flows/${f.name}.json`, projectFlowEvidence(f, known));
      for (const line of renderFlowLog(f, known)) log(line);
    };
    const N = {
      alpha: nonce("alpha"),
      beta: nonce("beta"),
      omega: nonce("omega"),
      badProject: nonce("badproj"),
      wrongRoster: nonce("wrongrost"),
      outside: nonce("outside"),
    };
    // The only values persisted evidence may name verbatim (besides safe ids).
    const known: HarnessKnown = {
      projects: new Set(["alpha", "beta", "omega", "outside-roster"]),
      rosters: new Set(["managed-b"]),
      nonces: new Set(Object.values(N)),
      dirs,
    };
    const ask = (
      project: string,
      n: string,
      extra: Record<string, unknown> = {},
    ) => ({
      tool: "bus_task",
      args: { project, prompt: `Reply with the nonce ${n}.`, ...extra },
    });

    log("flow: ext-ambient");
    const f1 = await driveFlow("ext-ambient", [
      ask("alpha", N.alpha),
      ask("beta", N.beta),
      {
        tool: "bus_wait",
        args: { sessionIds: ["{{sessionId}}"], timeoutMs: 90_000 },
      },
      {
        tool: "bus_wait",
        args: { sessionIds: ["{{sessionId2}}"], timeoutMs: 90_000 },
      },
      { tool: "bus_result", args: { sessionId: "{{sessionId}}" } },
      { tool: "bus_result", args: { sessionId: "{{sessionId2}}" } },
    ]);
    showFlow(f1);
    let f2: Flow | undefined;
    if (managedRun) {
      log("flow: managed-override");
      f2 = await driveFlow("managed-override", [
        ask("omega", N.omega, { roster: "managed-b" }),
        {
          tool: "bus_wait",
          args: {
            sessionIds: ["{{sessionId}}"],
            timeoutMs: 90_000,
            roster: "managed-b",
          },
        },
        {
          tool: "bus_result",
          args: { sessionId: "{{sessionId}}", roster: "managed-b" },
        },
      ]);
      showFlow(f2);
    }
    log("flow: negative");
    const negSteps = [
      {
        key: "omega-via-ambient",
        project: "omega",
        nonce: N.badProject,
        extra: {} as Record<string, unknown>,
      },
      ...(managedRun
        ? [
            {
              key: "alpha-via-managed-b",
              project: "alpha",
              nonce: N.wrongRoster,
              extra: { roster: "managed-b" } as Record<string, unknown>,
            },
          ]
        : []),
      {
        key: "out-of-roster",
        project: "outside-roster",
        nonce: N.outside,
        extra: {} as Record<string, unknown>,
      },
    ];
    const f3 = await driveFlow(
      "negative",
      negSteps.map((n) => ask(n.project, n.nonce, n.extra)),
    );

    showFlow(f3);

    // ---- evidence from both target hosts ---------------------------------
    // Discovery record of the plugin-spawned managed target (private state dir).
    const discoveryFile = (() => {
      const root = ctl.p("xdg/state/space-bus");
      if (!existsSync(root)) return undefined;
      for (const d of readdirSync(root)) {
        const f = join(root, d, "discovery.json");
        if (existsSync(f)) return f;
      }
      return undefined;
    })();
    // The record is a file the plugin wrote, so it is evidence to verify, not
    // a source of the destination: the port must equal the one this harness
    // reserved (`managedPort`, already allowed and written into the roster),
    // and the pid must be a live process that is this run's wrapper + target
    // serving that port. Any mismatch is rejected here, before a request is
    // sent, a credential is used or a signal is queued. Without a reserved
    // port (managed mode not run) the file is not consulted at all.
    const discoveryRead =
      discoveryFile && managedPort !== undefined
        ? verifyManagedDiscovery(readFileSync(discoveryFile, "utf8"), {
            expectedPort: managedPort,
            mustContain: [hosts.targetBin, managedWrapper],
            commandOf: psCommand,
          })
        : undefined;
    const discoveryProblem =
      discoveryRead && !discoveryRead.ok ? discoveryRead.reason : undefined;
    const discovery = discoveryRead?.ok ? discoveryRead.value : undefined;
    if (discovery) secrets.add(discovery.password);
    if (managedRun) {
      curMode = "managed";
      check(
        "u2",
        "plugin spawned a managed v1 target (private discovery record exists)",
        !!discovery,
        discoveryProblem,
      );
      curMode = "external";
    }
    const mgdHostPort = discovery?.port ?? 0;
    if (discovery) {
      procs.push({
        label: "target-mgd (plugin-spawned)",
        port: mgdHostPort,
        stop: () =>
          killChecked(discovery.pid, hosts.targetBin, mgdHostPort, true),
      });
    }
    const targets: Record<
      "ext" | "mgd",
      { base: string; auth: Record<string, string> }
    > = {
      ext: {
        base: `http://127.0.0.1:${extHost.port}`,
        auth: extAuth,
      },
      mgd: {
        base: `http://127.0.0.1:${mgdHostPort}`,
        auth: discovery
          ? { authorization: basic("opencode", discovery.password) }
          : ({} as Record<string, string>),
      },
    };
    const mgdHealth = discovery
      ? await httpJson(`${targets.mgd.base}/global/health`, targets.mgd.auth)
      : undefined;
    if (managedRun) {
      curMode = "managed";
      check(
        "u2",
        "managed target reports v1.17.13",
        (mgdHealth?.body as Json | undefined)?.["version"] === TARGET.version,
        JSON.stringify(mgdHealth?.body ?? null).slice(0, 80),
      );
      curMode = "external";
    }

    // Every read returns an Observation: a failed, timed-out, non-2xx or
    // malformed read (or a missing fixture log) is UNREADABLE, never empty.
    const sessionsPath = (dir: string) =>
      `/session?directory=${encodeURIComponent(dir)}`;
    const evidenceSource: EvidenceSource = {
      sessions: async (t, dir) =>
        readSessionList(
          await httpJson(
            `${targets[t].base}${sessionsPath(dir)}`,
            targets[t].auth,
          ),
          `${t} session list for ${dir}`,
        ),
      sessionsUnauthenticated: async (t, dir) =>
        readSessionList(
          await httpJson(`${targets[t].base}${sessionsPath(dir)}`, {}),
          `${t} session list for ${dir} (no credentials)`,
        ),
      transcript: async (t, sid, dir) =>
        readTranscript(
          await httpJson(
            `${targets[t].base}/session/${sid}/message?directory=${encodeURIComponent(dir)}`,
            targets[t].auth,
          ),
          `${t} transcript ${sid}`,
        ),
      hits: (t, n) => readModelHits(fixture?.requests, t, n),
      requests: () => readFixtureRequests(fixture?.requests),
    };

    // --- ext-ambient: task / wait / result, correct directory ---------------
    const t1 = f1.steps;
    const sidOf = (s?: ToolStep) =>
      /Session (ses_[A-Za-z0-9]+) in (\S+)/.exec(s?.text ?? "");
    const d1 = sidOf(t1[0]);
    const d2 = sidOf(t1[1]);
    check(
      "u2",
      "ext-ambient: controller session succeeded and the model was driven",
      f1.outcome === "succeeded" && f1.problems.length === 0,
      `${f1.outcome} ${f1.problems.join(";")}`,
    );
    check(
      "u2",
      "ext-ambient: bus_task alpha -> `Dispatched. Session ... in alpha` via the real plugin",
      !!d1 && d1[2] === "alpha" && /Dispatched/.test(t1[0]?.text ?? ""),
      t1[0]?.text.slice(0, 200),
    );
    check(
      "u2",
      "ext-ambient: bus_task beta dispatched to beta",
      !!d2 && d2[2] === "beta",
    );
    check(
      "u2",
      "ext-ambient: dispatch header names the ambient roster (path, not a registry name)",
      /roster: [^"]*spacebus\.json/.test(t1[0]?.text ?? ""),
    );
    check(
      "u2",
      "ext-ambient: bus_wait returned each dispatched session as complete (alpha, then beta)",
      !!d1 &&
        !!d2 &&
        (t1[2]?.text ?? "").includes(`${d1[1]} (alpha): complete`) &&
        (t1[3]?.text ?? "").includes(`${d2[1]} (beta): complete`),
      `${t1[2]?.text.slice(0, 200)} // ${t1[3]?.text.slice(0, 200)}`,
    );
    check(
      "u2",
      `ext-ambient: bus_result returns the target's reply (ACK ${N.alpha})`,
      (t1[4]?.text ?? "").includes(`ACK ${N.alpha}`),
      t1[4]?.text.slice(0, 200),
    );
    check(
      "u2",
      `ext-ambient: bus_result for beta returns ACK ${N.beta}`,
      (t1[5]?.text ?? "").includes(`ACK ${N.beta}`),
      t1[5]?.text.slice(0, 200),
    );
    const t2 = f2?.steps ?? [];
    const d3 = managedRun ? sidOf(t2[0]) : null;
    const routing: RoutingContext = {
      managedRun,
      managedReachable: !!discovery,
      nonces: { alpha: N.alpha, beta: N.beta, omega: N.omega },
      dirs,
      sessionIds: {
        ...(d1 ? { alpha: d1[1] as string } : {}),
        ...(d2 ? { beta: d2[1] as string } : {}),
        ...(d3 ? { omega: d3[1] as string } : {}),
      },
    };
    // Reads behind every absence claim below are Observations: an unreadable
    // read leaves its check NOT ESTABLISHED (unobserved), never a pass.
    for (const c of await externalEvidenceChecks(evidenceSource, routing))
      record(c);

    if (managedRun && f2) {
      curMode = "managed";
      // --- managed-override ---------------------------------------------------
      check(
        "u2",
        "managed-override: controller session succeeded",
        f2.outcome === "succeeded" && f2.problems.length === 0,
        `${f2.outcome} ${f2.problems.join(";")}`,
      );
      check(
        "u2",
        "managed-override: explicit `roster: managed-b` beat the ambient roster (dispatched to omega, header names managed-b)",
        !!d3 &&
          d3[2] === "omega" &&
          /roster: managed-b/.test(t2[0]?.text ?? ""),
        t2[0]?.text.slice(0, 200),
      );
      check(
        "u2",
        "managed-override: bus_wait complete",
        (t2[1]?.text.match(/: complete/g) ?? []).length === 1 &&
          /roster: managed-b/.test(t2[1]?.text ?? ""),
        t2[1]?.text.slice(0, 300),
      );
      check(
        "u2",
        `managed-override: bus_result returns ACK ${N.omega}`,
        (t2[2]?.text ?? "").includes(`ACK ${N.omega}`),
        t2[2]?.text.slice(0, 200),
      );
      for (const c of await managedEvidenceChecks(evidenceSource, routing))
        record(c);
      curMode = "external";
    }

    // --- negative: no out-of-roster delivery -----------------------------------
    const t3 = f3.steps;
    check(
      "u2",
      `negative: controller drove all ${negSteps.length} refused calls`,
      f3.outcome === "succeeded" && t3.length === negSteps.length,
      `${f3.outcome} steps=${t3.length}`,
    );
    const refusalWhy: Record<string, string> = {
      "omega-via-ambient":
        "omega via the ambient roster is refused as an unknown project",
      "alpha-via-managed-b":
        "alpha via roster managed-b is refused as an unknown project",
      "out-of-roster": "a project in no roster is refused",
    };
    for (const [i, n] of negSteps.entries()) {
      const text = t3[i]?.text ?? "";
      if (n.key === "alpha-via-managed-b") curMode = "managed";
      check(
        "u2",
        `negative: ${refusalWhy[n.key]}`,
        new RegExp(`unknown project "${n.project}"`).test(text) &&
          !/Dispatched/.test(text),
        text.slice(0, 240),
      );
      curMode = "external";
    }
    for (const c of await negativeEvidenceChecks(
      evidenceSource,
      routing,
      negSteps,
    ))
      record(c);

    // --- detector controls (the checks above can discriminate) -----------------
    for (const c of await readerControls(evidenceSource, routing, {
      untouchedDir: join(iso.work, "never-created-dir"),
    }))
      record(c);
    check(
      "harness",
      'control: every scripted step ran through the plugin (the host never answered "No tool named")',
      [f1, f2, f3].every((f) =>
        (f?.steps ?? []).every((x) => !/No tool named/.test(x.text)),
      ) &&
        f1.steps.length + (f2?.steps.length ?? 0) + f3.steps.length ===
          6 + (managedRun ? 3 : 0) + negSteps.length,
    );

    // ---- persist flows ---------------------------------------------------
    evidence.write(
      "fixture-requests.json",
      projectFixtureRequests(fixture?.requests, known),
    );
    evidence.write("manifest.json", {
      runId,
      // Rebuilt from the parsed, validated options: raw argv is not copied.
      command: [
        "bun run scripts/verify-controller-delegation.ts",
        `--run-id ${runId}`,
        `--mode ${modeArg}`,
        ...(keep ? ["--keep"] : []),
        ...(preflightOnly ? ["--preflight-only"] : []),
      ].join(" "),
      tools: { node: process.version, bun: process.versions["bun"] },
      source: built.provenance,
      package: {
        version: built.tarball.version,
        sha256: built.tarball.sha256,
        integrity: built.tarball.integrity,
        distIndexSha256: built.tarball.distIndexSha256,
        shape: built.shape,
      },
      hosts: {
        controller: {
          package: CONTROLLER.packages,
          version: CONTROLLER.version,
        },
        target: { package: TARGET.packages, version: TARGET.version },
        identity: {
          controllerPinned: hosts.identity.controllerPinned,
          targetPinned: hosts.identity.targetPinned,
          controllerHasV1SdkCount: hosts.identity.controllerHasV1Sdk.length,
          targetHasV2Count: hosts.identity.targetHasV2.length,
          tarballLocked: hosts.identity.tarballLocked,
          installedEntrySha: hosts.identity.installedEntrySha,
          installedPackagePresent: hosts.identity.installedPackagePresent,
        },
      },
      preflight: preflight ? projectPreflight(preflight) : null,
      mode: modeArg,
      managedRun,
      nonces: N,
      roster: {
        ambient:
          "external v1 baseUrl (shared basic-auth password), projects alpha+beta",
        override: managedRun
          ? "registry name managed-b -> managed v1 (plugin-spawned, per-spawn password), project omega"
          : "not configured: managed mode was not run (see preflight)",
      },
    });
  } catch (e) {
    if (!(e instanceof PreflightOnly))
      check(
        "harness",
        `fatal: ${fatalCategory((e as Error).message)}`,
        false,
        (e as Error).message.slice(0, 300),
      );
  } finally {
    for (const p of procs.reverse()) {
      try {
        teardown[p.label] = await p.stop();
      } catch (e) {
        teardown[p.label] = { error: String(e) };
      }
    }
    await fixture?.close();
    // Anything still running from this run's private target install is ours
    // (the path is inside this run's work dir); reap it and count it as a leak.
    const reaped: number[] = [];
    for (const line of spawnSync("/bin/ps", ["-axo", "pid=,command="], {
      env: { PATH: "/bin:/usr/bin" },
    })
      .stdout.toString()
      .split("\n")) {
      const m = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (
        m?.[2]?.includes(`${iso.work}/hosts/target/`) &&
        m[2].includes(" serve ")
      ) {
        await killChecked(Number(m[1]), `${iso.work}/hosts/target/`, 0);
        reaped.push(Number(m[1]));
      }
    }
    teardown["reapedLeakedTargets"] = reaped.length;
    const stray = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
      env: { PATH: "/bin:/usr/bin" },
    })
      .stdout.toString()
      .split("\n")
      .filter((l) => l.includes(iso.work));
    teardown["strayProcessesUnderWorkDir"] = stray.length;
    const tdOk = Object.values(teardown).every((v) =>
      typeof v === "number"
        ? v === 0
        : (v as { stopped?: boolean; portClosed?: boolean }).stopped === true &&
          (v as { portClosed?: boolean }).portClosed === true,
    );
    check(
      "harness",
      "teardown: every host process this run started is gone and its port closed; no stray under the work dir",
      tdOk,
      JSON.stringify(teardown),
    );
  }

  const {
    externalStatus,
    managedStatus,
    exit: summaryExit,
    harnessBad: _harnessBad,
    ext,
    mgdChecks,
    failed,
    unobserved,
    unobservedByMode,
    unobservedChecks,
  } = summarize({ checks, preflight, preflightOnly, modeArg });
  const blockedWhy =
    managedStatus === "BLOCKED" && preflight
      ? `native \`ps\` identity call is denied inside the sandbox (status ${preflight.sandboxed.status}: ${stderrKind(preflight.sandboxed.stderr)}); unsandboxed control status ${preflight.control.status}. The plugin cannot record or verify a managed server's identity here, and no workaround was applied.`
      : undefined;
  const inconclusiveWhy =
    managedStatus === "INCONCLUSIVE" && preflight
      ? `native \`ps\` failed both inside the sandbox (status ${preflight.sandboxed.status}: ${stderrKind(preflight.sandboxed.stderr)}) and unsandboxed (status ${preflight.control.status}: ${stderrKind(preflight.control.stderr)}), so the failure cannot be attributed to the sandbox; managed mode was not run and is neither blocked nor passed.`
      : undefined;
  exit = summaryExit;
  // A write failure's message can carry a path; only its category escapes.
  const writeSummary = () => {
    try {
      writeSummaryFile();
    } catch (e) {
      throw new Error(errorCategory(e));
    }
  };
  const writeSummaryFile = () =>
    evidence.write("summary.json", {
      runId,
      exit,
      modes: {
        external: {
          status: externalStatus,
          checks: ext.length,
          unobserved: unobservedByMode.external,
        },
        managed: {
          status: managedStatus,
          checks: mgdChecks.length,
          unobserved: unobservedByMode.managed,
          ...(blockedWhy ? { blocker: blockedWhy } : {}),
          ...(inconclusiveWhy ? { inconclusive: inconclusiveWhy } : {}),
        },
      },
      meaning: meaningOf(exit, unobserved),
      counts: {
        harness: checks.filter((c) => c.kind === "harness").length,
        u2: checks.filter((c) => c.kind === "u2").length,
        failed,
        unobserved,
      },
      unobservedChecks: unobservedChecks.map((u) => ({
        name: String(u.name).slice(0, 200),
        mode: u.mode,
        kind: u.kind,
        reasons: recognizedReasons(u.reason),
      })),
      teardown: projectTeardown(teardown),
      checks: checks.map(projectCheckEvidence),
      limitations: [
        "macOS arm64 only",
        "the model is a deterministic fixture: this proves plugin->host wiring, routing and result plumbing, not agent behavior",
        "v2.3.2 exposes plugin tools only through Code Mode `execute`; the fixture drives them that way",
        "blocked-question flows, steering and follow-ups are not exercised here",
        "persisted evidence is categorical: raw prompts, tool arguments, tool results, transcripts and response bodies are not retained; correlation is by harness nonces, `ses_` ids and 16-hex SHA-256 digests",
        "nothing brokers or relaxes a sandbox denial: a denied native operation blocks the mode that needs it",
        "an absence claim is made only from reads that succeeded: a failed, timed-out, non-2xx or malformed session/transcript read, or a missing fixture log, leaves the check unobserved and its mode INCOMPLETE (exit 1); it is never an empty result",
        "the session-reader controls (known-present, valid-empty, refused-read-is-unreadable) are written but were not exercised against live hosts in this change",
      ],
    });
  const own =
    basename(iso.work).startsWith("space-bus-host-matrix-") &&
    dirname(iso.work) === realpathSync(tmpdir()) &&
    existsSync(join(iso.work, WORK_MARKER));
  const outcome = finalizeOutcome({
    exit,
    keep,
    ownWorkDir: own,
    externalStatus,
    managedStatus,
    writeSummary,
  });
  exit = outcome.exit;
  if (!outcome.summaryPersisted)
    log(`could not persist summary: ${outcome.summaryError}`);
  log(outcome.headline);
  log(`exit ${exit}`);
  if (outcome.removeWorkDir) rmSync(iso.work, { recursive: true, force: true });
  else log(`work dir kept: ${basename(iso.work)}`);
  return exit;
}

async function startFixture() {
  const mod = (await import(
    join(repoRoot, "test/fixtures/dual-host/delegation/model-fixture.mjs")
  )) as {
    startModelFixture: (port?: number) => Promise<{
      port: number;
      requests: Array<{
        role: string;
        label: string | null;
        hasTools: boolean;
        nonces: string[];
        cwd: string | null;
        decision: Json;
      }>;
      close: () => Promise<void>;
    }>;
  };
  return mod.startModelFixture();
}

if (import.meta.main)
  process.exit(
    await main().catch((e) => {
      log(`unhandled: ${errorCategory(e)}`);
      return 1;
    }),
  );
