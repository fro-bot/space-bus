#!/usr/bin/env bun
/**
 * U1 loader characterization: do the REAL OpenCode v1 (1.17.13, 1.19.6) and v2
 * (2.3.2) loaders load one packed minimal dual-entry candidate of
 * @fro.bot/space-bus, expose the six bus_* tools with schemas identical to the
 * baseline's (names, required/optional, types, descriptions, nested/array/enum
 * constraints), and behave the same for a single and a duplicated reference?
 *
 *   bun run scripts/verify-host-matrix.ts [--run-id <id>] [--keep]
 *
 * Per host (3 cells each, one candidate tarball for all of them):
 *   single     one reference to the package
 *   duplicate  the same package referenced twice
 *   mutated    single + one required argument flipped to optional (U1_MUTATE_
 *              REQUIRED) -- the comparator MUST report exactly that difference
 * Every cell also counts module / server() / setup() / transform-evaluation
 * events (U1_LIFECYCLE_FILE) so "six unique names" cannot hide a double run.
 *
 * Isolation (mandatory, no override): macOS sandbox-exec denies read+write of
 * the real home and invoking $HOME, denies ALL writes except to this run's
 * work dir (and null/tty devices), and denies non-loopback network; a
 * self-test with canaries outside the work dir (in /private/tmp and
 * /private/var/tmp), DNS-name and raw-IP egress probes, and positive controls
 * outside the sandbox proves each denial and refuses to start any host
 * otherwise. This applies to HOST EXECUTION only: the build, pack and npm
 * install steps run unsandboxed, with network access, before any host starts. Each cell has its own env -i, HOME,
 * XDG_*, TMPDIR and OPENCODE_CONFIG_DIR; no credentials, no model/provider
 * call. Only the child this script spawned is ever signalled, after its
 * command line is checked. Cleanup removes only this run's marker-checked work
 * dir, and only on a clean exit.
 *
 * Evidence: .context/u1-loader/<run-id>/ (git-ignored, created fresh, each
 * file written atomically and scrubbed of paths and per-cell secrets).
 *
 * Exit: 0 every host PASS; 1 harness/control invalid or a cell BLOCKED;
 * 2 harness valid but a host FAILed fidelity or duplicate handling.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer, Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDir = join(repoRoot, "test/fixtures/dual-host/loader");
const FIXTURES = [
  "candidate-entry.mjs",
  "extract-schemas.mjs",
  "observer-v2.js",
];
/** The inspected tracked tree the plan characterizes (main 118385f). */
const BASELINE = "118385f168cef0a2e8a9169a5683da329a8c469b";
const PACKAGE = "@fro.bot/space-bus";
const PLUGIN_ID = "space-bus";
const BUS_TOOLS = [
  "bus_registry",
  "bus_result",
  "bus_roster",
  "bus_status",
  "bus_task",
  "bus_wait",
];
/** Registry sha512 integrity of every host package tested (darwin-arm64). */
const PINS: Record<string, string> = {
  "opencode-ai@1.17.13":
    "sha512-qUb9m6X6f9/imuDxc2tUcN+E1vx1XWjmQWJo2Pk/t+cNxqt5KGkaMF89CvJK6QQP7gx1E82gKpV7n1QiI5spxQ==",
  "opencode-darwin-arm64@1.17.13":
    "sha512-JSIDA4DUMzg2rOyUvnb4YnI4FDvPuI4Hjmlg+OoAcUCZJUGLFabPZLDfMNzEmzmRa3LWR00GFcgxVctXQ25xzg==",
  "@opencode-ai/plugin@1.17.13":
    "sha512-JjoIs6qTPl0IrXo+J1GTqX9lcb2h2dMoW6BWMR2IbTT3MY2FQ/lvBXDzkx0d3zVRaYN+NTmV4u8Nth396xq+sQ==",
  "opencode-ai@1.19.6":
    "sha512-x0yTvlq3Cyhp3z1IhsNlktLa9M/FSbpMWiDlcGljKMTlBKdHM/um/03JedJa71N2yNlHkOvOPI0H4tbyXuuGwA==",
  "opencode-darwin-arm64@1.19.6":
    "sha512-GZjEsOTlr/e8fUF+lsFtTJGNIyHfUZcN9+iN6uXAbsH6t1PJABZrWE+5Lu2raX7g/EUXXCCB9NJ9L0AyMcWkKA==",
  "@opencode-ai/plugin@1.19.6":
    "sha512-eq1+T75FdIwPTiB8WQLV3Kii0TDAqHsC0baQtbpPS5bzgSc2UhGouy10FxedwKXbC/Prm2FgDhoARwwKDd3yhw==",
  "@opencode/cli@2.3.2":
    "sha512-U/DD6X8kgnEFM3VYT7+QN/UJotW++qOxTJtPEUiNzKwu9tNHtAC1jOtup1gpk773j0AFNmMBbLNou4YkdvlRKA==",
  "@opencode/cli-darwin-arm64@2.3.2":
    "sha512-cYrIzW8CvYc52INFA/cXmw7U2mk+JNWaV+olH7AflYqa/5srSrA/hbLwF7G1N4QTRMtOFrmeTM0LVN81q396sg==",
};

type Host = {
  id: string;
  v2: boolean;
  version: string;
  /** host package, its darwin-arm64 binary package, and (v1) the SDK peer */
  packages: string[];
};
const HOSTS: Host[] = [
  {
    id: "v1-floor",
    v2: false,
    version: "1.17.13",
    packages: ["opencode-ai", "opencode-darwin-arm64", "@opencode-ai/plugin"],
  },
  {
    id: "v1-current",
    v2: false,
    version: "1.19.6",
    packages: ["opencode-ai", "opencode-darwin-arm64", "@opencode-ai/plugin"],
  },
  {
    id: "v2-pilot",
    v2: true,
    version: "2.3.2",
    packages: ["@opencode/cli", "@opencode/cli-darwin-arm64"],
  },
];
type Kind = "single" | "duplicate" | "mutated";
const MUTATION = { tool: "bus_task", arg: "prompt" };

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const log = (m: string) => console.error(`[host-matrix] ${m}`);
const fileSha = (rel: string) => sha256(readFileSync(join(repoRoot, rel)));
const sha256 = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const BASE_PATH = "/usr/bin:/bin";

function sh(
  label: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: Record<string, string> },
): string {
  const r = spawnSync(cmd, args, {
    ...opts,
    maxBuffer: 64 << 20,
    timeout: 600_000,
  });
  if (r.status !== 0) {
    throw new Error(
      `${label} failed (exit ${r.status}): ${`${r.stdout}\n${r.stderr}`.slice(-1200)}`,
    );
  }
  return r.stdout.toString();
}

/**
 * Every port this harness has reserved. `portOpen` connects only to these, so
 * a port that arrives from anywhere else (a record a spawned host wrote, for
 * example) can never become a connect destination here, whatever a caller
 * forgot to check.
 */
const reservedPorts = new Set<number>();

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        reservedPorts.add(port);
        ok(port);
      });
    });
  });
}

/**
 * Is something listening on 127.0.0.1:`port`? The host is fixed and the port
 * must be one `freePort()` reserved in this process; anything else rejects
 * before a socket is opened (fail closed, not "closed").
 */
function portOpen(port: number): Promise<boolean> {
  if (!reservedPorts.has(port))
    return Promise.reject(
      new Error("portOpen: port was not reserved by this harness"),
    );
  return new Promise((ok) => {
    const s = new Socket();
    s.setTimeout(1000);
    s.once("connect", () => (s.destroy(), ok(true)));
    s.once("error", () => ok(false));
    s.once("timeout", () => (s.destroy(), ok(false)));
    s.connect(port, "127.0.0.1");
  });
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    return { ok: r.ok, body: (await r.json().catch(() => null)) as unknown };
  } catch {
    return { ok: false, body: null as unknown };
  }
}

async function waitFor<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(1000)) {
    const v = await probe();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function pool<T>(
  items: T[],
  size: number,
  work: (i: T) => Promise<void>,
) {
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) await work(items[next++] as T);
    }),
  );
}

// ---------------------------------------------------------------------------
// Isolation: sandbox profile + mandatory self-test
// ---------------------------------------------------------------------------

type Iso = { work: string; node: string; realHome: string; profile: string };
const WORK_MARKER = ".space-bus-host-matrix-work";

function makeIso(): Iso {
  const node = realpathSync(Bun.which("node") ?? "");
  const realHome = sh(
    "real home",
    node,
    ["-p", "require('node:os').userInfo().homedir"],
    { env: {} },
  ).trim();
  const work = realpathSync(
    mkdtempSync(join(tmpdir(), "space-bus-host-matrix-")),
  );
  writeFileSync(join(work, WORK_MARKER), "");
  for (const d of ["tmp", "cells", "artifacts"]) mkdirSync(join(work, d));
  for (const f of ["npmrc-user", "npmrc-global"])
    writeFileSync(join(work, f), "");
  const homes = [...new Set([realHome, process.env["HOME"] ?? ""])].filter(
    Boolean,
  );
  const sub = (ps: string[]) =>
    ps.map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
  const profile = join(work, "sandbox.sb");
  writeFileSync(
    profile,
    [
      "(version 1)",
      "(allow default)",
      // writes: denied everywhere, then re-allowed ONLY in this run's work dir
      // and the standard null/tty devices (so a host cannot write to /tmp,
      // /private/var/tmp, the real home or anywhere else).
      "(deny file-write*)",
      `(allow file-write* ${sub([work])} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/(fd/[0-9]+|ttys[0-9]+)$"))`,
      // home: no reads at all (writes are already denied above).
      `(deny file-read-data ${sub(homes)})`,
      `(allow file-read-data ${sub([work, dirname(dirname(node))])})`,
      // network: loopback and unix sockets only.
      "(deny network*)",
      '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
      '(allow network-bind (local ip "localhost:*"))',
      '(allow network-inbound (local ip "localhost:*"))',
      "",
    ].join("\n"),
  );
  return { work, node, realHome, profile };
}

const inSandbox = (iso: Iso, cmd: string, args: string[]) => ({
  cmd: "/usr/bin/sandbox-exec",
  args: ["-f", iso.profile, cmd, ...args],
});

// One probe, run inside the sandbox and again outside it as a positive
// control, so every denial is attributable to the sandbox. The loopback target
// is a server this process starts. Canaries are exact-name entries in two
// private directories this self-test creates (and always removes) outside the
// work dir; the control never touches the real home.
const PROBE = `
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
const cfg = JSON.parse(process.argv[2]);
const t = (fn) => { try { fn(); return "allowed"; } catch (e) { return "denied:" + (e.code ?? "err"); } };
const out = {};
out.readHome = t(() => readdirSync(cfg.home));
out.writeHome = cfg.control ? "skipped (control never touches the real home)" : t(() => { writeFileSync(join(cfg.home, cfg.name), "x", { flag: "wx" }); unlinkSync(join(cfg.home, cfg.name)); });
out.writeOutside1 = t(() => writeFileSync(join(cfg.out1, cfg.name), "x", { flag: "wx" }));
out.writeOutside2 = t(() => writeFileSync(join(cfg.out2, cfg.name), "x", { flag: "wx" }));
out.mkdirOutside = t(() => mkdirSync(join(cfg.out1, cfg.name + "-d")));
out.writeWork = t(() => writeFileSync(join(cfg.work, cfg.name), "x", { flag: "wx" }));
out.loopback = await fetch(cfg.loopback).then((r) => "allowed:" + r.status).catch(() => "denied");
out.external = await fetch("https://registry.npmjs.org/", { method: "HEAD", signal: AbortSignal.timeout(8000) }).then(() => "allowed").catch(() => "denied");
out.externalIp = await new Promise((res) => { const s = net.connect({ host: "1.1.1.1", port: 443, timeout: 4000 }); s.once("connect", () => { s.destroy(); res("allowed"); }); s.once("error", () => res("denied")); s.once("timeout", () => { s.destroy(); res("denied"); }); });
console.log(JSON.stringify(out));
`;

type SelfTest = {
  sandboxed: Json;
  control: Json;
  leaked: { out1: number; out2: number; homeCanary: boolean };
  checks: Record<string, boolean>;
  ok: boolean;
};

/**
 * Mandatory before any host starts. Async because the loopback probe talks to
 * a server in this process. Bounded: each probe child is killed after 60s, and
 * the two canary directories are removed in `finally` whatever happens.
 */
async function sandboxSelfTest(iso: Iso): Promise<SelfTest> {
  const dir = join(iso.work, "selftest");
  mkdirSync(dir, { recursive: true });
  const script = join(dir, "probe.mjs");
  writeFileSync(script, PROBE);
  const suffix = randomBytes(5).toString("hex");
  const out1 = `/private/tmp/hm-selftest-${suffix}`;
  const out2 = `/private/var/tmp/hm-selftest-${suffix}`;
  const name = `.hm-canary-${suffix}`;
  const server = createHttpServer((_req, res) => res.end("ok"));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const loopback = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const cfg = {
    home: iso.realHome,
    name,
    out1,
    out2,
    work: dir,
    loopback,
  };
  const run = (wrap: boolean) =>
    new Promise<Json>((done) => {
      const args = [script, JSON.stringify({ ...cfg, control: !wrap })];
      const c = wrap ? inSandbox(iso, iso.node, args) : { cmd: iso.node, args };
      const child = spawn(c.cmd, c.args, {
        cwd: dir,
        env: { PATH: BASE_PATH },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          done(JSON.parse(stdout.trim().split("\n").pop() ?? "") as Json);
        } catch {
          done({ error: `no output (exit ${code}) ${stderr.slice(0, 200)}` });
        }
      });
    });
  try {
    mkdirSync(out1, { mode: 0o700 });
    mkdirSync(out2, { mode: 0o700 });
    const sandboxed = await run(true);
    // Filesystem truth, independent of what the probe reported:
    const leaked = {
      out1: readdirSync(out1).length,
      out2: readdirSync(out2).length,
      homeCanary: existsSync(join(iso.realHome, name)),
    };
    if (leaked.homeCanary) rmSync(join(iso.realHome, name), { force: true });
    const control = await run(false);
    const controlWrote = {
      out1: readdirSync(out1).includes(name),
      out2: readdirSync(out2).includes(name),
    };
    const denied = (v: unknown) => String(v).startsWith("denied");
    const checks = {
      readHomeDenied: denied(sandboxed["readHome"]),
      writeHomeDenied: denied(sandboxed["writeHome"]),
      writeOutsideTmpDenied: denied(sandboxed["writeOutside1"]),
      writeOutsideVarTmpDenied: denied(sandboxed["writeOutside2"]),
      mkdirOutsideDenied: denied(sandboxed["mkdirOutside"]),
      noCanaryLandedOutsideWork:
        leaked.out1 === 0 && leaked.out2 === 0 && !leaked.homeCanary,
      writeWorkAllowed: sandboxed["writeWork"] === "allowed",
      loopbackAllowed: String(sandboxed["loopback"]).startsWith("allowed"),
      externalDnsNameDenied: sandboxed["external"] === "denied",
      externalIpDenied: sandboxed["externalIp"] === "denied",
      controlCanWriteOutside:
        control["writeOutside1"] === "allowed" &&
        control["writeOutside2"] === "allowed" &&
        controlWrote.out1 &&
        controlWrote.out2,
      controlCanReadHome: control["readHome"] === "allowed",
      controlLoopback: String(control["loopback"]).startsWith("allowed"),
      controlExternalAllowed: control["external"] === "allowed",
    };
    return {
      sandboxed,
      control,
      leaked,
      checks,
      ok: Object.values(checks).every(Boolean),
    };
  } finally {
    for (const d of [out1, out2]) rmSync(d, { recursive: true, force: true });
    await new Promise<void>((done) => server.close(() => done()));
  }
}

// ---------------------------------------------------------------------------
// Build: baseline from the pinned commit, then one candidate tarball
// ---------------------------------------------------------------------------

type Tarball = {
  file: string;
  version: string;
  sha256: string;
  integrity: string;
  distIndexSha256: string;
};

function identify(file: string): Tarball {
  const env = { PATH: BASE_PATH };
  const entry = (name: string) =>
    spawnSync("tar", ["-xzOf", file, `package/${name}`], {
      env,
      maxBuffer: 64 << 20,
    }).stdout;
  const bytes = readFileSync(file);
  return {
    file,
    version: (
      JSON.parse(entry("package.json").toString()) as { version: string }
    ).version,
    sha256: sha256(bytes),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    distIndexSha256: sha256(entry("dist/index.js")),
  };
}

type RefSpecs = Record<string, { description: string; input: Json }>;

function build(iso: Iso) {
  const gitEnv = { PATH: `${BASE_PATH}:/opt/homebrew/bin` };
  const git = (...a: string[]) =>
    sh(`git ${a[0]}`, "git", a, { cwd: repoRoot, env: gitEnv }).trim();
  const commit = git("rev-parse", "--verify", `${BASELINE}^{commit}`);
  const src = join(iso.work, "baseline-src");
  const home = join(iso.work, "build-home");
  mkdirSync(src);
  mkdirSync(home);
  git("archive", "-o", join(iso.work, "baseline.tar"), commit);
  sh("tar", "tar", ["-xf", join(iso.work, "baseline.tar"), "-C", src], {
    env: { PATH: BASE_PATH },
  });
  const env = {
    PATH: `${dirname(process.execPath)}:${dirname(iso.node)}:${BASE_PATH}`,
    HOME: home,
    BUN_INSTALL_CACHE_DIR: join(iso.work, "bun-cache"),
    NPM_CONFIG_USERCONFIG: join(iso.work, "npmrc-user"),
    NPM_CONFIG_GLOBALCONFIG: join(iso.work, "npmrc-global"),
    NPM_CONFIG_CACHE: join(iso.work, "npm-cache"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
  log("baseline: install, build, pack");
  sh("bun install", process.execPath, ["install", "--frozen-lockfile"], {
    cwd: src,
    env,
  });
  sh("bun build", process.execPath, ["run", "build"], { cwd: src, env });
  const packed = (cwd: string, dest: string) =>
    join(
      dest,
      sh(
        "npm pack",
        "npm",
        ["pack", "--ignore-scripts", "--silent", "--pack-destination", dest],
        { cwd, env },
      )
        .trim()
        .split("\n")
        .pop() ?? "",
    );
  const baseline = identify(packed(src, iso.work));

  // Reference: the baseline's own zod args -> JSON Schema, converted with the
  // zod copy bundled in @opencode-ai/plugin (the top-level zod drops every
  // .describe() text), so descriptions are part of the comparison.
  cpSync(
    join(fixtureDir, "extract-schemas.mjs"),
    join(src, "extract-schemas.mjs"),
  );
  const schemasText = sh(
    "extract schemas",
    process.execPath,
    ["extract-schemas.mjs", join(src, "dist/index.js")],
    { cwd: src, env },
  );
  const ref = JSON.parse(schemasText) as RefSpecs;
  if (Object.keys(ref).sort().join() !== BUS_TOOLS.join())
    throw new Error("baseline does not expose exactly the six bus_* tools");
  if (coverage(ref).descriptions === 0)
    throw new Error("reference carries no descriptions");
  if (
    !(
      (ref[MUTATION.tool]?.input["required"] as string[] | undefined) ?? []
    ).includes(MUTATION.arg)
  ) {
    throw new Error(
      "control premise broken: mutated argument is not required in the baseline",
    );
  }

  // Candidate: baseline package with the fixture entry on top of its bundle.
  const root = join(iso.work, "artifacts", "candidate");
  mkdirSync(root, { recursive: true });
  sh("untar baseline", "tar", ["-xzf", baseline.file, "-C", root], {
    env: { PATH: BASE_PATH },
  });
  const pkg = join(root, "package");
  cpSync(join(pkg, "dist/index.js"), join(pkg, "dist/index-v1.js"));
  cpSync(join(fixtureDir, "candidate-entry.mjs"), join(pkg, "dist/index.js"));
  writeFileSync(join(pkg, "dist/candidate-schemas.json"), schemasText);
  const manifest = JSON.parse(
    readFileSync(join(pkg, "package.json"), "utf8"),
  ) as Json;
  manifest["version"] = `${String(manifest["version"])}-u1.candidate`;
  // The SDK peer is the v1 host's business; the entry loads it lazily.
  manifest["peerDependenciesMeta"] = {
    "@opencode-ai/plugin": { optional: true },
  };
  writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest, null, 2));
  const candidate = identify(packed(pkg, root));
  return {
    ref,
    candidate,
    baseline,
    provenance: { commit, tree: git("rev-parse", `${commit}^{tree}`) },
  };
}

// ---------------------------------------------------------------------------
// Schema comparison
// ---------------------------------------------------------------------------

type Tool = { id: string; description: string | null; input: unknown };

/** Sorted-key copy; "$schema" is the only key dropped (declared in the manifest). */
function canon(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(canon);
  if (!isObj(node)) return node;
  return Object.fromEntries(
    Object.keys(node)
      .sort()
      .filter((k) => k !== "$schema")
      .map((k) => [k, canon(node[k])]),
  );
}

const show = (v: unknown) => (JSON.stringify(v) ?? "undefined").slice(0, 80);

function diff(a: unknown, b: unknown, path: string, out: string[]): void {
  if (out.length >= 40) return;
  if (isObj(a) && isObj(b)) {
    for (const k of [
      ...new Set([...Object.keys(a), ...Object.keys(b)]),
    ].sort()) {
      const at = `${path}/${k}`;
      if (k === "required" && (Array.isArray(a[k]) || Array.isArray(b[k]))) {
        // a set; an absent key is the empty set
        const ra = (a[k] as string[] | undefined) ?? [];
        const rb = (b[k] as string[] | undefined) ?? [];
        const onlyRef = ra.filter((x) => !rb.includes(x));
        const onlyHost = rb.filter((x) => !ra.includes(x));
        if (onlyRef.length + onlyHost.length > 0) {
          out.push(`${at}: ref-only=[${onlyRef}] host-only=[${onlyHost}]`);
        }
      } else if (!(k in a)) out.push(`${at}: host-only ${show(b[k])}`);
      else if (!(k in b)) out.push(`${at}: ref-only ${show(a[k])}`);
      else diff(a[k], b[k], at, out);
    }
  } else if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length)
      out.push(`${path}: length ref=${a.length} host=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++)
      diff(a[i], b[i], `${path}[${i}]`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.push(`${path}: ref=${show(a)} host=${show(b)}`);
  }
}

const dupesOf = (ids: string[]) => [
  ...new Set(ids.filter((id, i) => ids.indexOf(id) !== i)),
];

function compare(ref: RefSpecs, ids: string[], tools: Tool[]) {
  const diffs: string[] = [];
  const present = [...new Set([...ids, ...tools.map((t) => t.id)])];
  for (const [name, want] of Object.entries(ref)) {
    const got = tools.find((t) => t.id === name);
    if (!got) {
      diffs.push(`${name}: not exposed with a schema`);
      continue;
    }
    if (got.description !== want.description) {
      diffs.push(
        `${name}/description: ref=${show(want.description)} host=${show(got.description)}`,
      );
    }
    diff(canon(want.input), canon(got.input), `${name}/input`, diffs);
  }
  return {
    diffs,
    duplicates: [
      ...new Set([...dupesOf(ids), ...dupesOf(tools.map((t) => t.id))]),
    ].sort(),
    missing: BUS_TOOLS.filter((n) => !present.includes(n)),
    unexpected: present.filter((n) => !(n in ref)).sort(),
  };
}

/** Coverage of the reference, so a vacuous comparison is visible. */
const coverage = (ref: RefSpecs) => {
  const text = JSON.stringify(Object.values(ref).map((s) => s.input));
  const count = (key: string) => text.split(`"${key}":`).length - 1;
  return {
    typeNodes: count("type"),
    requiredLists: count("required"),
    descriptions: count("description"),
    enums: count("enum"),
    arrayBounds: count("maxItems") + count("minItems"),
    numericBounds: count("exclusiveMinimum") + count("minimum"),
  };
};

// In-memory detector controls, run against each host's REAL single exposure:
// the comparator must notice each deliberate change. (The mutated cell is the
// end-to-end version of the first one.) [name, expected diff path, path from
// the tool object, key, new value]
const MUTATIONS: Array<
  [string, string, string[], string, (v: unknown) => unknown]
> = [
  [
    "required bit removed",
    "bus_task/input/required",
    ["bus_task", "input"],
    "required",
    (v) => (v as string[]).filter((n) => n !== "prompt"),
  ],
  [
    "property description changed",
    "prompt/description",
    ["bus_task", "input", "properties", "prompt"],
    "description",
    (v) => `${v}!`,
  ],
  [
    "tool description changed",
    "bus_roster/description",
    ["bus_roster"],
    "description",
    (v) => `${v}!`,
  ],
  [
    "enum member removed",
    "action/enum",
    ["bus_registry", "input", "properties", "action"],
    "enum",
    (v) => (v as unknown[]).slice(0, -1),
  ],
  [
    "array bound changed",
    "sessionIds/maxItems",
    ["bus_wait", "input", "properties", "sessionIds"],
    "maxItems",
    (v) => Number(v) + 1,
  ],
];

function detectorControls(ref: RefSpecs, ids: string[], tools: Tool[]) {
  const results: Array<{ name: string; detected: boolean }> = [];
  for (const [name, expect, path, key, change] of MUTATIONS) {
    const copy = structuredClone(tools);
    let detected = false;
    try {
      let cur: unknown = copy.find((t) => t.id === path[0]);
      for (const k of path.slice(1)) cur = isObj(cur) ? cur[k] : undefined;
      if (!isObj(cur)) throw new Error("absent");
      cur[key] = change(cur[key]);
      detected = compare(ref, ids, copy).diffs.some((d) => d.includes(expect));
    } catch {
      /* an inapplicable shape counts as not detected */
    }
    results.push({ name, detected });
  }
  const clean = compare(ref, ids, tools);
  const withDuplicate = compare(ref, [...ids, ids[0] ?? "bus_task"], tools);
  results.push({
    name: "duplicate id in listing",
    detected:
      clean.duplicates.length === 0 && withDuplicate.duplicates.length === 1,
  });
  return { clean: clean.diffs.length === 0, results };
}

// ---------------------------------------------------------------------------
// Lifecycle counters (candidate-entry.mjs, U1_LIFECYCLE_FILE)
// ---------------------------------------------------------------------------

/** module = entry evaluated; server/setup = host ran the hook; transformEval =
 * replayable v2 transform callback ran. Distinct on purpose. */
function counters(text: string) {
  const c: Record<string, number> = {};
  for (const line of text.split("\n").slice(0, 2000)) {
    try {
      const ev = (JSON.parse(line) as { ev: string }).ev;
      c[ev] = (c[ev] ?? 0) + 1;
    } catch {
      /* torn last line */
    }
  }
  return {
    module: c["module"] ?? 0,
    server: c["server"] ?? 0,
    setup: c["setup"] ?? 0,
    transformEval: c["transform-eval"] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Durable, scrubbed, atomic evidence
// ---------------------------------------------------------------------------

type Durable = {
  dir: string;
  secrets: Set<string>;
  write: (rel: string, v: unknown) => void;
};

function openDurable(iso: Iso, runId: string): Durable {
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(runId))
    throw new Error("invalid --run-id");
  const parent = join(repoRoot, ".context/u1-loader");
  mkdirSync(parent, { recursive: true });
  const ignored = spawnSync(
    "git",
    ["check-ignore", "-q", "--", `.context/u1-loader/${runId}/x`],
    {
      cwd: repoRoot,
      env: { PATH: `${BASE_PATH}:/opt/homebrew/bin` },
    },
  );
  if (ignored.status !== 0)
    throw new Error(".context/u1-loader is not git-ignored");
  mkdirSync(join(parent, runId), { mode: 0o700 }); // throws if the run id exists
  const dir = realpathSync(join(parent, runId));
  mkdirSync(join(dir, "cells"), { mode: 0o700 });
  mkdirSync(join(dir, "exposed"), { mode: 0o700 });
  const secrets = new Set<string>();
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
    secrets,
    write(rel, value) {
      const final = join(dir, rel);
      if (existsSync(final)) throw new Error(`refusing to overwrite ${rel}`);
      let text = `${JSON.stringify(value, null, 2)}\n`;
      for (const [from, to] of swaps) text = text.split(from).join(to);
      text = text.replace(/\/Users\/[^\s"'\\/]+/g, "/Users/<user>");
      for (const s of secrets) text = text.split(s).join("<redacted>");
      for (const needle of [
        iso.realHome,
        process.env["HOME"] ?? "",
        iso.work,
        repoRoot,
        ...secrets,
      ]) {
        if (needle.length > 3 && text.includes(needle))
          throw new Error("refusing to persist: leak guard tripped");
      }
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

// ---------------------------------------------------------------------------
// One cell: install, start the real host, capture what it exposes, stop it
// ---------------------------------------------------------------------------

type Entry = { id: string | null; status: string | null; error: string | null };
type Capture = {
  ids: string[];
  tools: Tool[];
  stable: boolean;
  entries?: Entry[];
  reloads?: number;
  life: string[];
};

const readText = (f: string) => {
  try {
    return readFileSync(f, "utf8").slice(0, 262_144);
  } catch {
    return "";
  }
};
const busOnly = (tools: Tool[]) =>
  tools
    .filter((t) => t.id.startsWith("bus_"))
    .sort((a, b) => a.id.localeCompare(b.id));

async function captureV1(
  dir: string,
  project: string,
  port: number,
): Promise<Capture> {
  const base = `http://127.0.0.1:${port}`;
  const q = `directory=${encodeURIComponent(project)}`;
  const read = async () => {
    const ids = await getJson(`${base}/experimental/tool/ids?${q}`);
    const full = await getJson(
      `${base}/experimental/tool?${q}&provider=anthropic&model=host-matrix-probe`,
    );
    if (
      !(
        ids.ok &&
        Array.isArray(ids.body) &&
        full.ok &&
        Array.isArray(full.body)
      )
    )
      return undefined;
    const tools = (
      full.body as Array<{
        id: string;
        description?: string;
        parameters?: unknown;
      }>
    ).map(
      (t): Tool => ({
        id: t.id,
        description: t.description ?? null,
        input: t.parameters ?? null,
      }),
    );
    return {
      ids: (ids.body as string[]).filter((i) => i.startsWith("bus_")).sort(),
      tools: busOnly(tools),
    };
  };
  const first = await waitFor("v1 tool listing", 150_000, read);
  const life1 = readText(join(dir, "lifecycle.jsonl"));
  await sleep(3000);
  const second = (await read()) ?? first;
  return {
    ...second,
    stable: JSON.stringify(first) === JSON.stringify(second),
    life: [life1, readText(join(dir, "lifecycle.jsonl"))],
  };
}

async function captureV2(
  dir: string,
  project: string,
  port: number,
  password: string,
): Promise<Capture> {
  const base = `http://127.0.0.1:${port}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    "x-opencode-directory": project,
  };
  type P = {
    id?: string;
    source?: { type?: string; path?: string };
    state?: { status?: string; error?: string };
  };
  const plugins = async () => {
    const r = await getJson(`${base}/api/plugin`, headers);
    const data = (r.body as { data?: P[] } | null)?.data;
    return r.ok && Array.isArray(data) && data.length > 0 ? data : undefined;
  };
  const underTest = (e: P) =>
    e.id === PLUGIN_ID || /\/space-bus(-dup)?$/.test(e.source?.path ?? "");
  type Snap = { reloads: number; tools: Tool[] };
  const snapshot = (): Snap | undefined => {
    try {
      return JSON.parse(
        readFileSync(join(dir, "observed-tools.json"), "utf8"),
      ) as Snap;
    } catch {
      return undefined;
    }
  };
  await waitFor("v2 /api/plugin", 120_000, plugins);
  await waitFor("observer snapshot with bus tools", 90_000, async () => {
    const list = (await plugins()) ?? [];
    const settled = list
      .filter(underTest)
      .every((e) => e.state?.status !== "loading");
    const seen = snapshot()?.tools.some((t) => t.id.startsWith("bus_"));
    return list.some(
      (e) => e.id === "host-matrix-observer" && e.state?.status === "active",
    ) &&
      seen &&
      settled
      ? true
      : undefined;
  }).catch(() => undefined);
  await sleep(1500);
  const first = snapshot();
  const life1 = readText(join(dir, "lifecycle.jsonl"));
  await sleep(3000);
  const second = snapshot() ?? first;
  const tools = busOnly(second?.tools ?? []);
  return {
    ids: tools.map((t) => t.id),
    tools,
    stable:
      JSON.stringify(busOnly(first?.tools ?? [])) === JSON.stringify(tools),
    entries: ((await plugins()) ?? []).filter(underTest).map((e) => ({
      id: e.id ?? null,
      status: e.state?.status ?? null,
      error: e.state?.error ?? null,
    })),
    reloads: second?.reloads ?? 0,
    life: [life1, readText(join(dir, "lifecycle.jsonl"))],
  };
}

function installed(nm: string): string[] {
  return readdirSync(nm)
    .filter((n) => !n.startsWith("."))
    .flatMap((n) =>
      n.startsWith("@")
        ? readdirSync(join(nm, n)).map((s) => `${n}/${s}`)
        : [n],
    );
}

async function runCell(
  iso: Iso,
  durable: Durable,
  cand: ReturnType<typeof build>,
  host: Host,
  kind: Kind,
): Promise<Json> {
  const id = `${host.id}/${kind}`;
  const dir = join(iso.work, "cells", `${host.id}-${kind}`);
  const p = (n: string) => join(dir, n);
  for (const d of [
    "install",
    "project",
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
  const env = (extra: Record<string, string> = {}) => ({
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
  });
  const problems: string[] = [];
  let capture: Capture | undefined;
  let stop: { stopped: boolean; portClosed: boolean } | undefined;
  let identity: Json | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let port = 0;
  let stopHost:
    | (() => Promise<{ stopped: boolean; portClosed: boolean }>)
    | undefined;
  try {
    // --- install exactly one host generation + the candidate tarball -------
    const binPkg = host.packages[1] as string;
    writeFileSync(
      p("install/package.json"),
      '{"name":"host-matrix-consumer","private":true,"type":"module"}',
    );
    sh(
      `npm install ${id}`,
      "npm",
      [
        "install",
        "--cache",
        join(iso.work, "npm-cache"),
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        ...host.packages
          .filter((n) => n !== binPkg)
          .map((n) => `${n}@${host.version}`),
        cand.candidate.file,
      ],
      {
        cwd: p("install"),
        env: {
          ...env(),
          NPM_CONFIG_USERCONFIG: join(iso.work, "npmrc-user"),
          NPM_CONFIG_GLOBALCONFIG: join(iso.work, "npmrc-global"),
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
      },
    );
    const nm = p("install/node_modules");
    const lock = (
      JSON.parse(readFileSync(p("install/package-lock.json"), "utf8")) as {
        packages: Record<string, { version?: string; integrity?: string }>;
      }
    ).packages;
    const pinned = host.packages.every((n) => {
      const e = lock[`node_modules/${n}`];
      return (
        e?.version === host.version &&
        e.integrity === PINS[`${n}@${host.version}`]
      );
    });
    const other = installed(nm).filter((n) =>
      host.v2
        ? n.startsWith("@opencode-ai/") || n.startsWith("opencode-")
        : n.startsWith("@opencode/"),
    );
    const binary = join(nm, binPkg, "bin/opencode");
    // v1's CLI exits with an error for --version inside the sandbox, so v1
    // reports its version from the running server (/global/health) below.
    const ver = inSandbox(iso, binary, ["--version"]);
    const reported = host.v2
      ? spawnSync(ver.cmd, ver.args, { env: env() }).stdout.toString().trim()
      : host.version;
    const pkgDir = join(nm, PACKAGE);
    identity = {
      hostVersionReported: reported,
      hostPackagesPinned: pinned,
      otherGenerationPackages: other,
      tarballLockMatches:
        lock[`node_modules/${PACKAGE}`]?.integrity === cand.candidate.integrity,
      installedEntryMatches:
        sha256(readFileSync(join(pkgDir, "dist/index.js"))) ===
        cand.candidate.distIndexSha256,
    };
    if (
      !pinned ||
      other.length > 0 ||
      !reported.includes(host.version) ||
      !identity["tarballLockMatches"] ||
      !identity["installedEntryMatches"]
    ) {
      problems.push("install identity check failed");
    }

    // --- plugin reference(s) -----------------------------------------------
    const refs = kind === "duplicate" ? 2 : 1;
    if (host.v2) {
      mkdirSync(p("project/.opencode/plugin/zz-observer"), { recursive: true });
      cpSync(
        join(fixtureDir, "observer-v2.js"),
        p("project/.opencode/plugin/zz-observer/index.js"),
      );
      symlinkSync(pkgDir, p("project/.opencode/plugin/space-bus"), "dir");
      if (refs === 2)
        symlinkSync(pkgDir, p("project/.opencode/plugin/space-bus-dup"), "dir");
    } else {
      const url = pathToFileURL(pkgDir).href;
      writeFileSync(
        p("project/opencode.json"),
        JSON.stringify({ plugin: Array(refs).fill(url) }),
      );
    }

    // --- start the real host inside the sandbox ----------------------------
    port = await freePort();
    const password = `hm-${randomBytes(12).toString("hex")}`;
    durable.secrets.add(password);
    const wrapped = inSandbox(iso, binary, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
      ...(host.v2 ? [] : ["--print-logs"]),
    ]);
    const fd = openSync(p("host.log"), "w");
    child = spawn(wrapped.cmd, wrapped.args, {
      cwd: p("project"),
      stdio: ["ignore", fd, fd],
      env: env({
        U1_LIFECYCLE_FILE: p("lifecycle.jsonl"),
        ...(kind === "mutated"
          ? { U1_MUTATE_REQUIRED: `${MUTATION.tool}.${MUTATION.arg}` }
          : {}),
        ...(host.v2
          ? {
              OPENCODE_SERVER_PASSWORD: password,
              HOST_MATRIX_TOOLS_FILE: p("observed-tools.json"),
            }
          : {}),
      }),
    });
    closeSync(fd);
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    const owned = child;
    stopHost = async () => {
      // Signal only the exact child this script spawned, after checking it.
      const cmdline = spawnSync(
        "/bin/ps",
        ["-o", "command=", "-p", String(owned.pid)],
        { env: { PATH: "/bin:/usr/bin" } },
      ).stdout.toString();
      if (!exited && cmdline.includes(binary)) {
        owned.kill("SIGTERM");
        for (let i = 0; i < 40 && !exited; i++) await sleep(250);
        if (!exited) owned.kill("SIGKILL");
        for (let i = 0; i < 20 && !exited; i++) await sleep(250);
      }
      return { stopped: exited, portClosed: !(await portOpen(port)) };
    };
    capture = host.v2
      ? await captureV2(dir, p("project"), port, password)
      : await captureV1(dir, p("project"), port);
    if (!host.v2) {
      const health = await getJson(`http://127.0.0.1:${port}/global/health`);
      const live = String((health.body as Json | null)?.["version"] ?? "");
      (identity as Json)["hostVersionReported"] = live;
      if (live !== host.version)
        problems.push("running v1 host reports another version");
    }
  } catch (e) {
    problems.push(`harness error: ${(e as Error).message.slice(0, 200)}`);
  } finally {
    stop = await stopHost?.();
    stopHost = undefined;
  }
  if (stop && !(stop.stopped && stop.portClosed))
    problems.push("host teardown problem");

  // --- judge ------------------------------------------------------------------
  const cmp = capture
    ? compare(cand.ref, capture.ids, capture.tools)
    : undefined;
  const six =
    !!capture &&
    !!cmp &&
    capture.ids.join() === BUS_TOOLS.join() &&
    cmp.duplicates.length === 0 &&
    cmp.missing.length === 0 &&
    cmp.unexpected.length === 0;
  if (capture && !capture.stable)
    problems.push("exposure not stable across samples");
  if (capture?.entries && !capture.entries.some((e) => e.status === "active"))
    problems.push("no active plugin entry");
  const life = capture && {
    first: counters(capture.life[0] ?? ""),
    last: counters(capture.life[1] ?? ""),
  };
  const lifeStable =
    !!life && JSON.stringify(life.first) === JSON.stringify(life.last);
  if (life && !lifeStable) problems.push("lifecycle counters not stable");
  let disposition: string;
  if (problems.length > 0 || !cmp || !capture) disposition = "BLOCKED";
  else if (kind === "mutated") {
    const only =
      cmp.diffs.length === 1 &&
      cmp.diffs[0]?.startsWith(`${MUTATION.tool}/input/required`) &&
      cmp.diffs[0].includes(`ref-only=[${MUTATION.arg}]`);
    disposition = only ? "CONTROL-DETECTED" : "CONTROL-FAILED";
  } else disposition = six && cmp.diffs.length === 0 ? "PASS" : "FAIL";

  const exposureDigest = capture
    ? sha256(
        JSON.stringify(
          capture.tools.map((t) => [t.id, t.description, canon(t.input)]),
        ),
      ).slice(0, 16)
    : null;
  const result: Json = {
    id,
    host: { id: host.id, version: host.version },
    kind,
    refsConfigured: kind === "duplicate" ? 2 : 1,
    disposition,
    problems,
    identity: identity ?? null,
    exposure: capture &&
      cmp && {
        ids: capture.ids,
        uniqueNames: new Set(capture.ids).size,
        duplicates: cmp.duplicates,
        missing: cmp.missing,
        unexpected: cmp.unexpected,
        stable: capture.stable,
        digest: exposureDigest,
        pluginEntries: capture.entries ?? null,
        observerReloads: capture.reloads ?? null,
      },
    diffs: cmp?.diffs ?? null,
    lifecycle: life ? { ...life.last, stable: lifeStable } : null,
    detectorControls:
      kind === "single" && capture
        ? detectorControls(cand.ref, capture.ids, capture.tools)
        : null,
    teardown: stop ?? null,
  };
  durable.write(`cells/${host.id}-${kind}.json`, result);
  if (kind === "single" && capture) {
    durable.write(
      `exposed/${host.id}.json`,
      capture.tools.map((t) => ({
        id: t.id,
        description: t.description,
        input: canon(t.input),
      })),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
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
      : `u1-loader-${stamp}Z-${randomBytes(3).toString("hex")}`;
  const durable = openDurable(iso, runId);
  log(`run ${runId} -> .context/u1-loader/${runId}/`);
  let exit = 1;
  try {
    const selfTest = await sandboxSelfTest(iso);
    log(`sandbox self-test: ${JSON.stringify(selfTest)}`);
    if (!selfTest.ok) throw new Error("OS sandbox self-test failed");

    const built = build(iso);
    const strip = (t: Tarball) => ({
      version: t.version,
      sha256: t.sha256,
      integrity: t.integrity,
      distIndexSha256: t.distIndexSha256,
    });
    const head = sh("git", "git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      env: { PATH: `${BASE_PATH}:/opt/homebrew/bin` },
    }).trim();
    durable.write("manifest.json", {
      runId,
      command: `bun run scripts/verify-host-matrix.ts ${argv.join(" ")}`.trim(),
      tools: {
        node: sh("node -v", iso.node, ["-v"], { env: {} }).trim(),
        bun: process.versions["bun"],
      },
      source: {
        head,
        sha256: Object.fromEntries([
          [
            "scripts/verify-host-matrix.ts",
            fileSha("scripts/verify-host-matrix.ts"),
          ],
          ...FIXTURES.map((f) => [
            f,
            fileSha(`test/fixtures/dual-host/loader/${f}`),
          ]),
        ]),
      },
      baseline: { ...built.provenance, tarball: strip(built.baseline) },
      candidate: strip(built.candidate),
      isolation: { selfTest },
      comparison: {
        reference:
          "baseline zod args -> JSON Schema via the plugin's bundled zod",
        droppedKeys: ["$schema"],
        requiredIsSet: true,
        coverage: coverage(built.ref),
      },
    });
    durable.write("reference.json", built.ref);

    const kinds: Kind[] = ["single", "duplicate", "mutated"];
    const done = new Map<string, Json>();
    await pool(
      HOSTS.flatMap((h) => kinds.map((k) => [h, k] as const)),
      3,
      async ([h, k]) => {
        const r = await runCell(iso, durable, built, h, k);
        done.set(`${h.id}/${k}`, r);
        log(`${h.id}/${k}: ${r["disposition"]}`);
      },
    );

    const versions = HOSTS.map((h) => {
      const [s, d, m] = kinds.map((k) => done.get(`${h.id}/${k}`));
      const digest = (x?: Json) => (x?.["exposure"] as Json | null)?.["digest"];
      const controls = s?.["detectorControls"] as {
        clean: boolean;
        results: Array<{ detected: boolean }>;
      } | null;
      const outcome = [s, d, m].map((x) => x?.["disposition"]);
      const invalid =
        !controls?.clean ||
        !controls.results.every((r) => r.detected) ||
        outcome.some((o) =>
          [undefined, "BLOCKED", "CONTROL-FAILED"].includes(o as string),
        );
      const pass =
        outcome.join() === "PASS,PASS,CONTROL-DETECTED" &&
        !!digest(s) &&
        digest(s) === digest(d);
      return {
        host: h.id,
        version: h.version,
        verdict: invalid ? "BLOCKED" : pass ? "PASS" : "FAIL",
        cells: {
          single: outcome[0],
          duplicate: outcome[1],
          mutated: outcome[2],
        },
        sameExposure: digest(s) === digest(d),
        // module = entry evaluated; server/setup = host ran the hook;
        // transformEval = replayable v2 transform callback (v2 only).
        lifecycle: { single: s?.["lifecycle"], duplicate: d?.["lifecycle"] },
        duplicatePluginEntries: (d?.["exposure"] as Json | null)?.[
          "pluginEntries"
        ],
        detectorControls: controls,
      };
    });
    exit = versions.some((v) => v.verdict === "BLOCKED")
      ? 1
      : versions.some((v) => v.verdict === "FAIL")
        ? 2
        : 0;
    durable.write("summary.json", {
      runId,
      exit,
      versions,
      limitations: [
        "macOS arm64 only; no Linux host",
        "v2 exposure is read through an in-host observer plugin; v1 through /experimental/tool",
        "v2 schemas are embedded in the candidate, so v2 measures host transit; v1 converts the real zod args independently",
        "refine/superRefine rules are not representable in JSON Schema; no tool was executed (U2)",
        "duplicate reference: v1 = same directory URL twice in plugin[]; v2 = two discovered plugin dirs, one plugin id",
      ],
    });
    for (const v of versions) log(`${v.host} ${v.version}: ${v.verdict}`);
  } catch (e) {
    log(`fatal: ${(e as Error).message}`);
    try {
      durable.write("summary.json", {
        runId,
        exit: 1,
        fatal: (e as Error).message.slice(0, 400),
      });
    } catch {
      /* nothing more can be persisted */
    }
  } finally {
    const own =
      basename(iso.work).startsWith("space-bus-host-matrix-") &&
      dirname(iso.work) === realpathSync(tmpdir()) &&
      existsSync(join(iso.work, WORK_MARKER));
    if (exit === 0 && !keep && own)
      rmSync(iso.work, { recursive: true, force: true });
    else log(`work dir kept: ${basename(iso.work)}`);
  }
  return exit;
}

export type { Host, Iso, Json, Tarball };
// Pure, side-effect-free-at-import helpers reused by
// scripts/verify-controller-delegation.ts (U2). Importing this module must not
// run the U1 matrix: main() only runs when this file is the entry point.
export {
  BASE_PATH,
  freePort,
  getJson,
  HOSTS,
  identify,
  inSandbox,
  makeIso,
  PINS,
  portOpen,
  sandboxSelfTest,
  sh,
  sleep,
  WORK_MARKER,
  waitFor,
};

if (import.meta.main) process.exit(await main());
