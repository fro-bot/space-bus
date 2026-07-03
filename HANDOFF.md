# HANDOFF — Build the Space Bus MVP

You are in `fro-bot/space-bus`, a scaffolded-but-unimplemented workspace agent bus for OpenCode. Your job is to implement the MVP in three phases, each with explicit verification. Requirements live in `docs/brainstorms/2026-07-02-space-bus-mvp-requirements.md` — read it first; it is authoritative for scope (R1–R11), acceptance examples, and non-goals. Also read `workspace.json`, `AGENTS.md`, and `package.json` before writing code.

## What this is

One `opencode serve` instance multiplexes all Fro Bot projects via per-request directory routing. A control agent (ordinary OpenCode TUI launched in this repo) delegates to per-project agents through four custom tools; a stdio MCP server exposes the same four tools to Claude Desktop. All logic lives in `src/core.ts`; the tool files and MCP server are thin adapters. Later conversion to a distributable plugin must be a packaging move, not a rewrite.

## Verified API facts (researched 2026-07-02, opencode v1.17.13)

Trust these as a starting map, but verify shapes against the live OpenAPI spec at `GET http://127.0.0.1:4096/doc` before coding against them — do not re-research the web.

- `opencode serve` defaults to `127.0.0.1:4096`. Auth: none by default; HTTP Basic when `OPENCODE_SERVER_PASSWORD` is set (username `opencode` unless `OPENCODE_SERVER_USERNAME` overrides).
- Per-request working directory resolves: session's stored directory → `?directory=` query param → `x-opencode-directory` header → server cwd. An InstanceStore lazily loads an isolated instance (config, plugins, AGENTS.md) per directory.
- Key endpoints: `POST /session` (body `{parentID?, title?}`), `GET /session`, `POST /session/:id/message` (waits for reply), `POST /session/:id/prompt_async` (fire-and-forget, 204), `POST /session/:id/abort`, `GET /session/:id/message`, `/session/:id/diff`, `/session/:id/todo`. SSE event stream at `GET /event` (and `/global/event`).
- SDK: `@opencode-ai/sdk` — `createOpencodeClient({ baseUrl })`, generated from the OpenAPI spec, versions lockstep with the CLI. Using the SDK client vs raw `fetch` is your call; raw fetch with a tiny typed wrapper may be simpler for header-based directory routing. Note the SDK also has `./v2` export paths (newer `/api/` surface) — prefer the stable v1 surface.
- Custom tools: files in `.opencode/tools/` (filename = tool name), `import { tool } from "@opencode-ai/plugin"`, export `tool({ description, args: { ... }, async execute(args, ctx) })`. `tool.schema` is Zod. `ctx` provides `{ agent, sessionID, messageID, directory, worktree }`. Tools run in OpenCode's Bun runtime; `fetch` to localhost is unrestricted.

## File layout to build

```
src/core.ts            # manifest zod-parse (~ expansion), typed API calls, auth header injection
.opencode/tools/bus_roster.ts
.opencode/tools/bus_task.ts
.opencode/tools/bus_status.ts
.opencode/tools/bus_result.ts   # each ~10-20 lines: parse args, call core, format result
src/mcp.ts             # stdio MCP server (@modelcontextprotocol/sdk), same four tools
scripts/smoke.ts       # Phase 0 spike, kept permanently as canary
```

## Phase 0 — Spike (do this before any src/ code)

`scripts/smoke.ts`, runnable via `bun run smoke` against a live `opencode serve --port 4096`:

1. For two different manifest projects: `POST /session` with `x-opencode-directory`, confirm the session binds to the right directory and picks up that repo's own config/AGENTS.md (e.g., ask the agent to state its working directory and any project-specific instruction it can see).
2. `prompt_async` a trivial task in each; poll for completion; fetch final message and diff.
3. Print PASS/FAIL per check with the failing response body on FAIL.

**Exit criteria:** cross-directory session creation, per-directory instance isolation, async prompt, and result retrieval all PASS. If isolation fails, STOP and report — the fallback (N servers, `{baseUrl, directory}` per project in core's types) changes Phase 1's shape and Marcus should decide.

## Phase 1 — Bus core + tools

1. `src/core.ts`: parse `workspace.json` with zod (fail fast, expand `~`), typed functions `roster()`, `dispatch(project, prompt)`, `status(sessionId)`, `result(sessionId)`. Discriminated unions for results (e.g., `{ok: true, ...} | {ok: false, error}`); parse, don't validate — API responses go through zod schemas at the boundary, derived from what `GET /doc` actually says.
2. The four `.opencode/tools/` adapters per R4–R7. Error behavior per R8/AE2: missing project path → immediate actionable error.
3. If `.opencode/tools/` files fail to resolve imports from repo-root `node_modules`, add `.opencode/package.json` (known open question — see requirements doc).

**Verification:** `bun run typecheck` clean; smoke script still PASS; then end-to-end through the LLM: launch `opencode` in this repo, ask the control agent to task `dashboard` with a trivial doc tweak and report the diff back. R5's contract (session ID returned before completion) must hold — confirm the ID appears in the control agent's reply before the delegated session finishes.

## Phase 2 — MCP facade

1. `src/mcp.ts` using `@modelcontextprotocol/sdk` stdio transport, registering the same four tools backed by core. No extra tools.
2. Provide the `claude_desktop_config.json` snippet in the README (command: `bun`, args: `["run", "/absolute/path/to/space-bus/src/mcp.ts"]` — note the absolute path caveat).

**Verification:** `npx @modelcontextprotocol/inspector bun run src/mcp.ts` (or manual JSON-RPC over stdio) shows all four tools and a working `bus_roster` round-trip. Full Claude Desktop test is Marcus's step; make it one config-paste away.

## Constraints

- Tool surface is exactly four. No broker, no queue, no custom RPC, no SSE consumer yet, no ACP, no `OPENCODE_EXPERIMENTAL_WORKSPACES`.
- Dependencies are already pinned in `package.json`; `@opencode-ai/*` stay lockstep with the installed CLI — if your local `opencode --version` differs from 1.17.13, align the pins to it and note that in your report. Add no other dependencies without asking.
- Security: talk only to `127.0.0.1`; Basic auth from `OPENCODE_SERVER_PASSWORD` when set (R3/AE3); never log credentials or prompt contents beyond what debugging strictly needs; zero telemetry.
- Style: TypeScript strict; infer over annotate; small files; no abstraction before the third use. Keep adapters dumb.
- Commit at each phase boundary with a message stating what was verified and how.

## Definition of done

All three phase verifications pass and are reproducible (`bun run smoke`, `bun run typecheck`, documented TUI + inspector steps). Update the README's Quick start with anything that turned out different from the plan, and list any deviations from R1–R11 explicitly. If something can't be verified in your environment (e.g., no Claude Desktop), say so and provide the exact manual step Marcus should run.
