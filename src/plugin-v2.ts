/**
 * OpenCode v2 adapter: the `setup` entry. v2 hosts call it once per plugin
 * instance with a context; tools are registered through a *replayable,
 * synchronous* `tool.transform` editor, with JSON Schema inputs and
 * `{ content, metadata? }` results.
 *
 * Host-free by construction: no `@opencode-ai/plugin` and no `@opencode/plugin`
 * import (the structural types below are the slice we consume). Everything
 * with a side effect — building tools, converting schemas — happens once in
 * `setupV2`; the transform callback only calls `editor.add`, because the host
 * replays it on every reload.
 */
import { z } from "zod";
import { makeBusTools } from "./tools";
import type { BusTool } from "./tools/spec";

/** Slice of the v2 `ToolEditor.add` definition we produce. */
export interface V2ToolDefinition {
  name: string;
  description: string;
  input: Record<string, unknown>;
  execute(
    input: unknown,
    context?: unknown,
  ): Promise<{ content: string; metadata?: Record<string, unknown> }>;
}

export interface V2ToolEditor {
  add(tool: V2ToolDefinition): void;
}

/** Slice of the v2 plugin `setup` context we consume. */
export interface V2SetupContext {
  /** The location this plugin instance is loaded for. */
  readonly location: { readonly directory: string };
  readonly tool: {
    transform(callback: (editor: V2ToolEditor) => void): Promise<unknown>;
  };
}

function inputSchema(busTool: BusTool): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(busTool.args(z)), { io: "input" });
  // zod attaches a hidden, non-enumerable Standard Schema (`~standard`) to its
  // JSON Schema output, and a v2 host that finds one validates the arguments
  // with it and forwards the validated value — whose validator strips unknown
  // keys. A tool with its own strict parser must see the original input, so
  // it gets a plain-data copy: identical when serialized, no validator hook.
  return busTool.strictInput ? JSON.parse(JSON.stringify(schema)) : schema;
}

export async function setupV2(ctx: V2SetupContext): Promise<void> {
  // The owning location, captured once: v2 tool executions carry a session
  // and message identity but no directory, and process.cwd() is the server's
  // launch directory. The target project's location is never the owner.
  const directory = ctx.location.directory;
  const definitions = makeBusTools(directory).map(
    (busTool): V2ToolDefinition => ({
      name: busTool.name,
      description: busTool.description,
      input: inputSchema(busTool),
      async execute(input) {
        // No per-call context: the bound location is the only directory.
        const result = await busTool.execute(input);
        return typeof result === "string"
          ? { content: result }
          : { content: result.output, metadata: result.metadata };
      },
    }),
  );
  await ctx.tool.transform((editor) => {
    for (const definition of definitions) editor.add(definition);
  });
}
