#!/usr/bin/env bun
/**
 * Phase 0 spike / permanent canary: proves OpenCode server directory-routing
 * isolation between concurrent per-project sessions.
 *
 * Run: bun run smoke
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, getRoster } from "../src/config";
import { authHeader } from "../src/core";

// Reads SPACE_BUS_CONFIG, defaulting to the repo-root spacebus.json during
// the transition (see plan Unit 1 "Smoke roster contract"). After Unit 6
// this default moves to fixtures/dev-workspace/spacebus.json.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const roster = getRoster(repoRoot);

const BASE_URL = roster.server.baseUrl;
const PROJECTS = roster.projects.slice(0, 2).map((p) => expandHome(p.path));

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 180_000;

const PROMPT_TEXT =
  "Do not use any tools and do not modify any files. Reply with exactly two lines: " +
  "line 1 your current working directory absolute path; line 2 the first markdown " +
  "heading of this project's AGENTS.md if you have project instructions loaded, else NONE.";

interface SessionResponse {
  id: string;
  directory: string;
  path: unknown;
  projectID: string;
  [key: string]: unknown;
}

interface SessionStatusEntry {
  type: "idle" | "busy" | "retry" | string;
  [key: string]: unknown;
}

interface MessagePart {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface MessageInfo {
  role: string;
  [key: string]: unknown;
}

interface MessageEnvelope {
  info: MessageInfo;
  parts: MessagePart[];
}

interface DiffEntry {
  file?: string;
  patch?: string;
  additions: number;
  deletions: number;
  status?: string;
  [key: string]: unknown;
}

interface CheckResult {
  name: string;
  pass: boolean;
  detail?: string;
}

const results: CheckResult[] = [];

function record(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  const status = pass ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}${detail && !pass ? `\n  ${detail}` : ""}`);
}

function headers(
  directory: string,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-opencode-directory": directory,
    ...authHeader(),
    ...extra,
  };
}

async function readBodyText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<unreadable body>";
  }
}

async function createSession(directory: string): Promise<SessionResponse> {
  const res = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: headers(directory),
    body: JSON.stringify({ title: "space-bus smoke" }),
  });
  const bodyText = await readBodyText(res);
  if (!res.ok) {
    throw new Error(`POST /session failed (${res.status}): ${bodyText}`);
  }
  const body = JSON.parse(bodyText) as SessionResponse;

  record(
    `[${directory}] session binding: response.directory === requested directory`,
    body.directory === directory,
    `requested=${directory} got=${JSON.stringify(body.directory)} full body=${bodyText}`,
  );

  return body;
}

async function dispatchPromptAsync(
  directory: string,
  sessionId: string,
): Promise<void> {
  const res = await fetch(`${BASE_URL}/session/${sessionId}/prompt_async`, {
    method: "POST",
    headers: headers(directory),
    body: JSON.stringify({ parts: [{ type: "text", text: PROMPT_TEXT }] }),
  });
  const bodyText = res.status === 204 ? "" : await readBodyText(res);

  record(
    `[${directory}] prompt_async dispatched (204, fire-and-forget)`,
    res.status === 204,
    `status=${res.status} body=${bodyText}`,
  );

  if (res.status !== 204) {
    throw new Error(
      `prompt_async failed for ${directory} (${res.status}): ${bodyText}`,
    );
  }
}

async function pollUntilIdle(
  directory: string,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  for (;;) {
    const res = await fetch(`${BASE_URL}/session/status`, {
      method: "GET",
      headers: headers(directory),
    });
    const bodyText = await readBodyText(res);
    if (!res.ok) {
      record(
        `[${directory}] poll session status`,
        false,
        `status=${res.status} body=${bodyText}`,
      );
      throw new Error(
        `GET /session/status failed (${res.status}): ${bodyText}`,
      );
    }

    const statusMap = JSON.parse(bodyText) as Record<
      string,
      SessionStatusEntry
    >;
    const entry = statusMap[sessionId];
    if (!entry || entry.type === "idle") {
      record(`[${directory}] session reached idle before timeout`, true);
      return;
    }

    if (Date.now() >= deadline) {
      record(
        `[${directory}] session did not reach idle before timeout`,
        false,
        `last status=${JSON.stringify(entry)} timeout=${POLL_TIMEOUT_MS}ms`,
      );
      throw new Error(
        `Timed out waiting for session ${sessionId} (${directory}) to idle`,
      );
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

async function fetchLastAssistantText(
  directory: string,
  sessionId: string,
): Promise<string> {
  // Status can flip to idle a moment before the message is persisted/queryable;
  // retry briefly to avoid a spurious empty-array read.
  let bodyText = "";
  let messages: MessageEnvelope[] = [];
  let last: MessageEnvelope | undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(
      `${BASE_URL}/session/${sessionId}/message?limit=50`,
      {
        method: "GET",
        headers: headers(directory),
      },
    );
    bodyText = await readBodyText(res);
    if (!res.ok) {
      record(
        `[${directory}] fetch messages`,
        false,
        `status=${res.status} body=${bodyText}`,
      );
      throw new Error(
        `GET /session/${sessionId}/message failed (${res.status}): ${bodyText}`,
      );
    }

    messages = JSON.parse(bodyText) as MessageEnvelope[];
    last = messages.filter((m) => m.info.role === "assistant").at(-1);
    if (last) break;
    await Bun.sleep(1_000);
  }

  if (!last) {
    record(
      `[${directory}] result retrieval: assistant message present`,
      false,
      bodyText,
    );
    return "";
  }

  const text = last.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n")
    .trim();

  const containsOwnDirectory = text.includes(directory);
  record(
    `[${directory}] result retrieval: non-empty assistant text containing own directory`,
    text.length > 0 && containsOwnDirectory,
    `text=${JSON.stringify(text)}`,
  );

  return text;
}

async function checkDiff(directory: string, sessionId: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/session/${sessionId}/diff`, {
    method: "GET",
    headers: headers(directory),
  });
  const bodyText = await readBodyText(res);
  if (!res.ok) {
    record(
      `[${directory}] diff check: returns JSON array`,
      false,
      `status=${res.status} body=${bodyText}`,
    );
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as DiffEntry[];
  } catch {
    record(
      `[${directory}] diff check: returns JSON array`,
      false,
      `unparseable body=${bodyText}`,
    );
    return;
  }

  record(
    `[${directory}] diff check: returns JSON array`,
    Array.isArray(parsed),
    `body=${bodyText}`,
  );
}

function extractHeading(text: string): string {
  const lines = text.split("\n").map((l) => l.trim());
  return lines[1] ?? "<missing second line>";
}

async function runForProject(
  directory: string,
): Promise<{ directory: string; text: string }> {
  const session = await createSession(directory);
  await dispatchPromptAsync(directory, session.id);
  await pollUntilIdle(directory, session.id);
  const text = await fetchLastAssistantText(directory, session.id);
  await checkDiff(directory, session.id);
  return { directory, text };
}

async function main(): Promise<void> {
  console.log(`space-bus smoke: directory-routing isolation canary`);
  console.log(`server: ${BASE_URL}`);
  console.log(`projects: ${PROJECTS.join(", ")}\n`);

  const outcomes = await Promise.all(PROJECTS.map((dir) => runForProject(dir)));

  const [a, b] = outcomes;
  if (a && b) {
    const aHeading = extractHeading(a.text);
    const bHeading = extractHeading(b.text);
    console.log(`\nAGENTS.md heading [${a.directory}]: ${aHeading}`);
    console.log(`AGENTS.md heading [${b.directory}]: ${bHeading}`);
    console.log(`Headings differ: ${aHeading !== bHeading}`);

    record(
      "cross-check: sessions report distinct, correctly-bound working directories",
      a.text.includes(a.directory) &&
        b.text.includes(b.directory) &&
        a.text !== b.text,
      `a=${JSON.stringify(a.text)} b=${JSON.stringify(b.text)}`,
    );
  }

  console.log("\n=== Results ===");
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }

  const allPass = results.every((r) => r.pass);
  console.log(`\nOverall: ${allPass ? "PASS" : "FAIL"}`);
  process.exit(allPass ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error("smoke test crashed:", err);
  process.exit(1);
});
