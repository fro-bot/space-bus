#!/usr/bin/env bun
/**
 * Does ONE real OpenCode v2.3.2 server, launched from a neutral directory,
 * route each workspace's tool calls to that workspace's OWN roster?
 *
 *   bun run scripts/verify-v2-directory-routing.ts [--source head|tree] [--run-id <id>] [--keep]
 *
 * Layout (all inside one disposable, marker-checked work dir):
 *   launch/      server cwd. Holds its own spacebus.json (project
 *                `routing-launch-only`) and NO plugin: the negative control for
 *                a plugin that resolves a roster from the process cwd.
 *   workspace-a/ spacebus.json (projects routing-a-one, routing-a-two) and
 *                .opencode/plugin/space-bus -> the packed package.
 *   workspace-b/ spacebus.json (project routing-b-one), same plugin link.
 *
 * Through the NORMAL pipeline (HTTP session at `location.directory`, the
 * deterministic model fixture test/fixtures/dual-host/delegation/
 * model-fixture.mjs emits a Code Mode `execute` call to the plugin tool), each
 * workspace session calls `bus_task` for a project that is in no roster. The
 * refusal is read-only (nothing is dispatched, no target is contacted) and
 * names the roster file it resolved and that roster's valid projects, so the
 * reply identifies the owning directory. Sessions run A, B, A so a roster
 * cached by an earlier call would show.
 *
 * Isolation is the shared strict profile of verify-host-matrix (writes only in
 * the work dir, real home unreadable, loopback only, canary self-test before
 * anything starts). It covers host EXECUTION only: the pack and npm install
 * steps run unsandboxed, with network access, before any host starts. No
 * managed mode, no guest, no bridge, no external model traffic, no credential.
 *
 * --source head  pack `git archive HEAD` (the committed tree; default)
 * --source tree  pack the current working tree (cached + untracked files)
 *
 * Evidence: .context/v2-routing/<run-id>/ (git-ignored, scrubbed).
 * Exit: 0 every routing assertion and control passed; 1 harness invalid or
 * evidence unreadable (nothing established); 2 harness valid but a workspace
 * routed to the wrong roster (finding); 3 the sandbox could not be proven.
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
const CONTROLLER = HOSTS.find((h) => h.id === "v2-pilot");
const log = (m: string) => console.error(`[v2-routing] ${m}`);
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------
// Pure assertions (exported for the unit-style controls below)
// ---------------------------------------------------------------------------

export type Expectation = {
  /** Directory name the roster file must live under. */
  workspace: string;
  /** Projects that must be listed as valid. */
  projects: string[];
  /** Projects of every OTHER roster; none may appear. */
  foreign: string[];
};

/** Which roster does a refusal reply say it resolved? `undefined` = not a refusal. */
export function judgeReply(text: string, want: Expectation) {
  const header = /roster:\s*(\S+spacebus\.json)/.exec(text)?.[1];
  const valid = /Valid projects:\s*([^\n|]+)/
    .exec(text)?.[1]
    ?.split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const problems: string[] = [];
  if (!/unknown project/.test(text))
    problems.push("not an unknown-project refusal");
  if (/Dispatched/.test(text)) problems.push("a dispatch happened");
  if (!header) problems.push("reply names no roster file");
  else if (!header.includes(`/${want.workspace}/`))
    problems.push(
      `roster file is not under ${want.workspace}: ${header.split("/").slice(-3).join("/")}`,
    );
  if (!valid) problems.push("reply lists no valid projects");
  else {
    if (
      JSON.stringify([...valid].sort()) !==
      JSON.stringify([...want.projects].sort())
    )
      problems.push(
        `valid projects are ${valid.join(",")}, want ${want.projects.join(",")}`,
      );
    for (const f of want.foreign)
      if (valid.includes(f))
        problems.push(`lists another roster's project ${f}`);
  }
  return { ok: problems.length === 0, problems, roster: header, valid };
}

// ---------------------------------------------------------------------------
// Build the artifact and install the pinned controller
// ---------------------------------------------------------------------------

function git(...a: string[]): string {
  return sh(`git ${a[0]}`, "git", a, {
    cwd: repoRoot,
    env: { PATH: `${BASE_PATH}:/opt/homebrew/bin` },
  });
}

function stageSource(iso: Iso, source: "head" | "tree") {
  const src = join(iso.work, "src");
  mkdirSync(src);
  if (source === "head") {
    const tar = join(iso.work, "head.tar");
    git("archive", "--format=tar", "-o", tar, "HEAD");
    sh("untar", "tar", ["-xf", tar, "-C", src], { env: { PATH: BASE_PATH } });
    return { src, files: -1, digest: sha(git("rev-parse", "HEAD")) };
  }
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
        return false;
      }
    })
    .sort();
  const tree = createHash("sha256");
  for (const f of files) {
    mkdirSync(dirname(join(src, f)), { recursive: true });
    cpSync(join(repoRoot, f), join(src, f));
    tree.update(`${f}\0${sha(readFileSync(join(repoRoot, f)))}\n`);
  }
  return { src, files: files.length, digest: tree.digest("hex") };
}

function packCurrent(iso: Iso, source: "head" | "tree") {
  const staged = stageSource(iso, source);
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
  log(`build (${source}): bun install + build + pack`);
  sh("bun install", process.execPath, ["install", "--frozen-lockfile"], {
    cwd: staged.src,
    env,
  });
  sh("bun build", process.execPath, ["run", "build"], { cwd: staged.src, env });
  const out = sh(
    "npm pack",
    "npm",
    ["pack", "--ignore-scripts", "--silent", "--pack-destination", iso.work],
    { cwd: staged.src, env },
  )
    .trim()
    .split("\n")
    .pop();
  return { tarball: identify(join(iso.work, out ?? "")), staged, npmEnv: env };
}

// ---------------------------------------------------------------------------
// Evidence (scrubbed, atomic, git-ignored)
// ---------------------------------------------------------------------------

function openEvidence(iso: Iso, runId: string) {
  if (!/^[A-Za-z0-9._-]{6,80}$/.test(runId))
    throw new Error("invalid --run-id");
  const rel = `.context/v2-routing/${runId}`;
  const ignored = spawnSync("git", ["check-ignore", "-q", "--", `${rel}/x`], {
    cwd: repoRoot,
    env: { PATH: `${BASE_PATH}:/opt/homebrew/bin` },
  });
  if (ignored.status !== 0) throw new Error("evidence dir is not git-ignored");
  const dir = join(repoRoot, rel);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const swaps = (
    [
      [iso.work, "<work>"],
      [repoRoot, "<repo>"],
      [iso.realHome, "<home>"],
      [process.env["HOME"] ?? "", "<home>"],
    ] as const
  )
    .filter(([f]) => f.length > 3)
    .sort((a, b) => b[0].length - a[0].length);
  return {
    dir,
    write(name: string, value: unknown) {
      let t = `${JSON.stringify(value, null, 2)}\n`;
      for (const [f, to] of swaps) t = t.split(f).join(to);
      t = t.replace(/\/Users\/[^\s"'\\/]+/g, "/Users/<user>");
      for (const needle of [
        iso.realHome,
        process.env["HOME"] ?? "",
        iso.work,
        repoRoot,
      ])
        if (needle.length > 3 && t.includes(needle))
          throw new Error("leak guard tripped");
      const final = join(dir, name);
      if (existsSync(final)) throw new Error(`refusing to overwrite ${name}`);
      const tmp = `${final}.${randomBytes(4).toString("hex")}.tmp`;
      const fd = openSync(tmp, "wx", 0o600);
      try {
        writeSync(fd, t);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, final);
    },
  };
}

// ---------------------------------------------------------------------------
// Host process (owned, command-checked)
// ---------------------------------------------------------------------------

const psCommand = (pid: number) =>
  spawnSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
    env: { PATH: "/bin:/usr/bin" },
  })
    .stdout.toString()
    .trim();

async function stopOwned(child: ChildProcess, bin: string, port: number) {
  const pid = child.pid;
  if (pid && psCommand(pid).includes(bin)) {
    child.kill("SIGTERM");
    for (let i = 0; i < 40 && psCommand(pid); i++) await sleep(250);
    if (psCommand(pid).includes(bin)) child.kill("SIGKILL");
    for (let i = 0; i < 20 && psCommand(pid); i++) await sleep(250);
  }
  await sleep(200);
  return {
    stopped: !pid || !psCommand(pid),
    portClosed: !(await portOpen(port)),
  };
}

async function http(
  url: string,
  headers: Record<string, string>,
  method = "GET",
  body?: unknown,
) {
  try {
    const r = await fetch(url, {
      method,
      headers: {
        ...headers,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    try {
      return { status: r.status, body: JSON.parse(text) as unknown };
    } catch {
      return { status: r.status, body: text as unknown };
    }
  } catch (e) {
    return { status: 0, body: String(e) as unknown };
  }
}

async function until<T>(
  what: string,
  ms: number,
  probe: () => Promise<T | undefined>,
): Promise<T> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(500)) {
    const v = await probe();
    if (v !== undefined) return v;
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

type Check = {
  name: string;
  ok: boolean;
  kind: "routing" | "harness";
  detail?: string;
};

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const keep = argv.includes("--keep");
  const srcAt = argv.indexOf("--source");
  const source = (srcAt >= 0 ? argv[srcAt + 1] : "head") as "head" | "tree";
  if (source !== "head" && source !== "tree") {
    log("--source must be head or tree");
    return 1;
  }
  if (!CONTROLLER) throw new Error("U1 host table has no v2-pilot");
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    !existsSync("/usr/bin/sandbox-exec")
  ) {
    log("needs macOS arm64 + sandbox-exec; there is no unsandboxed mode");
    return 1;
  }
  const iso = makeIso();
  const at = argv.indexOf("--run-id");
  const runId =
    at >= 0
      ? String(argv[at + 1])
      : `v2-routing-${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${randomBytes(3).toString("hex")}`;
  const evidence = openEvidence(iso, runId);
  log(`run ${runId} -> .context/v2-routing/${runId}/`);

  const checks: Check[] = [];
  const check = (
    kind: Check["kind"],
    name: string,
    ok: boolean,
    detail?: string,
  ) => {
    checks.push({ name, kind, ok, ...(detail ? { detail } : {}) });
    log(
      `${ok ? "ok  " : "FAIL"} [${kind}] ${name}${ok || !detail ? "" : ` — ${detail}`}`,
    );
    return ok;
  };
  let exit = 1;
  let host: { child: ChildProcess; bin: string; port: number } | undefined;
  let fixture: Awaited<ReturnType<typeof startFixture>> | undefined;
  const teardown: Record<string, unknown> = {};
  const replies: Array<Json> = [];
  try {
    const self = await sandboxSelfTest(iso);
    log(`sandbox self-test ok=${self.ok}`);
    evidence.write("sandbox-selftest.json", self);
    if (!self.ok) {
      check(
        "harness",
        "strict sandbox self-test",
        false,
        JSON.stringify(self.checks),
      );
      exit = 3;
      return exit;
    }
    check(
      "harness",
      "strict sandbox self-test (canaries, egress, positive controls)",
      true,
    );

    // ---- setup phase: pack + install (unsandboxed, network) -------------------
    const built = packCurrent(iso, source);
    const hostDir = join(iso.work, "hosts/controller");
    mkdirSync(hostDir, { recursive: true });
    writeFileSync(
      join(hostDir, "package.json"),
      '{"name":"routing-consumer","private":true,"type":"module"}',
    );
    sh(
      "npm install",
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--no-progress",
        "--ignore-scripts",
        "--registry",
        "https://registry.npmjs.org/",
        `${CONTROLLER.packages[0]}@${CONTROLLER.version}`,
        built.tarball.file,
      ],
      {
        cwd: hostDir,
        env: {
          PATH: `${dirname(iso.node)}:${BASE_PATH}`,
          HOME: join(iso.work, "build-home"),
          NPM_CONFIG_USERCONFIG: join(iso.work, "npmrc-user"),
          NPM_CONFIG_GLOBALCONFIG: join(iso.work, "npmrc-global"),
          NPM_CONFIG_CACHE: join(iso.work, "npm-cache"),
          NPM_CONFIG_UPDATE_NOTIFIER: "false",
        },
      },
    );
    const nm = join(hostDir, "node_modules");
    const lock = (
      JSON.parse(readFileSync(join(hostDir, "package-lock.json"), "utf8")) as {
        packages: Record<string, { version?: string; integrity?: string }>;
      }
    ).packages;
    const pinned = [...CONTROLLER.packages].every(
      (n) =>
        lock[`node_modules/${n}`]?.version === CONTROLLER.version &&
        lock[`node_modules/${n}`]?.integrity ===
          PINS[`${n}@${CONTROLLER.version}`],
    );
    const pkgDir = join(nm, PACKAGE);
    const installedSha = sha(readFileSync(join(pkgDir, "dist/index.js")));
    check(
      "harness",
      "controller packages match the pinned v2.3.2 integrity",
      pinned,
    );
    check(
      "harness",
      "installed package is the packed artifact (lock integrity and dist/index.js digest)",
      lock[`node_modules/${PACKAGE}`]?.integrity === built.tarball.integrity &&
        installedSha === built.tarball.distIndexSha256,
    );
    check(
      "harness",
      "no v1 SDK or v1 host in the controller install",
      !existsSync(join(nm, "@opencode-ai")) &&
        !existsSync(join(nm, "opencode-ai")),
    );
    const bin = join(nm, CONTROLLER.packages[1] as string, "bin/opencode");
    evidence.write("manifest.json", {
      runId,
      command:
        `bun run scripts/verify-v2-directory-routing.ts ${argv.join(" ")}`.trim(),
      source: {
        mode: source,
        head: git("rev-parse", "HEAD").trim(),
        files: built.staged.files,
        digest: built.staged.digest,
      },
      artifact: {
        name: PACKAGE,
        version: built.tarball.version,
        sha256: built.tarball.sha256,
        integrity: built.tarball.integrity,
        distIndexSha256: built.tarball.distIndexSha256,
      },
      controller: {
        version: CONTROLLER.version,
        pinned,
        installedDistIndexSha256: installedSha,
      },
      tools: { node: process.version, bun: process.versions["bun"] },
    });

    // ---- layout ---------------------------------------------------------------
    const cell = join(iso.work, "cells/controller");
    const dirs = {
      launch: join(iso.work, "launch"),
      a: join(iso.work, "workspace-a"),
      b: join(iso.work, "workspace-b"),
    };
    const rosters = {
      a: { projects: ["routing-a-one", "routing-a-two"], ws: "workspace-a" },
      b: { projects: ["routing-b-one"], ws: "workspace-b" },
      launch: { projects: ["routing-launch-only"], ws: "launch" },
    } as const;
    for (const d of [
      "home",
      "tmp",
      "xdg/config",
      "xdg/data",
      "xdg/cache",
      "xdg/state",
      "config",
    ])
      mkdirSync(join(cell, d), { recursive: true });
    for (const [key, dir] of Object.entries(dirs) as Array<
      ["launch" | "a" | "b", string]
    >) {
      mkdirSync(dir, { recursive: true });
      const projects = rosters[key].projects.map((name) => {
        const path = join(dir, "projects", name);
        mkdirSync(path, { recursive: true });
        return { name, path, description: `${name} (scratch)` };
      });
      writeFileSync(
        join(dir, "spacebus.json"),
        JSON.stringify({ server: { baseUrl: "http://127.0.0.1:9" }, projects }),
      );
    }
    for (const dir of [dirs.a, dirs.b]) {
      mkdirSync(join(dir, ".opencode/plugin"), { recursive: true });
      symlinkSync(pkgDir, join(dir, ".opencode/plugin/space-bus"), "dir");
    }
    fixture = await startFixture();
    writeFileSync(
      join(cell, "config/opencode.jsonc"),
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "fixture/scripted",
        providers: {
          fixture: {
            name: "Fixture",
            env: ["FIXTURE_API_KEY"],
            package: "@opencode/ai/providers/openai-compatible",
            settings: {
              baseURL: `http://127.0.0.1:${fixture.port}/controller/v1`,
            },
            models: {
              scripted: { name: "Scripted", capabilities: { tools: true } },
            },
          },
        },
      }),
    );

    // ---- one server, launched from the neutral directory ----------------------
    const port = await freePort();
    const pw = `rt-${randomBytes(10).toString("hex")}`;
    const w = inSandbox(iso, bin, [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ]);
    const fd = openSync(join(cell, "host.log"), "w");
    const child = spawn(w.cmd, w.args, {
      cwd: dirs.launch,
      stdio: ["ignore", fd, fd],
      env: {
        PATH: `${dirname(iso.node)}:${BASE_PATH}`,
        LANG: "en_US.UTF-8",
        HOME: join(cell, "home"),
        TMPDIR: join(cell, "tmp"),
        XDG_CONFIG_HOME: join(cell, "xdg/config"),
        XDG_DATA_HOME: join(cell, "xdg/data"),
        XDG_CACHE_HOME: join(cell, "xdg/cache"),
        XDG_STATE_HOME: join(cell, "xdg/state"),
        OPENCODE_CONFIG_DIR: join(cell, "config"),
        OPENCODE_DISABLE_AUTOUPDATE: "true",
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        OPENCODE_DISABLE_LSP_DOWNLOAD: "true",
        OPENCODE_DISABLE_PRUNE: "true",
        OPENCODE_SERVER_PASSWORD: pw,
        FIXTURE_API_KEY: "fixture-key",
      },
    });
    closeSync(fd);
    host = { child, bin, port };
    const base = `http://127.0.0.1:${port}`;
    const auth = (dir: string) => ({
      authorization: `Basic ${Buffer.from(`opencode:${pw}`).toString("base64")}`,
      "x-opencode-directory": dir,
    });
    const info = await until("v2 /api/info", 120_000, async () => {
      const r = await http(`${base}/api/info`, auth(dirs.launch));
      return r.status === 200 ? (r.body as Json) : undefined;
    });
    check(
      "harness",
      "server reports v2.3.2 and was launched from the neutral directory",
      info["version"] === CONTROLLER.version,
    );

    // /api/plugin lists the server-level view; per-location plugin instances
    // load when a session needs them, so it is recorded, not gated on.
    const pluginIn = async (dir: string) => {
      const r = await http(`${base}/api/plugin`, auth(dir));
      const list = (
        r.body as {
          data?: Array<{ id?: string; state?: { status?: string } }>;
        } | null
      )?.data;
      if (r.status !== 200 || !Array.isArray(list))
        return { read: false as const, status: r.status };
      return {
        read: true as const,
        status:
          list.find((x) => x.id === "space-bus")?.state?.status ?? "absent",
      };
    };
    const states: Record<string, unknown> = {};
    const snapshotPlugins = async (when: string) => {
      for (const [label, dir] of [
        ["workspace-a", dirs.a],
        ["workspace-b", dirs.b],
        ["launch", dirs.launch],
      ] as const)
        states[`${when}:${label}`] = await pluginIn(dir);
    };
    await snapshotPlugins("before-sessions");

    // ---- A, B, A: each session at its own location ----------------------------
    const sessionCall = async (
      label: string,
      dir: string,
      want: Expectation,
    ) => {
      const mark = fixture?.requests.length ?? 0;
      const created = await http(`${base}/api/session`, auth(dir), "POST", {
        location: { directory: dir },
      });
      const sid = (
        (created.body as Json | null)?.["data"] as Json | undefined
      )?.["id"];
      if (typeof sid !== "string")
        return check(
          "harness",
          `${label}: session created at its location`,
          false,
          String(created.status),
        );
      const plan = [
        {
          tool: "bus_task",
          args: {
            project: "no-such-project",
            prompt: "routing probe: this must be refused",
          },
        },
      ];
      await http(`${base}/api/session/${sid}/prompt`, auth(dir), "POST", {
        text: `Run the scripted routing probe.\n@@PLAN=${JSON.stringify(plan)}`,
      });
      const done = await until(
        `${label} session to finish`,
        180_000,
        async () => {
          const r = await http(`${base}/api/session/${sid}`, auth(dir));
          const s = (r.body as Json | null)?.["data"] as Json | undefined;
          return s?.["outcome"] !== undefined &&
            (s?.["time"] as Json | undefined)?.["idle"] !== undefined
            ? s
            : undefined;
        },
      );
      const msgs = await http(`${base}/api/session/${sid}/message`, auth(dir));
      const data = (msgs.body as { data?: unknown } | null)?.data;
      if (msgs.status !== 200 || !Array.isArray(data))
        return check(
          "harness",
          `${label}: message list readable`,
          false,
          `HTTP ${msgs.status}`,
        );
      const tool = (data as Json[])
        .filter((m) => m["type"] === "assistant")
        .flatMap((m) => (m["content"] ?? []) as Json[])
        .find((p) => p["type"] === "tool");
      const state = (tool?.["state"] ?? {}) as Json;
      const text = Array.isArray(state["content"])
        ? (state["content"] as Json[])
            .map((c) => String(c["text"] ?? ""))
            .join("\n")
        : String(state["error"] ?? "");
      const verdict = judgeReply(text, want);
      const seen = (fixture?.requests ?? [])
        .slice(mark)
        .filter((r) => r.role === "controller" && r.hasTools);
      replies.push({
        label,
        outcome: done["outcome"],
        status: state["status"],
        roster: verdict.roster,
        valid: verdict.valid,
        modelCwd: seen[0]?.cwd ?? null,
        text: text.slice(0, 400),
      });
      check(
        "harness",
        `${label}: the controller model was driven and the plugin tool answered`,
        seen.length > 0 && text.length > 0,
        `model requests=${seen.length}`,
      );
      return check(
        "routing",
        `${label}: reply names ${want.workspace}'s own roster and projects, not the launch directory or the other workspace`,
        verdict.ok,
        verdict.problems.join("; "),
      );
    };
    const wantA: Expectation = {
      workspace: "workspace-a",
      projects: [...rosters.a.projects],
      foreign: [...rosters.b.projects, ...rosters.launch.projects],
    };
    const wantB: Expectation = {
      workspace: "workspace-b",
      projects: [...rosters.b.projects],
      foreign: [...rosters.a.projects, ...rosters.launch.projects],
    };
    await sessionCall("workspace-a (1st)", dirs.a, wantA);
    await sessionCall("workspace-b", dirs.b, wantB);
    await sessionCall("workspace-a (again)", dirs.a, wantA);

    // ---- detector controls: the judge can fail --------------------------------
    const aReply = replies.find((r) =>
      String(r["label"]).startsWith("workspace-a"),
    )?.["text"] as string | undefined;
    const bReply = replies.find((r) => r["label"] === "workspace-b")?.[
      "text"
    ] as string | undefined;
    check(
      "harness",
      "control: workspace-a's reply is judged wrong for workspace-b's expectation",
      !!aReply && !judgeReply(aReply, wantB).ok,
    );
    check(
      "harness",
      "control: workspace-b's reply is judged wrong for workspace-a's expectation",
      !!bReply && !judgeReply(bReply, wantA).ok,
    );
    check(
      "harness",
      "control: the launch roster's projects are a distinct, never-listed set",
      rosters.launch.projects.every(
        (p) => !(aReply ?? "").includes(p) && !(bReply ?? "").includes(p),
      ),
    );

    // Negative control through the same pipeline: a session at the NEUTRAL launch
    // directory (no plugin there) must not reach any space-bus tool or roster.
    {
      const mark = fixture?.requests.length ?? 0;
      const created = await http(
        `${base}/api/session`,
        auth(dirs.launch),
        "POST",
        { location: { directory: dirs.launch } },
      );
      const sid = (
        (created.body as Json | null)?.["data"] as Json | undefined
      )?.["id"];
      if (typeof sid !== "string")
        check(
          "harness",
          "control: session at the launch directory created",
          false,
          String(created.status),
        );
      else {
        const plan = [
          {
            tool: "bus_task",
            args: {
              project: "no-such-project",
              prompt: "routing probe: this must be refused",
            },
          },
        ];
        await http(
          `${base}/api/session/${sid}/prompt`,
          auth(dirs.launch),
          "POST",
          {
            text: `Run the scripted routing probe.\n@@PLAN=${JSON.stringify(plan)}`,
          },
        );
        await until("launch session to finish", 180_000, async () => {
          const r = await http(`${base}/api/session/${sid}`, auth(dirs.launch));
          const st = (r.body as Json | null)?.["data"] as Json | undefined;
          return st?.["outcome"] !== undefined &&
            (st?.["time"] as Json | undefined)?.["idle"] !== undefined
            ? st
            : undefined;
        });
        const msgs = await http(
          `${base}/api/session/${sid}/message`,
          auth(dirs.launch),
        );
        const data = (msgs.body as { data?: unknown } | null)?.data;
        if (msgs.status !== 200 || !Array.isArray(data))
          check(
            "harness",
            "control: launch-directory message list readable",
            false,
            `HTTP ${msgs.status}`,
          );
        else {
          const tool = (data as Json[])
            .filter((m) => m["type"] === "assistant")
            .flatMap((m) => (m["content"] ?? []) as Json[])
            .find((x) => x["type"] === "tool");
          const st = (tool?.["state"] ?? {}) as Json;
          const text = Array.isArray(st["content"])
            ? (st["content"] as Json[])
                .map((c) => String(c["text"] ?? ""))
                .join("\n")
            : String(st["error"] ?? "");
          const seen = (fixture?.requests ?? [])
            .slice(mark)
            .filter((r) => r.role === "controller" && r.hasTools);
          replies.push({
            label: "launch (control)",
            status: st["status"],
            modelCwd: seen[0]?.cwd ?? null,
            text: text.slice(0, 300),
          });
          check(
            "harness",
            "control: a session at the neutral launch directory reaches no space-bus tool and no roster",
            seen.length > 0 &&
              !/roster:|Valid projects|routing-/.test(text) &&
              /Unknown tool|not found|No tool/i.test(text),
            text.slice(0, 160),
          );
        }
      }
    }
    await snapshotPlugins("after-sessions");
    evidence.write("plugin-state.json", states);
    evidence.write("replies.json", replies);
  } catch (e) {
    check("harness", `fatal: ${(e as Error).message.slice(0, 300)}`, false);
  } finally {
    if (host)
      teardown["controller"] = await stopOwned(host.child, host.bin, host.port);
    await fixture?.close();
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
      "teardown: the host this run started is gone, its port closed, no stray under the work dir",
      tdOk,
      JSON.stringify(teardown),
    );
  }
  const harnessBad = checks.some((c) => c.kind === "harness" && !c.ok);
  const routingBad = checks.some((c) => c.kind === "routing" && !c.ok);
  const routingRan = checks.filter((c) => c.kind === "routing").length;
  if (exit !== 3) exit = harnessBad || routingRan < 3 ? 1 : routingBad ? 2 : 0;
  try {
    evidence.write("summary.json", {
      runId,
      exit,
      source,
      meaning:
        exit === 0
          ? "every workspace routed to its own roster; controls valid"
          : exit === 2
            ? "harness valid; a workspace did NOT route to its own roster (finding)"
            : exit === 3
              ? "sandbox not proven; nothing started"
              : "harness invalid or incomplete; routing NOT established",
      checks,
      teardown,
      limitations: [
        "macOS arm64 only",
        "deterministic fixture model; plugin->host->adapter path only",
        "uses bus_task's read-only unknown-project refusal as the owning-directory probe because the shared fixture only scripts bus_task/bus_wait/bus_result",
        "no managed target, no guest, no bridge",
      ],
    });
  } catch (e) {
    log(`could not persist summary: ${(e as Error).message}`);
    exit = 1;
  }
  log(`exit ${exit}`);
  const own =
    basename(iso.work).startsWith("space-bus-host-matrix-") &&
    dirname(iso.work) === realpathSync(tmpdir()) &&
    existsSync(join(iso.work, WORK_MARKER));
  if (exit === 0 && !keep && own)
    rmSync(iso.work, { recursive: true, force: true });
  else log(`work dir kept: ${basename(iso.work)}`);
  return exit;
}

async function startFixture() {
  const mod = (await import(
    join(repoRoot, "test/fixtures/dual-host/delegation/model-fixture.mjs")
  )) as {
    startModelFixture: (port?: number) => Promise<{
      port: number;
      requests: Array<{ role: string; hasTools: boolean; cwd: string | null }>;
      close: () => Promise<void>;
    }>;
  };
  return mod.startModelFixture();
}

if (import.meta.main) process.exit(await main());
