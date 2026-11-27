/**
 * OpenCode v1 adapter: the `server` entry. v1 hosts call it with the plugin
 * input and expect hooks back; we return only the `tool` map.
 *
 * SDK-free by construction: v1's `tool()` helper is an identity function, so
 * a v1 tool definition is just `{ description, args, execute }`. This module
 * imports NO host SDK -- neither runtime nor types -- and builds each tool's
 * `args` with the package's own zod.
 *
 * v1-only JSON Schema override (scratch candidate). A v1 host converts the
 * `args` it receives with ITS OWN bundled zod, which cannot read the limits of
 * fields built by this package's newer zod (the host reads `_zod.bag`; this
 * zod keeps them in `def.checks`), so `minItems`, `maxItems`, `minLength`,
 * `format`, ... would silently vanish from the schema the model sees. The
 * host consults `field._zod.toJSONSchema?.()` first, so each top-level field
 * gets a hook that serializes THAT field with this package's zod. The pattern
 * is the one in marcusrbrown/opencode-copilot-delegate v0.14.1
 * (src/lib/normalize-tool-arg-schemas.ts), restricted as follows:
 *
 *   - applied ONLY here, to fields built by a fresh `busTool.args(z)` call
 *     whose result is used only by the v1 definition returned below;
 *   - never applied in plugin-v2.ts, mcp.ts, or the runtime-validation path
 *     (`defineBusTool` calls `args(z)` again for its own schema), none of
 *     which ever receive these objects. (Variant: serializes with io:"input".) This package's own converter THROWS
 *     on a hooked field (zod 4.6.7 to-json-schema.js flattenRef), so a leaked
 *     hook would be loud, not silent.
 */
import { z } from "zod";
import { makeBusTools } from "./tools";
import type { BusToolResult } from "./tools/spec";

/** The slice of the v1 `PluginInput` we consume. */
export interface V1PluginInput {
  readonly directory: string;
}

/** Structural slice of v1's `ToolDefinition` we produce. */
export interface V1ToolDefinition {
  description: string;
  args: z.ZodRawShape;
  execute(args: unknown, ctx?: { directory?: string }): Promise<BusToolResult>;
}

export interface V1Hooks {
  tool: Record<string, V1ToolDefinition>;
}

interface JsonSchemaHookTarget {
  _zod?: { toJSONSchema?: () => unknown };
}

/**
 * Makes a v1 host's converter use THIS package's zod for one field. The hook
 * removes itself while it delegates (so the delegate does not re-enter it)
 * and restores itself in `finally`. A field that already has a hook is left
 * alone.
 */
function attachV1JsonSchemaHook(field: unknown): void {
  const internals = (field as JsonSchemaHookTarget)._zod;
  if (!internals || typeof internals.toJSONSchema === "function") return;
  internals.toJSONSchema = () => {
    const original = internals.toJSONSchema;
    delete internals.toJSONSchema;
    try {
      // io:"input" matches how a v1 host asks for tool parameters
      // (wr(.., {io:"input"}) in the v1.19.6 host), unlike the upstream
      // delegate's default (io:"output", which adds additionalProperties:false).
      const { $schema: _schema, ...rest } = z.toJSONSchema(field as z.ZodType, {
        io: "input",
      }) as Record<string, unknown>;
      return rest;
    } finally {
      internals.toJSONSchema = original;
    }
  };
}

export async function serverV1(input: V1PluginInput): Promise<V1Hooks> {
  const entries = makeBusTools(input.directory).map((busTool) => {
    // A NEW shape on every call: these objects belong to this v1 definition
    // alone (see the header).
    const args = busTool.args(z);
    for (const field of Object.values(args)) attachV1JsonSchemaHook(field);
    const definition: V1ToolDefinition = {
      description: busTool.description,
      args,
      // v1 passes the per-call directory in `ctx`; the instance directory is
      // the bound fallback inside `busTool.execute`.
      execute: (callArgs, ctx) => busTool.execute(callArgs, ctx),
    };
    return [busTool.name, definition] as const;
  });
  return { tool: Object.fromEntries(entries) };
}
