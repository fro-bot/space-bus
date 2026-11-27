import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tool as hostSdk } from "@opencode-ai/plugin";
import { z } from "zod";
import { serverV1 } from "./plugin-v1";
import { setupV2, type V2SetupContext } from "./plugin-v2";
import { makeBusTools } from "./tools";
import { ACTION_SCHEMA } from "./tools/bus_registry";

// The v1 adapter has to do two things at once:
//  1. depend on NO host SDK, at runtime or in types (a v2-only install has no
//     `@opencode-ai/plugin`, and a v1 install only has it in the host's own
//     config dir, never beside the plugin), and
//  2. still give a v1 host a precise JSON Schema. A v1 host converts a tool's
//     `args` with ITS bundled zod (4.1.x), which reads limits from
//     `_zod.bag`; this package's zod (4.6.x) keeps them in `def.checks`, so
//     without help every limit (minItems, maxItems, minLength, format,
//     integer bounds, exclusiveMinimum) and nothing else would be lost on v1.
//     The adapter therefore hooks each top-level field it builds so the host's
//     converter asks THIS package's zod for that field.
//
// `hostZ` below is the zod bundled in the pinned host SDK (dev dependency), the
// same module a v1 host converts with.
const hostZ = hostSdk.schema;
const DIRECTORY = "/tmp/space-bus-v1-test";
const srcDir = import.meta.dir;

// biome-ignore lint/suspicious/noExplicitAny: schema internals are inspected by design
type Any = any;
type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 1. No runtime or type dependency on the optional host SDK
// ---------------------------------------------------------------------------

/** True when `code` names the host SDK as an import / type-import / `import()` target. */
function referencesHostSdk(code: string): boolean {
  return /["']@opencode-ai\/plugin(?:\/[^"']*)?["']/.test(code);
}

/** Relative-import closure of `entry` (static, type-only and dynamic imports). */
function localImportClosure(entry: string): Map<string, string> {
  const files = new Map<string, string>();
  const queue = [entry];
  const spec = /(?:from\s*|import\s*\(\s*|import\s+)["'](\.{1,2}\/[^"']+)["']/g;
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    const code = readFileSync(file, "utf8");
    files.set(file, code);
    for (const m of code.matchAll(spec)) {
      const base = resolve(dirname(file), m[1] as string);
      const next = [`${base}.ts`, join(base, "index.ts")].find(existsSync);
      if (next) queue.push(next);
    }
  }
  return files;
}

describe("v1 adapter has no dependency on the optional host SDK", () => {
  test("detector: flags every way of naming the SDK, ignores unrelated code", () => {
    expect(
      referencesHostSdk(`import { tool } from "@opencode-ai/plugin";`),
    ).toBe(true);
    expect(
      referencesHostSdk(
        `import type { ToolDefinition } from '@opencode-ai/plugin';`,
      ),
    ).toBe(true);
    expect(
      referencesHostSdk(`type A = typeof import("@opencode-ai/plugin").tool;`),
    ).toBe(true);
    expect(
      referencesHostSdk(
        `const { tool } = await import("@opencode-ai/plugin");`,
      ),
    ).toBe(true);
    expect(
      referencesHostSdk(`import { tool } from "@opencode-ai/plugin/tool";`),
    ).toBe(true);
    expect(
      referencesHostSdk(`import { z } from "zod"; // @opencode-ai/plugin`),
    ).toBe(false);
    expect(referencesHostSdk(`import { makeBusTools } from "./tools";`)).toBe(
      false,
    );
  });

  test("traversal sanity: the closure of plugin-v1.ts reaches the tool definitions", () => {
    const closure = localImportClosure(join(srcDir, "plugin-v1.ts"));
    const names = [...closure.keys()].map((f) => f.replace(`${srcDir}/`, ""));
    expect(names).toContain("plugin-v1.ts");
    expect(names).toContain("tools/index.ts");
    expect(names).toContain("tools/spec.ts");
    expect(names).toContain("tools/bus_wait.ts");
    expect(closure.size).toBeGreaterThan(6);
  });

  test("no file reachable from plugin-v1.ts names the host SDK (runtime, type-only or dynamic)", () => {
    const offenders = [...localImportClosure(join(srcDir, "plugin-v1.ts"))]
      .filter(([, code]) => referencesHostSdk(code))
      .map(([file]) => file.replace(`${srcDir}/`, ""));
    expect(offenders).toEqual([]);
  });

  test("serverV1 returns six tool definitions without touching any host module", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    expect(Object.keys(hooks.tool).sort()).toEqual([
      "bus_registry",
      "bus_result",
      "bus_roster",
      "bus_status",
      "bus_task",
      "bus_wait",
    ]);
    for (const def of Object.values(hooks.tool)) {
      expect(typeof def.description).toBe("string");
      expect(typeof def.execute).toBe("function");
      expect(Object.keys(def.args).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. What a v1 host produces (host zod converter over our args)
// ---------------------------------------------------------------------------

/** Mirrors the v1 host: wrap the args in ITS z.object, convert with ITS converter, io:"input". */
function hostConvert(args: z.ZodRawShape): Json {
  return hostZ.toJSONSchema(hostZ.object(args as Any), { io: "input" }) as Json;
}
function packageConvert(args: z.ZodRawShape): Json {
  return z.toJSONSchema(z.object(args), { io: "input" }) as Json;
}
const withoutRootSchema = (j: Json): Json => {
  const { $schema: _s, ...rest } = j;
  return rest;
};
const prop = (j: Json, ...path: string[]): Json => {
  let cur: Json = j;
  for (const key of path)
    cur = ((cur["properties"] as Json)[key] ?? {}) as Json;
  return cur;
};

describe("v1 host-converted input schema keeps every limit and description", () => {
  test("host conversion of each v1 definition equals the package's own conversion (the v2 shape), descriptions included", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    for (const [name, def] of Object.entries(hooks.tool)) {
      const viaHost = withoutRootSchema(hostConvert(def.args));
      const viaPackage = withoutRootSchema(
        packageConvert(
          makeBusTools(DIRECTORY)
            .find((t) => t.name === name)
            ?.args(z) ?? {},
        ),
      );
      expect(viaHost).toEqual(viaPackage);
    }
  });

  test("bus_wait: sessionIds keeps minItems 1 / maxItems 100, timeoutMs keeps exclusiveMinimum 0, descriptions survive", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    const json = hostConvert(hooks.tool["bus_wait"]?.args ?? {});
    const ids = prop(json, "sessionIds");
    expect(ids["type"]).toBe("array");
    expect(ids["minItems"]).toBe(1);
    expect(ids["maxItems"]).toBe(100);
    expect(ids["description"]).toBe(
      "Session IDs to watch (returned by bus_task)",
    );
    expect(prop(json, "timeoutMs")["exclusiveMinimum"]).toBe(0);
    expect(typeof prop(json, "timeoutMs")["description"]).toBe("string");
    expect(typeof prop(json, "roster")["description"]).toBe("string");
  });

  test("bus_registry: nested limits kept (minLength, uri format, integer bounds) and nested objects carry NO additionalProperties", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    const json = hostConvert(hooks.tool["bus_registry"]?.args ?? {});
    // nested string limits
    expect(prop(json, "patch", "name")["minLength"]).toBe(1);
    expect(prop(json, "patch", "path")["minLength"]).toBe(1);
    expect(prop(json, "project", "name")["minLength"]).toBe(1);
    expect(prop(json, "project", "path")["minLength"]).toBe(1);
    // format + integer bounds two levels down
    expect(prop(json, "server", "baseUrl")["format"]).toBe("uri");
    const port = prop(json, "server", "managed", "port");
    expect(port["type"]).toBe("integer");
    expect(port["minimum"]).toBe(0);
    expect(port["maximum"]).toBe(Number.MAX_SAFE_INTEGER);
    // io:"input" is what a v1 host asks for; the default io would add
    // additionalProperties:false to every nested object.
    for (const obj of [
      prop(json, "patch"),
      prop(json, "project"),
      prop(json, "server"),
      prop(json, "server", "managed"),
    ]) {
      expect(obj["type"]).toBe("object");
      expect("additionalProperties" in obj).toBe(false);
    }
    expect("additionalProperties" in json).toBe(false);
  });

  test("hook output carries no root $schema on any field", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    for (const def of Object.values(hooks.tool)) {
      for (const field of Object.values(def.args) as Any[]) {
        const out = field._zod.toJSONSchema() as Json;
        expect("$schema" in out).toBe(false);
      }
    }
  });

  test("negative control: the same host conversion WITHOUT the hook loses the limits (the test discriminates)", () => {
    // Fresh package-zod fields, no hook: exactly what a bare SDK-free adapter would hand the host.
    const bare =
      makeBusTools(DIRECTORY)
        .find((t) => t.name === "bus_wait")
        ?.args(z) ?? {};
    const json = hostConvert(bare);
    expect(prop(json, "sessionIds")["minItems"]).toBeUndefined();
    expect(prop(json, "sessionIds")["maxItems"]).toBeUndefined();
    const reg = hostConvert(
      makeBusTools(DIRECTORY)
        .find((t) => t.name === "bus_registry")
        ?.args(z) ?? {},
    );
    expect(prop(reg, "server", "baseUrl")["format"]).toBeUndefined();
    expect(prop(reg, "patch", "name")["minLength"]).toBeUndefined();
  });

  test("negative control: removing the hook from one field drops only that field's limits", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    const args = { ...hooks.tool["bus_wait"]?.args } as Record<string, Any>;
    const field = args["sessionIds"];
    const hook = field._zod.toJSONSchema;
    try {
      delete field._zod.toJSONSchema;
      const json = hostConvert(args as z.ZodRawShape);
      expect(prop(json, "sessionIds")["minItems"]).toBeUndefined();
      expect(prop(json, "timeoutMs")["exclusiveMinimum"]).toBe(0);
    } finally {
      field._zod.toJSONSchema = hook;
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Hook isolation and replay across v1 / v2 / MCP / runtime validation
// ---------------------------------------------------------------------------

/** Every zod schema or check object reachable from `root` (through `_zod.def`). */
function reachable(root: unknown): Set<object> {
  const seen = new Set<object>();
  const out = new Set<object>();
  const walk = (v: unknown, depth: number): void => {
    if (typeof v !== "object" || v === null || depth > 60 || seen.has(v))
      return;
    seen.add(v);
    if ("_zod" in v) {
      out.add(v);
      walk((v as Any)._zod.def, depth + 1);
      return;
    }
    for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, depth + 1);
  };
  walk(root, 0);
  return out;
}
const hookOf = (o: object): unknown => (o as Any)._zod?.toJSONSchema;
const hooked = (set: Set<object>) =>
  [...set].filter((o) => typeof hookOf(o) === "function");

async function v2Inputs(): Promise<Record<string, string>> {
  const callbacks: Array<
    (editor: { add(t: { name: string; input: unknown }): void }) => void
  > = [];
  const ctx = {
    location: { directory: DIRECTORY },
    tool: {
      async transform(cb: (typeof callbacks)[number]) {
        callbacks.push(cb);
        return { dispose: async () => {} };
      },
    },
  } as unknown as V2SetupContext;
  await setupV2(ctx);
  const got: Record<string, string> = {};
  // The host replays every registered transform; do it twice.
  for (let round = 0; round < 2; round++)
    for (const cb of callbacks)
      cb({
        add: (t) => {
          got[t.name] = JSON.stringify(t.input);
        },
      });
  return got;
}

describe("the v1 hook is isolated to the v1 definitions it was built for", () => {
  test("args(z) builds disjoint schema objects on every call and none carries a hook beforehand", () => {
    for (const t of makeBusTools(DIRECTORY)) {
      const a = reachable(t.args(z));
      const b = reachable(t.args(z));
      expect([...a].filter((o) => b.has(o))).toEqual([]);
      expect(hooked(a)).toEqual([]);
    }
  });

  test("exactly the top-level fields of the v1 definitions are hooked; nothing nested, no top-level field nested in another", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    let top = 0;
    for (const def of Object.values(hooks.tool)) {
      const fields = Object.values(def.args) as object[];
      top += fields.length;
      const topSet = new Set(fields);
      expect(topSet.size).toBe(fields.length);
      for (const f of fields) {
        expect(typeof hookOf(f)).toBe("function");
        for (const o of reachable(f)) {
          if (o === f) continue;
          expect(topSet.has(o)).toBe(false);
          expect(typeof hookOf(o)).not.toBe("function");
        }
      }
    }
    expect(top).toBe(22);
  });

  test("two serverV1 calls share no schema objects, and builders used afterwards share nothing with either and carry no hook", async () => {
    const one = await serverV1({ directory: DIRECTORY });
    const two = await serverV1({ directory: DIRECTORY });
    const objs = (h: typeof one) =>
      new Set(Object.values(h.tool).flatMap((d) => [...reachable(d.args)]));
    const a = objs(one);
    const b = objs(two);
    expect([...a].filter((o) => b.has(o))).toEqual([]);
    for (const t of makeBusTools(DIRECTORY)) {
      const later = reachable(t.args(z));
      expect(hooked(later)).toEqual([]);
      expect([...later].some((o) => a.has(o) || b.has(o))).toBe(false);
    }
  });

  test("v2 tool inputs are identical before and after the v1 adapter ran, over repeated host replays", async () => {
    const before = await v2Inputs();
    await serverV1({ directory: DIRECTORY });
    const after = await v2Inputs();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(after).toEqual(before);
  });

  test("MCP's bus_registry ACTION_SCHEMA is unaffected: no hook reachable, conversion identical", async () => {
    const before = JSON.stringify(z.toJSONSchema(ACTION_SCHEMA));
    await serverV1({ directory: DIRECTORY });
    expect(hooked(reachable(ACTION_SCHEMA))).toEqual([]);
    expect(JSON.stringify(z.toJSONSchema(ACTION_SCHEMA))).toBe(before);
  });

  test("replay: converting a v1 definition repeatedly leaves every hook restored and the output unchanged", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    for (const def of Object.values(hooks.tool)) {
      const fields = Object.values(def.args) as Any[];
      const installed = fields.map((f) => f._zod.toJSONSchema);
      const first = JSON.stringify(hostConvert(def.args));
      const second = JSON.stringify(hostConvert(def.args));
      expect(second).toBe(first);
      expect(fields.map((f) => f._zod.toJSONSchema)).toEqual(installed);
    }
  });

  test("negative control: this package's own converter throws on a hooked field, so a leak into v2 / MCP / runtime could not be silent", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    const field = Object.values(
      hooks.tool["bus_wait"]?.args ?? {},
    )[0] as z.ZodType;
    expect(() => z.toJSONSchema(z.object({ x: field }))).toThrow();
  });
});

describe("required bounds are still rejected at execution", () => {
  const manyIds = Array.from({ length: 101 }, (_, i) => `ses_${i}`);
  const cases: Array<[string, Json, RegExp]> = [
    ["bus_wait", { sessionIds: [] }, /at least one sessionId/],
    ["bus_wait", { sessionIds: manyIds }, /at most 100 sessionIds/],
    [
      "bus_wait",
      { sessionIds: ["ses_1"], timeoutMs: 0 },
      /bus_wait: invalid input/,
    ],
    [
      "bus_registry",
      {
        action: "create",
        name: "n",
        path: "/abs/spacebus.json",
        server: { baseUrl: "http://127.0.0.1:1", managed: {} },
      },
      /exactly one of `baseUrl` or `managed`/,
    ],
    [
      "bus_registry",
      { action: "update-project", roster: "r", projectName: "p", patch: {} },
      /at least one field/,
    ],
  ];

  for (const [tool, input, message] of cases) {
    test(`${tool} ${JSON.stringify(input).slice(0, 60)} is rejected before any I/O`, async () => {
      const hooks = await serverV1({ directory: DIRECTORY });
      await expect(hooks.tool[tool]?.execute(input)).rejects.toThrow(message);
    });
  }

  test("the hooked fields parse valid input and reject sessionIds=[] under both the package's and the host's zod wrapper", async () => {
    const hooks = await serverV1({ directory: DIRECTORY });
    const args = hooks.tool["bus_wait"]?.args as z.ZodRawShape;
    const ok = { sessionIds: ["ses_1"] };
    type Parser = { safeParse(value: unknown): { success: boolean } };
    const wrappers: Parser[] = [
      z.object(args) as Parser,
      hostZ.object(args as Any) as Parser,
    ];
    for (const wrapper of wrappers) {
      expect(wrapper.safeParse(ok).success).toBe(true);
      expect(wrapper.safeParse({ sessionIds: [] }).success).toBe(false);
      expect(
        wrapper.safeParse({ sessionIds: ["ses_1"], timeoutMs: 0 }).success,
      ).toBe(false);
    }
  });
});
