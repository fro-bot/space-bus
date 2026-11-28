/**
 * Host-neutral tool definition shared by the plugin adapters (v1 `server`,
 * v2 `setup`) — see plugin-v1.ts / plugin-v2.ts. Nothing here may import a
 * host SDK: both adapters must work without a peer on their resolution path.
 *
 * A tool is its name, its description, a builder for its argument shape, and
 * one `execute`. The shape is a *builder* (`args(z)`) rather than a value
 * so v1 can customize serialization on fresh fields without changing the
 * schemas used by v2 or by execution-time validation.
 */
import { z } from "zod";

export type ZodNamespace = typeof z;

/** What a tool returns: bare text, or text plus machine-readable metadata
 * (the v1 plugin `ToolResult` shape; v2 adapts it to `{content, metadata}`). */
export type BusToolResult =
  | string
  | { output: string; metadata?: Record<string, unknown> };

/** Per-call context. Only the per-call directory is consumed — v1 hosts pass
 * it, v2 hosts do not (the v2 adapter owns directory resolution). */
export interface BusToolCallContext {
  readonly directory?: string | undefined;
}

export interface BusTool {
  readonly name: string;
  readonly description: string;
  /**
   * Set when the tool owns a parser stricter than the flat shape it shows
   * hosts (bus_registry). A host that validates through a Standard Schema
   * would strip keys before `execute`, so an adapter must hand such a host
   * plain JSON Schema data and leave all validation to `execute`.
   */
  readonly strictInput?: true;
  /** Builds the argument shape with the supplied zod namespace. */
  args(zod: ZodNamespace): z.ZodRawShape;
  /**
   * Validates `input` against the same shape (including refinements JSON
   * Schema cannot express), then runs. Throws on invalid input or any
   * `ok:false` underneath — never returns an error value.
   */
  execute(input: unknown, ctx?: BusToolCallContext): Promise<BusToolResult>;
}

type ToolDefinition<Shape extends z.ZodRawShape> = {
  name: string;
  description: string;
  args: (zod: ZodNamespace) => Shape;
  strictInput?: true;
  /** Directory used when the call carries none (v1 instance / v2 location). */
  defaultDirectory?: string | undefined;
  /**
   * `args` is the parsed (unknown keys stripped) copy; `input` is the
   * caller's original value, for a tool that owns a stricter parser than
   * the flat shape it exposes to hosts (bus_registry).
   */
  run(
    args: z.infer<z.ZodObject<Shape>>,
    directory: string | undefined,
    input: unknown,
  ): Promise<BusToolResult>;
};

export function defineBusTool<Shape extends z.ZodRawShape>(
  def: ToolDefinition<Shape>,
): BusTool {
  let schema: z.ZodObject<Shape> | undefined;
  return {
    name: def.name,
    description: def.description,
    ...(def.strictInput ? { strictInput: def.strictInput } : {}),
    args: def.args,
    async execute(input, ctx) {
      schema ??= z.object(def.args(z));
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        const where =
          issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        throw new Error(
          `${def.name}: invalid input — ${where}${issue?.message ?? parsed.error.message}`,
        );
      }
      return def.run(
        parsed.data,
        ctx?.directory ?? def.defaultDirectory,
        input,
      );
    },
  };
}
