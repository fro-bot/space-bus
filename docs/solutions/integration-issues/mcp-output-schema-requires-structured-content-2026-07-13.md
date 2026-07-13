---
title: MCP tools with outputSchema must return structuredContent for every successful action
date: 2026-07-13
category: integration-issues
module: space-bus
problem_type: integration_issue
component: tooling
symptoms:
  - "successful non-list bus_registry mutations returned MCP error -32602"
  - "registry or session state changed even though the client saw an error"
  - "bus_registry list worked while the other actions failed"
root_cause: missing_validation
resolution_type: code_fix
severity: high
tags:
  - mcp
  - output-schema
  - structured-content
  - response-contract
  - bus-registry
  - sdk-validation
  - mutation-safety
  - transport-testing
---

# MCP tools with outputSchema must return structuredContent for every successful action

## Problem

In `@fro.bot/space-bus` 0.13.0, MCP `bus_registry` declared an `outputSchema`, but successful actions other than `list` returned text content without `structuredContent`. The pinned MCP SDK 1.29.0 rejected those responses after the action had run, so clients saw `-32602` even though the mutation succeeded.

This is dangerous for mutation tools: a connector may treat the reported failure as retryable, and a non-idempotent mutation could be applied more than once.

## Symptoms

- Successful `register`, `set-default`, and `use` calls returned `isError: true` with MCP error `-32602`.
- Registry or MCP-session state had already changed despite the reported error.
- `list` continued to work because it already returned `structuredContent: { rosters: [...] }`.
- Published 0.13.1 verification confirmed successful non-list actions return `structuredContent: {}` without `-32602`.

## What Didn't Work

- The MCP end-to-end coverage exercised `list`, the only action that already returned a conforming response envelope.
- Shared plugin/MCP parity tests covered descriptions and textual output, but not the MCP-specific response envelope.
- Plugin tests could not expose the defect because the plugin surface does not enforce MCP's `outputSchema`/`structuredContent` contract.
- Calling the handler directly would also miss SDK response validation. The regression must pass through a real SDK client and transport.

## Solution

Return `structuredContent` for every successful action. Populate it for `list`; return an empty object for other actions because the schema's `rosters` property is optional.

```ts
// Before: non-list actions omitted structuredContent.
return listMetadata
  ? {
      content: [{ type: "text", text }],
      structuredContent: { rosters: listMetadata },
    }
  : { content: [{ type: "text", text }] };
```

```ts
// After: every successful response satisfies the declared output schema.
return {
  content: [{ type: "text", text }],
  structuredContent: listMetadata ? { rosters: listMetadata } : {},
};
```

The regression test connects a real SDK `Client` to the production `McpServer` registration through linked in-memory transports:

```ts
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();

await Promise.all([
  client.connect(clientTransport),
  server.connect(serverTransport),
]);
```

It then checks both the protocol response and the resulting state:

```ts
const registerResult = await client.callTool({
  name: "bus_registry",
  arguments: { action: "register", name: "structured-content-fix", path },
});

expect(registerResult.isError).not.toBe(true);
expect(registerResult.structuredContent).toEqual({});

const listResult = await client.callTool({
  name: "bus_registry",
  arguments: { action: "list" },
});

expect(
  (
    listResult.structuredContent as {
      rosters?: Array<{
        name: string;
        path: string;
        default: boolean;
        active: boolean;
      }>;
    }
  ).rosters?.find((roster) => roster.name === "structured-content-fix"),
).toBeDefined();
```

Keep a negative control that preserves the old response shape and proves the SDK produces `-32602`:

```ts
controlServer.registerTool(
  "control_tool_omit",
  {
    inputSchema: { action: z.string() },
    outputSchema: {
      rosters: z.array(z.object({ name: z.string() })).optional(),
    },
  },
  async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
);

const result = await client.callTool({
  name: "control_tool_omit",
  arguments: { action: "register" },
});

expect(result.isError).toBe(true);
const firstContent = result.content[0];
if (firstContent?.type !== "text") {
  throw new Error("expected text error content");
}
expect(firstContent.text).toContain("-32602");
```

## Why This Works

`runBusRegistryAction` completes before its result is returned, so actions such as `register`, `set-default`, and `use` can mutate state before the SDK examines the response. With `outputSchema` declared, the pinned SDK 1.29.0 validates successful, non-error `CallToolResult` envelopes. Omitting `structuredContent` causes `-32602` after the handler has already run.

Returning `{}` satisfies the declared schema because `rosters` is optional. `list` keeps its structured roster data, while mutation actions retain their existing text output without being rejected after execution.

## Prevention

- Cover each response-envelope class: structured reads, successful mutations returning `{}`, and errors.
- Exercise production tool registration through a real SDK `Client` and linked transport instead of calling handlers directly.
- Keep a negative control that reproduces the invalid envelope and expected `-32602`.
- After a mutation call, assert both the protocol response and the resulting state.
- Treat plugin/MCP parity and MCP response-envelope conformance as separate contracts. Shared descriptions and text output do not prove protocol validity.
- Dogfood the published package, not only a source reference, before release acceptance.

## Related Issues

- [PR #95: fix(mcp): preserve successful registry mutations](https://github.com/fro-bot/space-bus/pull/95)
- [OpenCode plugin tool registration and directory scoping](../best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md)
- [Real subprocess tests for process lifecycle claims](../best-practices/real-subprocess-tests-for-process-lifecycle-claims-2026-07-10.md)
- [Source-ref dogfooding can mask packaged-artifact failures](../workflow-issues/source-ref-dogfooding-can-mask-packaged-artifact-failures-2026-07-11.md)
