---
date: 2026-07-02
topic: space-bus-mvp
---

# Space Bus MVP — OpenCode Workspace Agent Bus

## Summary

Build a workspace agent bus as a set of four OpenCode custom tools plus a stdio MCP facade, all backed by one shared core module. A control agent running an ordinary OpenCode TUI in this repo tasks dedicated agents in each Fro Bot project through a single `opencode serve` instance, using per-request directory routing. Claude Desktop gets the same four tools over MCP. Dogfood as a workspace-local tool first; plugin packaging comes later.

---

## Problem Frame

Fro Bot spans four repos — `fro-bot/agent` (runtime + gateway + Discord), `fro-bot/dashboard` (React + Vite PWA), `fro-bot/.github` (control plane + autoresearch loop), and `marcusrbrown/infra` (IaC). Coordinated changes across them currently pass messages through GitHub issues: slow, lossy, and manual. There is no way to sit in one agent session and delegate scoped work to the right project, watch its progress, and collect the result.

This brainstorm is inherently technical: the architectural decisions (protocol choice, process topology, tool surface) are its subject, so implementation detail below is deliberate rather than leakage.

---

## Requirements

**Bus core (`src/core.ts`)**

- R1. Load and schema-parse `workspace.json` at startup; fail fast with a precise error on an invalid manifest. Expand `~` in project paths.
- R2. Provide typed calls to the OpenCode server API — create session, dispatch prompt async, query status, fetch messages and diff — each scoped to a target project via the `x-opencode-directory` header.
- R3. When `OPENCODE_SERVER_PASSWORD` is set, send HTTP Basic auth on every request.

**Bus tools (`.opencode/tools/`)**

- R4. `bus_roster` lists manifest projects with live session status per project.
- R5. `bus_task` creates a session in the target project, dispatches the prompt fire-and-forget, and returns the session ID without waiting for completion.
- R6. `bus_status` reports a session's status plus a summary of its latest todo and diff.
- R7. `bus_result` returns a completed session's final assistant message and diff.
- R8. When a manifest project's path does not exist on disk, bus tools fail immediately with an error naming the missing path.

**Control agent**

- R9. `AGENTS.md` constrains the control agent to delegation: its only write path into sibling projects is `bus_task`, and it reports session IDs for every dispatch.

**MCP facade (`src/mcp.ts`)**

- R10. A stdio MCP server exposes the same four tools backed by the same core, registerable in Claude Desktop's config file.

**Security**

- R11. The bus talks only to `127.0.0.1`; credentials come only from the environment; nothing is logged or transmitted off-machine.

---

## Acceptance Examples

- AE1. **Covers R5.** Given `opencode serve` running and `dashboard` in the manifest, when the control agent calls `bus_task("dashboard", ...)`, a session bound to the dashboard directory exists and its ID is returned before the delegated work finishes.
- AE2. **Covers R8.** Given a manifest entry whose path is absent on disk, when any bus tool targets it, the tool returns an error naming that path rather than hanging or creating a session in the wrong directory.
- AE3. **Covers R3.** Given `OPENCODE_SERVER_PASSWORD` is set and the server requires it, when `bus_roster` runs, requests authenticate and succeed; when it is unset against an open server, requests succeed without auth headers.
- AE4. **Covers R10.** Given the MCP server registered in Claude Desktop, when the user asks "what's on the bus?", the roster lists all four projects.

---

## Success Criteria

- From the control TUI, delegating a small doc change to `dashboard` and getting the diff summarized back works end-to-end through the LLM — not just via curl.
- From Claude Desktop, listing the roster, delegating a task to `infra`, and retrieving its result works over MCP.
- The Phase 0 smoke script (`scripts/smoke.ts`) passes and is retained as a canary against directory-routing regressions.
- Converting the MVP into a distributable plugin later is a packaging move, not a rewrite — all logic sits in `src/core.ts`, adapters stay thin.

---

## Scope Boundaries

- No message broker, queue, or custom RPC/state layer — the server API is the state store.
- No plugin packaging or npm publish yet; dogfood the workspace-local form first.
- No ACP — it re-enters at the bespoke-UI (Monaco) phase, not here.
- No use of `OPENCODE_EXPERIMENTAL_WORKSPACES` — directory routing is the stable primitive.
- No supervisor daemon, SSE fan-in service, or cross-machine transport (Phase 3 territory).
- Tool surface stays at four; resist growth until dogfooding demands it.

---

## Key Decisions

- One server, N directories: a single `opencode serve` multiplexes projects via per-request directory resolution (session dir → `?directory=` → `x-opencode-directory` → cwd) with isolated per-directory instances. Fallback if isolation leaks: N servers — core takes `{baseUrl, directory}` per project so the fallback is config, not a rewrite.
- Bus = manifest + four tools, not a broker: the HTTP API already provides sessions, async prompting, status, diff, and SSE events.
- Control plane = a plain OpenCode TUI in this directory; no new UI.
- HTTP API over ACP for orchestration: ACP lacks cross-session enumeration and a global event bus.
- Build the MCP facade rather than adopt `opencode-mcp` (~70–80 auto-generated tools): Claude Desktop delegation wants a curated four-tool surface. Stdio transport — Claude Desktop's config file takes stdio servers only.
- Build rather than adopt `hcom`/`swarm-tools`: requirement is ~300 lines of OpenCode-native TS; frameworks bring coupling we'd want to delete. (Timeboxed evaluation of `hcom` remains optional before Phase 1.)

---

## Dependencies / Assumptions

- OpenCode CLI + `@opencode-ai/sdk`/`@opencode-ai/plugin` pinned lockstep at 1.17.13; upgrade together. `@modelcontextprotocol/sdk` 1.29.0.
- Fro Bot's agent already supports the directory-passing topology (confirmed by Marcus).
- Manifest paths assume repos live under `~/src/github.com/`; unverified for `fro-bot/.github` and `marcusrbrown/infra` — adjust `workspace.json` if not.
- Directory routing is middleware behavior, not a documented contract; the smoke script is the regression guard.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R2][Needs research] Phase 0 spike: confirm sessions created with different directories load each repo's own config/plugins/AGENTS.md (InstanceStore isolation). This is the plan's load-bearing assumption; exit criterion for any further work.
- [Affects R4, R6][Technical] Exact status/todo/diff endpoint shapes — verify against the live OpenAPI spec (`GET /doc`) rather than trusting research notes.
- [Affects R4–R7][Technical] Do `.opencode/tools/` files resolve imports from repo-root `node_modules`, or is a `.opencode/package.json` needed?

---

## Sources / Research

- Server API: https://opencode.ai/docs/server/ · SDK: https://opencode.ai/docs/sdk/
- Custom tools: https://opencode.ai/docs/custom-tools/ · Plugins: https://opencode.ai/docs/plugins/
- Directory routing middleware: `packages/opencode/src/server/routes/instance/httpapi/middleware/workspace-routing.ts` (anomalyco/opencode)
- ACP: https://opencode.ai/docs/acp/ · agentclientprotocol.com
- Prior art surveyed: `aannoo/hcom`, `joelhooks/swarm-tools`, `AlaeddineMessadi/opencode-mcp`
- Full research synthesis: originating plan (Cowork session, 2026-07-02); decisions D1–D6 folded into Key Decisions above.
