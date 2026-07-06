---
title: Sharing an on-disk contract across a browser/Node boundary without drift
date: 2026-07-05
category: docs/solutions/best-practices/
module: space-bus
problem_type: best_practice
component: tooling
severity: medium
applies_when:
  - an on-disk contract (file path derivation or file schema) must be read from both a browser-safe module and a Node-only module
  - the browser-safe side cannot import the Node module that owns the convention (no node:* allowed)
  - two implementations of one convention must stay byte-identical or a consumer silently reads the wrong path
tags:
  - browser-safe
  - discovery-file
  - node-browser-boundary
  - parity-test
  - browser-safety
  - codeql-redos
---

# Sharing an on-disk contract across a browser/Node boundary without drift

## Context

`@fro.bot/space-bus/attach` (`src/attach.ts`) lets an external attacher — a Mothership Tauri webview — resolve the managed bus server's discovery file with zero `node:*` imports. The discovery file's *location* is a convention: `sha256(canonical roster path)` first 16 hex, under `$XDG_STATE_HOME` | `~/.local/state`, as `space-bus/<hash>/discovery.json`.

That convention is owned by the Node-only `src/discovery.ts` (`node:crypto`, `node:path`, `node:os`). A browser/webview cannot import those. So the browser-safe attacher **reimplements the same convention** — Web Crypto for the hash, a hand-rolled `posixJoin`, and injected filesystem/env/home "seams." The result is two implementations of one on-disk contract. If they diverge by a single character, the attacher reads the wrong path and reports "server not running" against a live daemon — a failure that looks like liveness but is really a path mismatch.

## Guidance

You cannot share the *code* across the browser-safety boundary. Share what you can, and pin the rest with a test. Three guards, used together:

1. **Parity test** — pin the browser reimplementation's output to the Node owner's output. The test runs in Node, so it can import both and assert equality across sample inputs. This is the guard that actually stops drift.
2. **Shared schema in a browser-safe module** — move the on-disk *shape* (the zod `discoveryFileSchema`) into a zod-only, browser-safe module (`contract.ts`) that both sides import. The data shape then has one source of truth even though the path derivation is duplicated. Re-export from the Node module so its existing importers don't change.
3. **CI browser-safety guard on the new module** — bundle the browser-safe module for a browser target with `node:*` resolution forbidden, negative-controlled. Without this, a future edit can add a `node:` import and pass every other check.

Keep the browser module node-free by injecting **seams** and using browser-native primitives (`crypto.subtle.digest`, `btoa`) instead of `node:crypto`:

```ts
export interface AttachSeams {
  realpath(path: string): Promise<string | null>;
  readTextFile(path: string): Promise<string | null>;
  env(name: string): Promise<string | null>;
  homeDir(): Promise<string>;
}

async function discoveryPathFor(rosterPath: string, seams: AttachSeams): Promise<string> {
  const xdgStateHome = await seams.env("XDG_STATE_HOME");
  const base = xdgStateHome ?? posixJoin(await seams.homeDir(), ".local", "state");
  const hash = await sha256Hex16(rosterPath); // crypto.subtle, not node:crypto
  return posixJoin(base, "space-bus", hash, "discovery.json");
}
```

## Why This Matters

Two implementations of one convention *will* drift — someone changes the hash length, the state-dir name, the file name, or the `~` expansion rule in one place and forgets the other. The failure is silent and ugly: the attacher computes a different path than the daemon wrote, finds no file, and reports "not running" for a server that is up. Nothing errors; the two sides just quietly disagree. The parity test converts that latent, undebuggable drift into a red CI run the moment the convention changes on either side.

## When to Apply

Any time a browser-safe module and a Node module must agree on an on-disk contract that can't be shared as code across the boundary:

- file **path** derivation (hashing, XDG/home resolution, path joining)
- file **shape** (the parsed schema)
- adjacent rules that both sides enforce (loopback/auth guards)

Especially when the browser-safe side cannot import the Node owner of the convention.

## Examples

**Parity test** (Node-side test importing both implementations):

```ts
// attach's computed discovery path must equal discovery.ts's, exactly
expect(readPaths[0]).toBe(discoveryFilePath(rosterPath));
```

**Shared schema moved to the browser-safe module** — `src/contract.ts` (zod-only) owns it:

```ts
export const discoveryFileSchema = z.object({
  port: z.number().int().nonnegative(),
  pid: z.number().int().positive(),
  identity: z.string(),
  password: z.string(),
  spawnConfig: managedSpawnConfigSchema,
  baseUrl: z.url(),
});
```

`src/discovery.ts` re-exports it, so Node importers (`config.ts`, `server.ts`) are untouched:

```ts
export { discoveryFileSchema, managedSpawnConfigSchema };
```

The shared loopback guard lives there too, so both sides check identically:

```ts
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
export function loopbackOk(baseUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}
```

**ReDoS gotcha** — you can't use `node:path` in a browser-safe module, so path helpers get hand-rolled. Backtracking slash-strip regexes tripped CodeQL `js/polynomial-redos` (2 high):

```ts
// before — /\/+$/ and /^\/+/ backtrack O(n^2) on a long slash run
if (i === 0) return p.replace(/\/+$/, "");
return p.replace(/^\/+/, "").replace(/\/+$/, "");
```

```ts
// after — split("/"), no regex, byte-identical semantics
export function posixJoin(...parts: string[]): string {
  const isAbsolute = (parts[0] ?? "").startsWith("/");
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of part.split("/")) {
      if (segment.length > 0) segments.push(segment);
    }
  }
  const joined = segments.join("/");
  return isAbsolute ? `/${joined}` : joined;
}
```

**Operational note — verifying a CodeQL fix on a PR.** Query the alert state by PR ref, not by alert number on the branch head:

```sh
gh api "repos/OWNER/REPO/code-scanning/alerts?pr=N" \
  --jq '[.[] | {number, rule: .rule.id, state}]'
```

After the fix push, the alert state flips to `"fixed"` there. Querying by alert number against the branch head can return `state: null` — that is ref-scoping, **not** "still open." Confirm via the `?pr=N` query and the CodeQL check conclusion.

## Related

- [browser-safe-library-boundary-cut-2026-07-04.md](./browser-safe-library-boundary-cut-2026-07-04.md) — the companion pattern: making a *single* module browser-safe (injected context, guards traveling to the consuming boundary, the Bun browser-target silent-stub testing trap). This doc is its cross-boundary sequel: keeping *two* modules that span the boundary in lockstep.
- [managed-server-lifecycle-first-caller-spawns-2026-07-05.md](./managed-server-lifecycle-first-caller-spawns-2026-07-05.md) — the **writer-side companion**: the lifecycle that spawns the daemon and writes the discovery file this module reads (first-caller-spawns, spawn lock, pid identity, stop escalation, credential redaction).
- [test-isolation-xdg-state-home-2026-07-05.md](./test-isolation-xdg-state-home-2026-07-05.md) — isolating this same `XDG_STATE_HOME`-based path convention in tests so they don't leak state into the real home.
- [opencode-plugin-tool-registration-directory-scoping-2026-07-03.md](../best-practices/opencode-plugin-tool-registration-directory-scoping-2026-07-03.md) — `ctx.directory` vs cwd; the roster-path form that feeds this discovery-path hash.
