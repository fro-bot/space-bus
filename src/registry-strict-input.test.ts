import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import plugin from "./index";
import { setupV2, type V2SetupContext } from "./plugin-v2";

// bus_registry validates strictly per action (ACTION_SCHEMA is built from
// strictObjects): any top-level field an action does not take must be
// refused BEFORE a mutation. The plugin adapters first parse the flat,
// host-exposed shape (which strips keys it does not declare), so the strict
// parser has to see the caller's ORIGINAL input — not the stripped copy — or
// an unknown field would silently pass. Both classes are covered on every
// surface: an unknown field (absent from the flat shape) and a known-but-
// inapplicable one (present in the flat shape, wrong for the action).
//
// Everything runs in disposable dirs: XDG_CONFIG_HOME is repointed per test
// and roster files live under a scratch dir; no real HOME state is touched.

type Outcome = { ok: boolean; text: string };
type Surface = { name: string; call(input: unknown): Promise<Outcome> };

let configHome: string;
let scratch: string;
let closers: Array<() => Promise<void>> = [];
const ORIGINAL_XDG = process.env["XDG_CONFIG_HOME"];

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "space-bus-strict-config-"));
  scratch = mkdtempSync(join(tmpdir(), "space-bus-strict-scratch-"));
  process.env["XDG_CONFIG_HOME"] = configHome;
});

afterEach(async () => {
  for (const close of closers) await close();
  closers = [];
  rmSync(configHome, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  if (ORIGINAL_XDG === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = ORIGINAL_XDG;
});

function writeRosterFile(name: string): string {
  const path = join(scratch, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      server: { baseUrl: "http://127.0.0.1:4096" },
      projects: [{ name: "svc", path: scratch, description: "service" }],
    }),
  );
  return path;
}

/** Every file under `root` -> content; any mutation anywhere shows up. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of readdirSync(root, { recursive: true }) as string[]) {
    const full = join(root, rel);
    // Open first, then fstat/read through the same fd: no check-then-use gap
    // between a stat and a later read. O_NOFOLLOW means a symlink swapped in
    // is never followed; it is recorded as its own entry so it still shows
    // up as a state change.
    let fd: number;
    try {
      fd = openSync(full, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ELOOP") {
        out[rel] = `symlink -> ${readlinkSync(full)}`;
        continue;
      }
      throw err;
    }
    try {
      if (fstatSync(fd).isFile()) out[rel] = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  }
  return out;
}

function state(): {
  config: Record<string, string>;
  scratch: Record<string, string>;
} {
  return { config: snapshot(configHome), scratch: snapshot(scratch) };
}

async function makeSurface(which: "v1" | "v2" | "mcp"): Promise<Surface> {
  if (which === "v1") {
    const v1Tools = (await plugin.server({ directory: scratch })).tool;
    return {
      name: "v1",
      async call(input) {
        try {
          const out = await v1Tools["bus_registry"]?.execute(
            input as never,
            {} as never,
          );
          return {
            ok: true,
            text: typeof out === "string" ? out : (out?.output ?? ""),
          };
        } catch (e) {
          return { ok: false, text: (e as Error).message };
        }
      },
    };
  }

  if (which === "v2") {
    type Added = {
      name: string;
      execute(input: unknown, ctx: unknown): Promise<{ content: string }>;
    };
    const added = new Map<string, Added>();
    await setupV2({
      location: { directory: scratch },
      tool: {
        async transform(cb: (editor: { add(t: Added): void }) => void) {
          cb({ add: (t) => added.set(t.name, t) });
          return { dispose: async () => {} };
        },
      },
    } as unknown as V2SetupContext);
    return {
      name: "v2",
      async call(input) {
        try {
          const out = await added.get("bus_registry")?.execute(input, {});
          return { ok: true, text: out?.content ?? "" };
        } catch (e) {
          return { ok: false, text: (e as Error).message };
        }
      },
    };
  }

  const { server } = await import("./mcp");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "strict-input-test", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return {
    name: "mcp",
    async call(input) {
      const result = await client.callTool({
        name: "bus_registry",
        arguments: input as Record<string, unknown>,
      });
      const text = (result.content as Array<{ text?: string }>)
        .map((c) => c.text ?? "")
        .join("\n");
      return { ok: result.isError !== true, text };
    },
  };
}

type MutatingCase = {
  action: string;
  /** Valid input; also registers whatever it needs via the paths given. */
  valid(paths: {
    base: string;
    other: string;
    created: string;
  }): Record<string, unknown>;
  /** A field the flat plugin shape declares but this action does not take. */
  inapplicable: Record<string, unknown>;
  inapplicableName: string;
};

const CASES: MutatingCase[] = [
  {
    action: "create",
    valid: (p) => ({
      action: "create",
      name: "made",
      path: p.created,
      server: { baseUrl: "http://127.0.0.1:4096" },
    }),
    inapplicable: { roster: "base" },
    inapplicableName: "roster",
  },
  {
    action: "register",
    valid: (p) => ({ action: "register", name: "other", path: p.other }),
    inapplicable: { projectName: "svc" },
    inapplicableName: "projectName",
  },
  {
    action: "unregister",
    valid: () => ({ action: "unregister", name: "base" }),
    inapplicable: { path: "/abs/elsewhere.json" },
    inapplicableName: "path",
  },
  {
    action: "set-default",
    valid: () => ({ action: "set-default", name: "base" }),
    inapplicable: { roster: "base" },
    inapplicableName: "roster",
  },
  {
    action: "add-project",
    valid: () => ({
      action: "add-project",
      roster: "base",
      project: { name: "added", path: scratch, description: "d" },
    }),
    inapplicable: { name: "stray" },
    inapplicableName: "name",
  },
  {
    action: "remove-project",
    valid: () => ({
      action: "remove-project",
      roster: "base",
      projectName: "svc",
    }),
    inapplicable: { path: "/abs/stray" },
    inapplicableName: "path",
  },
  {
    action: "update-project",
    valid: () => ({
      action: "update-project",
      roster: "base",
      projectName: "svc",
      patch: { description: "changed" },
    }),
    inapplicable: { server: { baseUrl: "http://127.0.0.1:4096" } },
    inapplicableName: "server",
  },
];

/** Registers `base` through the (valid) registry path so every case starts
 * from one disposable, populated registry + roster file. */
async function seed(surface: Surface): Promise<{
  base: string;
  other: string;
  created: string;
}> {
  const base = writeRosterFile("base");
  const other = writeRosterFile("other");
  const created = join(scratch, "created.json");
  const registered = await surface.call({
    action: "register",
    name: "base",
    path: base,
  });
  expect(registered.ok).toBe(true);
  return { base, other, created };
}

for (const surfaceName of ["v1", "v2", "mcp"] as const) {
  describe(`bus_registry strict input via ${surfaceName}`, () => {
    for (const c of CASES) {
      test(`${c.action}: valid control mutates state`, async () => {
        const surface = await makeSurface(surfaceName);
        const paths = await seed(surface);
        const before = state();
        const out = await surface.call(c.valid(paths));
        expect(out.ok).toBe(true);
        expect(state()).not.toEqual(before);
      });

      test(`${c.action}: an unknown top-level field is refused with state unchanged`, async () => {
        const surface = await makeSurface(surfaceName);
        const paths = await seed(surface);
        const before = state();
        const out = await surface.call({
          ...c.valid(paths),
          bogusField: "nope",
        });
        expect(out.ok).toBe(false);
        expect(out.text).toContain("bogusField");
        expect(state()).toEqual(before);
      });

      test(`${c.action}: a known-but-inapplicable field (${c.inapplicableName}) is refused with state unchanged`, async () => {
        const surface = await makeSurface(surfaceName);
        const paths = await seed(surface);
        const before = state();
        const out = await surface.call({
          ...c.valid(paths),
          ...c.inapplicable,
        });
        expect(out.ok).toBe(false);
        expect(out.text).toContain(c.inapplicableName);
        expect(state()).toEqual(before);
      });
    }
  });
}

// A rejected non-loopback `server.baseUrl` must never be reflected in the
// error on any surface: userinfo, query and fragment can all carry secrets.
// The sentinels below are fake. The error must stay actionable (localhost
// guidance) and the refusal must leave registry + scratch state untouched.
const LEAK_USERINFO = "fake-user:fake-pass-SENTINEL";
const LEAK_QUERY = "fake-query-token-SENTINEL";
const LEAK_FRAGMENT = "fake-fragment-SENTINEL";
const LEAKY_URLS = [
  `http://${LEAK_USERINFO}@evil.example:4096/p?token=${LEAK_QUERY}#${LEAK_FRAGMENT}`,
  `https://${LEAK_USERINFO}@evil.example/?token=${LEAK_QUERY}#${LEAK_FRAGMENT}`,
];
const LEAK_FRAGMENTS = [
  "fake-user",
  "fake-pass-SENTINEL",
  LEAK_QUERY,
  LEAK_FRAGMENT,
  "evil.example",
  "?token=",
];

function expectRedactedLocalhostError(text: string): void {
  for (const s of LEAK_FRAGMENTS) expect(text).not.toContain(s);
  expect(text).toContain("localhost");
  expect(text).toContain("refusing to send credentials off-machine");
}

for (const surfaceName of ["v1", "v2", "mcp"] as const) {
  describe(`bus_registry rejected baseUrl redaction via ${surfaceName}`, () => {
    for (const url of LEAKY_URLS) {
      test(`create with ${new URL(url).protocol} userinfo/query/fragment URL: redacted actionable error, state unchanged`, async () => {
        const surface = await makeSurface(surfaceName);
        const paths = await seed(surface);
        const before = state();
        const out = await surface.call({
          action: "create",
          name: "leaky",
          path: paths.created,
          server: { baseUrl: url },
        });
        expect(out.ok).toBe(false);
        expectRedactedLocalhostError(out.text);
        expect(state()).toEqual(before);
      });
    }
  });
}

// A real v2 host does more than call `execute`: when a tool's `input` carries a
// Standard Schema (`~standard`) it validates the model's arguments with it and
// forwards the validated VALUE. zod's `toJSONSchema` output carries a hidden,
// non-enumerable one whose validator strips unknown keys, so an unknown field
// would be gone before `bus_registry`'s strict parser ever saw it (observed on
// the pinned 2.3.2 host). This fake host reproduces that forwarding contract
// (validate via `~standard` when present, else forward as-is) so the registry
// definition is exercised the way the host calls it, not by calling `execute`
// directly.
describe("bus_registry strict input through host-style v2 forwarding", () => {
  type StandardResult = { value?: unknown; issues?: readonly unknown[] };
  type HostTool = {
    name: string;
    input: Record<string, unknown>;
    execute(input: unknown, ctx: unknown): Promise<{ content: string }>;
  };

  async function registryTool(): Promise<HostTool> {
    const added = new Map<string, HostTool>();
    await setupV2({
      location: { directory: scratch },
      tool: {
        async transform(cb: (editor: { add(t: HostTool): void }) => void) {
          cb({ add: (t) => added.set(t.name, t) });
          return { dispose: async () => {} };
        },
      },
    } as unknown as V2SetupContext);
    return added.get("bus_registry") as HostTool;
  }

  async function hostCall(tool: HostTool, value: unknown): Promise<Outcome> {
    const standard = (
      tool.input as {
        "~standard"?: {
          validate(v: unknown): StandardResult | Promise<StandardResult>;
        };
      }
    )["~standard"];
    let forwarded = value;
    if (standard) {
      const validated = await standard.validate(value);
      if (validated.issues) {
        return { ok: false, text: "host validation refused the arguments" };
      }
      forwarded = validated.value;
    }
    try {
      const out = await tool.execute(forwarded, {});
      return { ok: true, text: out.content };
    } catch (e) {
      return { ok: false, text: (e as Error).message };
    }
  }

  function registryDefault(): string | undefined {
    const file = join(configHome, "space-bus", "rosters.json");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      default?: string;
    };
    return parsed.default;
  }

  test("an unknown field is refused, state is unchanged, then the valid call mutates", async () => {
    const tool = await registryTool();
    const a = writeRosterFile("a");
    const b = writeRosterFile("b");
    expect(
      (await hostCall(tool, { action: "register", name: "a", path: a })).ok,
    ).toBe(true);
    expect(
      (await hostCall(tool, { action: "register", name: "b", path: b })).ok,
    ).toBe(true);
    expect(
      (await hostCall(tool, { action: "set-default", name: "a" })).ok,
    ).toBe(true);
    expect(registryDefault()).toBe("a");
    const before = state();

    const invalid = await hostCall(tool, {
      action: "set-default",
      name: "b",
      bogus: "x",
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.text).toContain("bogus");
    expect(registryDefault()).toBe("a");
    expect(state()).toEqual(before);

    // Known-but-inapplicable top-level field: same refusal, same state.
    const inapplicable = await hostCall(tool, {
      action: "set-default",
      name: "b",
      roster: "a",
    });
    expect(inapplicable.ok).toBe(false);
    expect(inapplicable.text).toContain("roster");
    expect(state()).toEqual(before);

    const valid = await hostCall(tool, { action: "set-default", name: "b" });
    expect(valid.ok).toBe(true);
    expect(registryDefault()).toBe("b");
    expect(state()).not.toEqual(before);
  });

  test("the visible schema is unchanged: plain JSON Schema data, no Standard Schema hook", async () => {
    const tool = await registryTool();
    expect("~standard" in tool.input).toBe(false);
    const { z } = await import("zod");
    const { makeBusRegistry } = await import("./tools/bus_registry");
    const expected = z.toJSONSchema(z.object(makeBusRegistry().args(z)), {
      io: "input",
    });
    expect(JSON.stringify(tool.input)).toBe(JSON.stringify(expected));
  });
});
