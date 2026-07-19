/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 */
import type { z } from "zod";
import {
  type BusContext,
  busContextSchema,
  type DiffEntrySchema,
  diffSchema,
  LOOPBACK_HOSTS,
  messageListSchema,
  type ProjectSchema,
  pendingQuestionListSchema,
  questionListSchema,
  type SessionState,
  type SessionStateInfo,
  sessionListSchema,
  sessionSchema,
  sessionStatusMapSchema,
  sessionSummarySchema,
  todoSchema,
  turnMessageListSchema,
  vcsStatusSchema,
} from "./contract";

function findProject(
  projects: ProjectSchema[],
  name: string,
): ProjectSchema | undefined {
  return projects.find((p) => p.name === name);
}

export type { SessionState, SessionStateInfo } from "./contract";

type Ok<T> = { ok: true } & T;

/**
 * Typed partial-failure handle for dispatch() call sites only — omitted
 * entirely on every other core function's errors. "indeterminate" means the
 * failed request may already have mutated OpenCode state (a create/prompt/
 * reply POST that failed, was lost, or returned an unparseable body after
 * the mutating call was made); "not_sent" means the failure is definitely
 * pre-mutation (target resolution, pending-question verification). Fields
 * are included only when known — never present-but-undefined.
 */
export type DispatchFailure = {
  phase: "not_sent" | "indeterminate";
  project: string;
  sessionId?: string;
  messageId?: string;
};

type Err = { ok: false; error: string; dispatchFailure?: DispatchFailure };
export type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
}

/** Builds a dispatch Err with typed partial-failure metadata. Conditionally
 * includes sessionId/messageId only when provided — never a present-but-
 * undefined key. */
function dispatchErr(
  error: string,
  failure: {
    phase: "not_sent" | "indeterminate";
    project: string;
    sessionId?: string;
    messageId?: string;
  },
): Err {
  const dispatchFailure: DispatchFailure = {
    phase: failure.phase,
    project: failure.project,
    ...(failure.sessionId !== undefined
      ? { sessionId: failure.sessionId }
      : {}),
    ...(failure.messageId !== undefined
      ? { messageId: failure.messageId }
      : {}),
  };
  return { ok: false, error, dispatchFailure };
}

type Credentials = { username?: string; password?: string };

/** Options every exported core function takes: a per-call BusContext. */
export type CoreOpts = { context: BusContext };

// --- HTTP helper -----------------------------------------------------------

/** Browser/Bun/Node-safe UTF-8 -> base64 (btoa + TextEncoder are global in all three). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader(credentials: Credentials): Record<string, string> {
  if (!credentials.password) return {};
  const username = credentials.username ?? "opencode";
  const token = toBase64(`${username}:${credentials.password}`);
  return { Authorization: `Basic ${token}` };
}

async function api(
  baseUrl: string,
  credentials: Credentials,
  directory: string,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; bodyText: string }> {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-opencode-directory": directory,
        ...authHeader(credentials),
        ...(init?.headers as Record<string, string> | undefined),
      },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const bodyText = await res.text().catch(() => "<unreadable body>");
    return { res, bodyText };
  } catch (e) {
    const message = (e as Error).message;
    return {
      res: new Response(null, {
        status: 599,
        statusText: "space-bus: request failed",
      }),
      bodyText: `space-bus: request failed: ${message}`,
    };
  }
}

export type DiffSource = "session" | "turns" | "working-tree";

async function fetchTurnDiffs(
  baseUrl: string,
  credentials: Credentials,
  directory: string,
  sessionId: string,
): Promise<z.infer<typeof diffSchema>> {
  const { res, bodyText } = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(sessionId)}/message?limit=100`,
  );
  if (!res.ok) return [];
  let messages: z.infer<typeof turnMessageListSchema>;
  try {
    messages = turnMessageListSchema.parse(JSON.parse(bodyText));
  } catch {
    return [];
  }
  const byFile = new Map<string, DiffEntrySchema>();
  for (const m of messages) {
    if (m.info.role !== "user") continue;
    const diffs = m.info.summary?.diffs;
    if (!diffs || diffs.length === 0) continue;
    for (const d of diffs) {
      const key = d.file ?? `<unknown:${byFile.size}>`;
      byFile.set(key, d); // last turn wins
    }
  }
  return Array.from(byFile.values());
}

async function fetchDiffWithFallback(
  baseUrl: string,
  credentials: Credentials,
  directory: string,
  sessionId: string,
): Promise<{ diff: z.infer<typeof diffSchema>; diffSource: DiffSource }> {
  const diffRes = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(sessionId)}/diff`,
  );
  let diff: z.infer<typeof diffSchema> = [];
  try {
    diff = diffRes.res.ok ? diffSchema.parse(JSON.parse(diffRes.bodyText)) : [];
  } catch {
    diff = [];
  }
  if (diff.length > 0) {
    return { diff, diffSource: "session" };
  }
  try {
    const sessionRes = await api(
      baseUrl,
      credentials,
      directory,
      `/session/${encodeURIComponent(sessionId)}`,
    );
    if (sessionRes.res.ok) {
      const parsed = sessionSummarySchema.parse(
        JSON.parse(sessionRes.bodyText),
      );
      const summaryDiffs = parsed.summary?.diffs;
      if (summaryDiffs && summaryDiffs.length > 0) {
        return { diff: summaryDiffs, diffSource: "session" };
      }
    }
  } catch {
    // ignore, fall through to per-turn aggregation
  }
  try {
    const turnDiffs = await fetchTurnDiffs(
      baseUrl,
      credentials,
      directory,
      sessionId,
    );
    if (turnDiffs.length > 0) {
      return { diff: turnDiffs, diffSource: "turns" };
    }
  } catch {
    // ignore, fall through to working-tree fallback
  }
  try {
    const vcsRes = await api(baseUrl, credentials, directory, "/vcs/status");
    if (vcsRes.res.ok) {
      const vcsStatus = vcsStatusSchema.parse(JSON.parse(vcsRes.bodyText));
      if (vcsStatus.length > 0) {
        return {
          diff: vcsStatus.map((v) => ({
            file: v.file,
            additions: v.additions,
            deletions: v.deletions,
            status: v.status,
          })),
          diffSource: "working-tree",
        };
      }
    }
  } catch {
    // ignore, keep empty session diff
  }
  return { diff, diffSource: "session" };
}

// --- context validation boundary -------------------------------------------
// The single gate every exported function calls at entry. zod-parses the
// injected context (parse COPIES the input, so mutating the caller's roster
// object after the call cannot retroactively change what core sees) and
// applies the localhost guard. Internal helpers only ever see the parsed
// copy below. Never throws — garbage input resolves ok:false.

function validateContext(context: BusContext): Result<{
  baseUrl: string;
  projects: ProjectSchema[];
  credentials: Credentials;
}> {
  const parsed = busContextSchema.safeParse(context);
  if (!parsed.success) {
    return err(`space-bus: invalid context: ${parsed.error.message}`);
  }
  const { roster, credentials } = parsed.data;
  let hostname: string;
  try {
    hostname = new URL(roster.server.baseUrl).hostname;
  } catch {
    return err("space-bus: context roster server.baseUrl is not a valid URL");
  }
  if (!LOOPBACK_HOSTS.has(hostname)) {
    return err(
      `space-bus: context roster server.baseUrl must point to localhost (got ${hostname}) — refusing to send credentials off-machine`,
    );
  }
  return {
    ok: true,
    baseUrl: roster.server.baseUrl,
    projects: roster.projects,
    credentials: credentials ?? {},
  };
}

function isStatusBusy(entry?: { type: string }): boolean {
  return entry?.type === "busy" || entry?.type === "retry" || false;
}

function resolveProjectOrErr(
  projects: ProjectSchema[],
  name: string,
): Result<{ project: ProjectSchema }> {
  const project = findProject(projects, name);
  if (!project) {
    const valid = projects.map((p) => p.name).join(", ");
    return err(
      `space-bus: unknown project "${name}". Valid projects: ${valid}`,
    );
  }
  if (!project.exists) {
    return err(
      `space-bus: project "${name}" path does not exist on disk: ${project.expandedPath}`,
    );
  }
  return { ok: true, project };
}

// --- roster ------------------------------------------------------------------

export type RosterProject = {
  name: string;
  path: string;
  description: string;
  pathExists: boolean;
  busyCount?: number;
  sessionCount?: number;
  sessionCountCapped?: boolean;
  statusError?: string;
};

export async function roster(
  opts: CoreOpts,
): Promise<Result<{ projects: RosterProject[] }>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;
  const results = await Promise.all(
    projects.map(async (p): Promise<RosterProject> => {
      if (!p.exists) {
        return {
          name: p.name,
          path: p.expandedPath,
          description: p.description,
          pathExists: false,
        };
      }
      try {
        const [statusRes, listRes] = await Promise.all([
          api(baseUrl, credentials, p.expandedPath, "/session/status"),
          api(baseUrl, credentials, p.expandedPath, "/session?limit=101"),
        ]);
        if (!statusRes.res.ok || !listRes.res.ok) {
          return {
            name: p.name,
            path: p.expandedPath,
            description: p.description,
            pathExists: true,
            statusError: `status=${statusRes.res.status}/${listRes.res.status}`,
          };
        }
        const statusMap = sessionStatusMapSchema.parse(
          JSON.parse(statusRes.bodyText),
        );
        const sessions = sessionListSchema.parse(JSON.parse(listRes.bodyText));
        const busyCount = Object.values(statusMap).filter((s) =>
          isStatusBusy(s),
        ).length;
        const capped = sessions.length > 100;
        return {
          name: p.name,
          path: p.expandedPath,
          description: p.description,
          pathExists: true,
          busyCount,
          sessionCount: capped ? 100 : sessions.length,
          sessionCountCapped: capped,
        };
      } catch (e) {
        return {
          name: p.name,
          path: p.expandedPath,
          description: p.description,
          pathExists: true,
          statusError: (e as Error).message,
        };
      }
    }),
  );
  return { ok: true, projects: results };
}

// --- dispatch ------------------------------------------------------------------

async function dispatchNew(
  baseUrl: string,
  credentials: Credentials,
  projects: ProjectSchema[],
  project: string,
  prompt: string,
  title?: string,
  messageId?: string,
): Promise<
  Result<{
    sessionId: string;
    project: string;
    directory: string;
    messageId?: string;
  }>
> {
  const resolved = resolveProjectOrErr(projects, project);
  if (!resolved.ok) return resolved;
  const directory = resolved.project.expandedPath;

  const sessionTitle = title ?? `bus: ${prompt.slice(0, 60)}`;
  const createRes = await api(baseUrl, credentials, directory, "/session", {
    method: "POST",
    body: JSON.stringify({ title: sessionTitle }),
  });
  if (!createRes.res.ok) {
    // The create POST may have landed server-side even though this response
    // is an error (lost response, proxy hiccup) — treat as indeterminate,
    // not not_sent, since a session could already exist with no id known
    // back to the caller.
    return dispatchErr(
      `space-bus: failed to create session in "${project}" (${createRes.res.status}): ${createRes.bodyText}`,
      { phase: "indeterminate", project, messageId },
    );
  }
  let session: z.infer<typeof sessionSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(createRes.bodyText));
  } catch (e) {
    return dispatchErr(
      `space-bus: unexpected /session response shape: ${(e as Error).message}`,
      { phase: "indeterminate", project, messageId },
    );
  }

  const promptRes = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(session.id)}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: prompt }],
        ...(messageId !== undefined ? { messageID: messageId } : {}),
      }),
    },
  );
  if (promptRes.res.status !== 204) {
    return dispatchErr(
      `space-bus: dispatch to "${project}" failed sending prompt (${promptRes.res.status}): ${promptRes.bodyText}`,
      { phase: "indeterminate", project, sessionId: session.id, messageId },
    );
  }

  return {
    ok: true,
    sessionId: session.id,
    project,
    directory,
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

export type DispatchResult = { sessionId: string; project: string } & (
  | { mode: "new"; directory: string; messageId?: string }
  | { mode: "follow-up"; messageId?: string }
  | { mode: "question-reply" }
  | { mode: "blocked"; requestId: string }
);

// --- OpenCode-compatible ascending message id generation --------------------
// Replicates OpenCode's own id shape so ids generated here sort the same
// way OpenCode's do: a 48-bit ascending timestamp+counter encoded as 12
// lowercase hex chars, followed by 14 random base62 chars for uniqueness
// within the same encoded prefix. Browser-safe: only `crypto.getRandomValues`
// and `Date.now`, no Node builtins.
const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

let lastTimestamp = 0;
let counter = 0;

function nextAscendingId(): bigint {
  const timestamp = Date.now();
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter++;
  return BigInt(timestamp) * 0x1000n + BigInt(counter);
}

function encode48BitHex(value: bigint): string {
  const bytes = new Uint8Array(6);
  let v = value & 0xffffffffffffn; // low 48 bits
  for (let i = 5; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) {
    out += BASE62_ALPHABET[b % BASE62_ALPHABET.length];
  }
  return out;
}

/**
 * Generates an OpenCode v1 user-message id (`msg_` + a 12-char lowercase-hex
 * ascending timestamp/counter prefix + 14 random base62 chars) using only
 * Web Crypto / global browser-safe APIs — no Node builtins — so it's usable
 * from the browser-safe `/core` subpath.
 */
export function createDispatchMessageId(): string {
  const hex = encode48BitHex(nextAscendingId());
  return `msg_${hex}${randomBase62(14)}`;
}

// OpenCode-compatible message id shape: literal "msg_" prefix + exactly 12
// lowercase-hex chars + exactly 14 base62 chars (26-char payload, bounded
// by construction). Deliberately exact-length and exact-alphabet so a
// caller-supplied id can never smuggle a path, an HTTP header/CRLF
// injection, oversized input, or non-token characters into prompt_async.
const MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

// Stable, generic error — never echoes the rejected value (which could be
// arbitrarily large, contain control characters, or carry injection
// payloads that would otherwise leak into logs/error strings).
const INVALID_MESSAGE_ID_ERROR =
  "space-bus: messageId must be msg_ followed by exactly 12 hex characters and 14 alphanumeric characters";

function validateMessageId(messageId: string): Result<{ messageId: string }> {
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    return err(INVALID_MESSAGE_ID_ERROR);
  }
  return { ok: true, messageId };
}

// project stays allowed alongside sessionId (the mismatch guard in the
// steering path consumes it) but a bare {prompt} with neither is now a
// compile error — new sessions require project, steering requires
// sessionId.
export type DispatchArgs = {
  prompt: string;
  title?: string;
  /**
   * Backward-compatible pending-question policy for the steering path.
   * Defaults to v0.13.1's implicit "question-reply" behavior (a follow-up
   * to a session with a pending question is sent as that question's
   * reply). Passing "blocked" instead refuses the mutation entirely and
   * returns a typed blocked result with no reply and no follow-up prompt —
   * required by ide_dispatch_prompt (R2), which must never silently
   * reinterpret prompt text as a question answer.
   */
  onPendingQuestion?: "question-reply" | "blocked";
  /**
   * Caller-supplied OpenCode v1 user message id to correlate the dispatched
   * prompt with the message OpenCode creates for it. Validated by
   * toDispatchArgs against the msg_ + alphanumeric shape; never generated
   * here — generation is the caller's job via createDispatchMessageId().
   */
  messageId?: string;
} & (
  | { project: string; sessionId?: undefined }
  | { sessionId: string; project?: string }
);

// Validates the runtime shape once for both adapters (MCP + plugin tool),
// so neither call site needs an `as DispatchArgs` cast to satisfy the
// discriminated-union exclusivity above. dispatch() keeps its own guards
// as defense in depth. Pure arg-shape validation — no context touched, so
// adapters can run this before loading config (fail-fast ordering pin).
export function toDispatchArgs(input: {
  prompt: string;
  title?: string;
  project?: string;
  sessionId?: string;
  onPendingQuestion?: "question-reply" | "blocked";
  messageId?: string;
}): Result<DispatchArgs> {
  if (
    input.onPendingQuestion !== undefined &&
    input.onPendingQuestion !== "question-reply" &&
    input.onPendingQuestion !== "blocked"
  ) {
    return err(
      `space-bus: onPendingQuestion must be "question-reply" or "blocked", got ${JSON.stringify(input.onPendingQuestion)}`,
    );
  }
  if (input.sessionId !== undefined && input.sessionId === "") {
    return err("space-bus: sessionId must be a non-empty string");
  }
  let messageId: string | undefined;
  if (input.messageId !== undefined) {
    const validated = validateMessageId(input.messageId);
    if (!validated.ok) return validated;
    messageId = validated.messageId;
  }
  if (!input.sessionId) {
    if (!input.project) {
      return err("space-bus: project is required when starting a new session");
    }
    return {
      ok: true,
      prompt: input.prompt,
      title: input.title,
      project: input.project,
      onPendingQuestion: input.onPendingQuestion,
      ...(messageId !== undefined ? { messageId } : {}),
    };
  }
  return {
    ok: true,
    prompt: input.prompt,
    title: input.title,
    sessionId: input.sessionId,
    project: input.project,
    onPendingQuestion: input.onPendingQuestion,
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

async function dispatchNewBranch(
  baseUrl: string,
  credentials: Credentials,
  projects: ProjectSchema[],
  args: DispatchArgs & { project: string },
): Promise<Result<DispatchResult>> {
  const r = await dispatchNew(
    baseUrl,
    credentials,
    projects,
    args.project,
    args.prompt,
    args.title,
    args.messageId,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    sessionId: r.sessionId,
    project: r.project,
    mode: "new",
    directory: r.directory,
    ...(r.messageId !== undefined ? { messageId: r.messageId } : {}),
  };
}

export async function dispatch(
  args: DispatchArgs,
  opts: CoreOpts,
): Promise<Result<DispatchResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  // Defense in depth: re-validate messageId here even though toDispatchArgs
  // already validates it — a caller can construct DispatchArgs directly,
  // bypassing toDispatchArgs entirely. Runs before any context/network I/O.
  if (args.messageId !== undefined) {
    const validated = validateMessageId(args.messageId);
    if (!validated.ok) return validated;
  }

  if (args.sessionId !== undefined && args.sessionId === "") {
    return err("space-bus: sessionId must be a non-empty string");
  }

  if (!args.sessionId) {
    if (!args.project) {
      return err("space-bus: project is required when starting a new session");
    }
    return dispatchNewBranch(baseUrl, credentials, projects, {
      ...args,
      project: args.project,
    });
  }

  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    args.sessionId,
  );
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  if (args.project && args.project !== project) {
    return err(
      `space-bus: session ${args.sessionId} belongs to project "${project}", not "${args.project}" — refusing to steer the wrong session`,
    );
  }

  return steerSession(
    baseUrl,
    credentials,
    args.sessionId,
    args.prompt,
    directory,
    project,
    args.onPendingQuestion ?? "question-reply",
    args.messageId,
  );
}

// --- session resolution by id (try each project's directory) ------------------

async function findSessionDirectory(
  baseUrl: string,
  credentials: Credentials,
  projects: ProjectSchema[],
  sessionId: string,
): Promise<Result<{ directory: string; project: string }>> {
  // Session lookup succeeds regardless of which directory header is sent (the
  // session store is global), so probe with any reachable project directory
  // and trust the returned session's own `directory` field to identify the
  // owning manifest project.
  for (const p of projects) {
    if (!p.exists) continue;
    const { res, bodyText } = await api(
      baseUrl,
      credentials,
      p.expandedPath,
      `/session/${encodeURIComponent(sessionId)}`,
    );
    if (!res.ok) continue;
    let session: z.infer<typeof sessionSchema>;
    try {
      session = sessionSchema.parse(JSON.parse(bodyText));
    } catch {
      continue;
    }
    const owner = session.directory
      ? projects.find((proj) => proj.expandedPath === session.directory)
      : undefined;
    if (owner) {
      return { ok: true, directory: owner.expandedPath, project: owner.name };
    }
    // Session exists but its directory is missing or isn't a manifest project
    // (shouldn't happen for bus-dispatched sessions) — refuse to guess, since
    // attributing it to the probing project would misidentify the owner.
    return err(
      `space-bus: session ${sessionId} belongs to ${session.directory ?? "an unknown directory"}, which is not a manifest project`,
    );
  }
  return err(
    `space-bus: no manifest project has a session with id ${sessionId}`,
  );
}

// --- status ------------------------------------------------------------------

export type SessionStatusResult = {
  sessionId: string;
  project: string;
  busy: boolean;
  title?: string;
  todos: { content: string; status: string; priority: string }[];
  diff: { files: number; additions: number; deletions: number };
  diffSource: DiffSource;
  pendingQuestion?: { preview: string; options: string[] };
  state: SessionState;
  resultAvailable: boolean;
};

/**
 * Maps raw session-status inputs to the normalized lifecycle enum. Called
 * identically by status(), snapshot(), and bus_wait so the three emitters
 * cannot diverge (R2).
 *
 * Precedence (highest first) — each check short-circuits the ones below it:
 *   1. !resolved       -> "not_found"  (session id never resolved to a
 *                          directory/session; nothing else can be derived)
 *   2. failed          -> "failed"     (server-reported errored/aborted)
 *   3. pendingQuestion -> "blocked"    (wins over both "running" and
 *                          "complete" — a busy session with an open question
 *                          is blocked, and a not-busy session with a still-
 *                          open question is blocked, not complete)
 *   4. busy            -> "running"
 *   5. else            -> "complete"
 */
export function deriveSessionState(input: {
  busy: boolean;
  pendingQuestion?: { preview: string; options: string[] } | undefined;
  resolved: boolean;
  failed?: boolean;
}): SessionState {
  if (!input.resolved) return "not_found";
  if (input.failed) return "failed";
  if (input.pendingQuestion) return "blocked";
  if (input.busy) return "running";
  return "complete";
}

function formatQuestionEntry(
  entry: z.infer<typeof pendingQuestionListSchema>[number],
): { sessionId: string; preview: string; options: string[] } {
  const firstQuestion = entry.questions?.[0];
  const text = firstQuestion?.question ?? "";
  const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  const options = (firstQuestion?.options ?? [])
    .map((o) => o.label ?? "")
    .filter((l) => l.length > 0);
  return { sessionId: entry.sessionID, preview, options };
}

async function fetchPendingQuestion(
  baseUrl: string,
  credentials: Credentials,
  directory: string,
  sessionId: string,
): Promise<{ preview: string; options: string[] } | undefined> {
  try {
    const { res, bodyText } = await api(
      baseUrl,
      credentials,
      directory,
      "/question",
    );
    if (!res.ok) return undefined;
    const entries = pendingQuestionListSchema.parse(JSON.parse(bodyText));
    const entry = entries.find((e) => e.sessionID === sessionId);
    if (!entry) return undefined;
    const { preview, options } = formatQuestionEntry(entry);
    return { preview, options };
  } catch {
    return undefined;
  }
}

export async function status(
  sessionId: string,
  opts: CoreOpts,
): Promise<Result<SessionStatusResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    sessionId,
  );
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  const [sessionRes, statusMapRes, todoRes, diffResult, pendingQuestion] =
    await Promise.all([
      api(
        baseUrl,
        credentials,
        directory,
        `/session/${encodeURIComponent(sessionId)}`,
      ),
      api(baseUrl, credentials, directory, "/session/status"),
      api(
        baseUrl,
        credentials,
        directory,
        `/session/${encodeURIComponent(sessionId)}/todo`,
      ),
      fetchDiffWithFallback(baseUrl, credentials, directory, sessionId),
      fetchPendingQuestion(baseUrl, credentials, directory, sessionId),
    ]);

  if (!sessionRes.res.ok) {
    return err(
      `space-bus: failed to fetch session ${sessionId} (${sessionRes.res.status}): ${sessionRes.bodyText}`,
    );
  }

  let session: z.infer<typeof sessionSchema>;
  let statusMap: z.infer<typeof sessionStatusMapSchema>;
  let todos: z.infer<typeof todoSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(sessionRes.bodyText));
    statusMap = statusMapRes.res.ok
      ? sessionStatusMapSchema.parse(JSON.parse(statusMapRes.bodyText))
      : {};
    todos = todoRes.res.ok
      ? todoSchema.parse(JSON.parse(todoRes.bodyText))
      : [];
  } catch (e) {
    return err(
      `space-bus: unexpected response shape for session ${sessionId}: ${(e as Error).message}`,
    );
  }

  const entry = statusMap[sessionId];
  const busy = isStatusBusy(entry);

  const { diff, diffSource } = diffResult;
  const additions = diff.reduce((sum, d) => sum + d.additions, 0);
  const deletions = diff.reduce((sum, d) => sum + d.deletions, 0);

  // resolved is true here — findSessionDirectory already succeeded above.
  // failed-detection for a live session has no clear signal in status()'s
  // current data (no errored/aborted status-map member observed); refined
  // in a later unit rather than invented here.
  const state = deriveSessionState({ busy, pendingQuestion, resolved: true });

  return {
    ok: true,
    sessionId,
    project,
    busy,
    title: session.title,
    todos,
    diff: { files: diff.length, additions, deletions },
    diffSource,
    pendingQuestion,
    state,
    resultAvailable: state === "complete",
  };
}

// --- steering (question-reply / follow-up) ------------------------------------

/**
 * Resolves the pending-question state for a steering call. "blocked" is
 * the safe, fail-closed opt-out: it must not fall through to a mutation
 * (reply or follow-up prompt) when pending-question state could not be
 * verified — an upstream 5xx or a malformed body is treated the same as
 * "we don't know", so it refuses rather than guesses. Default
 * "question-reply" callers preserve v0.13.1's fail-open behavior for
 * backward compatibility (an unreadable /question response falls through
 * to a normal follow-up prompt, as it always has).
 */
async function resolvePendingQuestionForSteer(
  baseUrl: string,
  credentials: Credentials,
  directory: string,
  sessionId: string,
  project: string,
  onPendingQuestion: "question-reply" | "blocked",
): Promise<
  Result<{ pending: z.infer<typeof questionListSchema>[number] | undefined }>
> {
  const questionsRes = await api(baseUrl, credentials, directory, "/question");
  if (!questionsRes.res.ok) {
    if (onPendingQuestion === "blocked") {
      // Pre-mutation: verification failed before any reply/prompt was sent.
      return dispatchErr(
        `space-bus: could not verify pending-question state for session ${sessionId} (/question ${questionsRes.res.status}) — refusing to dispatch under the blocked policy`,
        { phase: "not_sent", project, sessionId },
      );
    }
    return { ok: true, pending: undefined };
  }
  let pendingList: z.infer<typeof questionListSchema>;
  try {
    pendingList = questionListSchema.parse(JSON.parse(questionsRes.bodyText));
  } catch (e) {
    if (onPendingQuestion === "blocked") {
      return dispatchErr(
        `space-bus: could not parse pending-question state for session ${sessionId}: ${(e as Error).message} — refusing to dispatch under the blocked policy`,
        { phase: "not_sent", project, sessionId },
      );
    }
    return { ok: true, pending: undefined };
  }
  return {
    ok: true,
    pending: pendingList.find((q) => q.sessionID === sessionId),
  };
}

async function steerSession(
  baseUrl: string,
  credentials: Credentials,
  sessionId: string,
  message: string,
  directory: string,
  project: string,
  onPendingQuestion: "question-reply" | "blocked",
  messageId?: string,
): Promise<Result<DispatchResult>> {
  const pendingRes = await resolvePendingQuestionForSteer(
    baseUrl,
    credentials,
    directory,
    sessionId,
    project,
    onPendingQuestion,
  );
  if (!pendingRes.ok) return pendingRes;
  const { pending } = pendingRes;

  if (pending && onPendingQuestion === "blocked") {
    return {
      ok: true,
      sessionId,
      project,
      mode: "blocked",
      requestId: pending.id,
    };
  }

  if (pending) {
    const replyRes = await api(
      baseUrl,
      credentials,
      directory,
      `/question/${encodeURIComponent(pending.id)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ answers: [[message]] }),
      },
    );
    if (!replyRes.res.ok) {
      // Question-reply never claims messageId — no ordinary prompt message
      // is sent on this branch, so there's nothing to correlate.
      return dispatchErr(
        `space-bus: failed to reply to question ${pending.id} for session ${sessionId} (${replyRes.res.status}): ${replyRes.bodyText}`,
        { phase: "indeterminate", project, sessionId },
      );
    }
    return { ok: true, sessionId, project, mode: "question-reply" };
  }

  const promptRes = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify({
        parts: [{ type: "text", text: message }],
        ...(messageId !== undefined ? { messageID: messageId } : {}),
      }),
    },
  );
  if (promptRes.res.status !== 204) {
    return dispatchErr(
      `space-bus: follow-up prompt to session ${sessionId} failed (${promptRes.res.status}): ${promptRes.bodyText}`,
      { phase: "indeterminate", project, sessionId, messageId },
    );
  }
  return {
    ok: true,
    sessionId,
    project,
    mode: "follow-up",
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

// --- result ------------------------------------------------------------------

export type SessionResultResult = {
  sessionId: string;
  project: string;
  text: string;
  diff: {
    file?: string;
    additions: number;
    deletions: number;
    status?: string;
  }[];
  diffSource: DiffSource;
};

export async function result(
  sessionId: string,
  opts: CoreOpts,
): Promise<Result<SessionResultResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    sessionId,
  );
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  const statusMapRes = await api(
    baseUrl,
    credentials,
    directory,
    "/session/status",
  );
  if (statusMapRes.res.ok) {
    try {
      const statusMap = sessionStatusMapSchema.parse(
        JSON.parse(statusMapRes.bodyText),
      );
      const entry = statusMap[sessionId];
      if (isStatusBusy(entry)) {
        return err(
          `space-bus: session ${sessionId} is still running, use bus_status`,
        );
      }
    } catch {
      // ignore malformed status map, proceed
    }
  }

  const [messageRes, diffResult] = await Promise.all([
    api(
      baseUrl,
      credentials,
      directory,
      `/session/${encodeURIComponent(sessionId)}/message?limit=50`,
    ),
    fetchDiffWithFallback(baseUrl, credentials, directory, sessionId),
  ]);

  if (!messageRes.res.ok) {
    return err(
      `space-bus: failed to fetch messages for ${sessionId} (${messageRes.res.status}): ${messageRes.bodyText}`,
    );
  }

  let messages: z.infer<typeof messageListSchema>;
  try {
    messages = messageListSchema.parse(JSON.parse(messageRes.bodyText));
  } catch (e) {
    return err(
      `space-bus: unexpected response shape for session ${sessionId}: ${(e as Error).message}`,
    );
  }

  const { diff, diffSource } = diffResult;

  const last = messages.filter((m) => m.info.role === "assistant").at(-1);
  const text = last
    ? last.parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text as string)
        .join("\n")
        .trim()
    : "";

  return { ok: true, sessionId, project, text, diff, diffSource };
}

// --- snapshot ------------------------------------------------------------------

export type SnapshotProject = {
  name: string;
  path: string;
  exists: boolean;
  description?: string;
  busyCount?: number;
  sessionCount?: number;
  sessionCountCapped?: boolean;
  pendingQuestions?: {
    sessionId: string;
    preview: string;
    options: string[];
  }[];
  sessions?: {
    sessionId: string;
    state: SessionState;
    resultAvailable: boolean;
  }[];
  error?: string;
};

async function fetchSnapshotProject(
  baseUrl: string,
  credentials: Credentials,
  project: ProjectSchema,
): Promise<SnapshotProject> {
  const directory = project.expandedPath;
  try {
    const [statusRes, listRes, questionRes] = await Promise.all([
      api(baseUrl, credentials, directory, "/session/status"),
      api(baseUrl, credentials, directory, "/session?limit=101"),
      api(baseUrl, credentials, directory, "/question"),
    ]);
    if (!statusRes.res.ok || !listRes.res.ok) {
      return {
        name: project.name,
        path: directory,
        exists: true,
        description: project.description,
        error: `status=${statusRes.res.status}/${listRes.res.status}`,
      };
    }
    const statusMap = sessionStatusMapSchema.parse(
      JSON.parse(statusRes.bodyText),
    );
    const sessions = sessionListSchema.parse(JSON.parse(listRes.bodyText));
    const busyCount = Object.values(statusMap).filter((s) =>
      isStatusBusy(s),
    ).length;
    const capped = sessions.length > 100;
    let pendingQuestions:
      | { sessionId: string; preview: string; options: string[] }[]
      | undefined;
    let pendingQuestionsBySession = new Map<
      string,
      { preview: string; options: string[] }
    >();
    if (questionRes.res.ok) {
      try {
        const entries = pendingQuestionListSchema.parse(
          JSON.parse(questionRes.bodyText),
        );
        const formatted = entries.map((e) => formatQuestionEntry(e));
        pendingQuestions = formatted;
        pendingQuestionsBySession = new Map(
          formatted.map((q) => [q.sessionId, q]),
        );
      } catch {
        pendingQuestions = undefined;
      }
    }
    // state derived identically to status() (deriveSessionState) so
    // snapshot() and status() cannot report divergent lifecycles for the
    // same session (R2). resolved is always true here — every entry comes
    // from the roster's own session list. failed has no clear signal in
    // this data, same as status(); pass failed=false.
    const sessionStates = sessions.map((s) => {
      const entry = statusMap[s.id];
      const busy = isStatusBusy(entry);
      const pendingQuestion = pendingQuestionsBySession.get(s.id);
      const state = deriveSessionState({
        busy,
        pendingQuestion,
        resolved: true,
      });
      return {
        sessionId: s.id,
        state,
        resultAvailable: state === "complete",
      };
    });
    return {
      name: project.name,
      path: directory,
      exists: true,
      description: project.description,
      busyCount,
      sessionCount: capped ? 100 : sessions.length,
      sessionCountCapped: capped,
      pendingQuestions,
      sessions: sessionStates,
    };
  } catch (e) {
    return {
      name: project.name,
      path: directory,
      exists: true,
      description: project.description,
      error: (e as Error).message,
    };
  }
}

/** Runs `fn` over `items` with at most `concurrency` in flight at once. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const limit = Math.max(
    1,
    Math.min(
      Number.isFinite(concurrency) ? Math.floor(concurrency) : 4,
      items.length,
    ),
  );
  const workers = Array.from({ length: limit }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function snapshot(
  opts: CoreOpts & { concurrency?: number },
): Promise<Result<{ projects: SnapshotProject[] }>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;
  const concurrency = opts.concurrency ?? 4;

  const results = await mapWithConcurrency(
    projects,
    concurrency,
    async (p): Promise<SnapshotProject> => {
      if (!p.exists) {
        return {
          name: p.name,
          path: p.expandedPath,
          exists: false,
          description: p.description,
        };
      }
      return fetchSnapshotProject(baseUrl, credentials, p);
    },
  );

  return { ok: true, projects: results };
}

// --- wait ------------------------------------------------------------------
// Stateless, level-triggered long-poll over one or more sessions. Owns its
// own deadline (opts.timeoutMs) independently of api()'s per-request 30s
// abort — a single poll request stays bounded by api(), but the wait LOOP
// keeps polling (each poll a fresh api() call) until a watched session needs
// attention or the deadline elapses. Default kept comfortably below any
// plugin/MCP-facade call ceiling; change these two constants together if the
// live harness needs different tuning.
const DEFAULT_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_WAIT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_WAIT_CONCURRENCY = 4;

const NEEDS_ATTENTION_STATES: SessionState[] = [
  "complete",
  "blocked",
  "failed",
  "not_found",
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type WaitResult = {
  sessions: SessionStateInfo[];
  waker: string[];
  timedOut: boolean;
};

type WaitLocation = { directory: string; project: string } | null;
type WaitGroup = { directory: string; sessionIds: string[] };

/**
 * Resolves each session id -> directory/project once, up front. An
 * unresolvable id never fails the whole call (R9) — it's kept as a
 * permanent not_found entry for the rest of the wait. (Judgment call:
 * there's no owning project for a not_found session, so `project` is the
 * empty string — SessionStateInfo requires the field, and inventing a
 * project name would be worse than an empty one.)
 */
async function resolveWaitSessions(
  baseUrl: string,
  credentials: Credentials,
  projects: ProjectSchema[],
  sessionIds: string[],
): Promise<{
  locationById: Map<string, WaitLocation>;
  groupList: WaitGroup[];
  lastKnown: Map<string, SessionStateInfo>;
}> {
  const locations = await mapWithConcurrency(
    sessionIds,
    DEFAULT_WAIT_CONCURRENCY,
    async (id) => {
      const loc = await findSessionDirectory(
        baseUrl,
        credentials,
        projects,
        id,
      );
      return { id, loc };
    },
  );

  const locationById = new Map<string, WaitLocation>();
  for (const { id, loc } of locations) {
    locationById.set(
      id,
      loc.ok ? { directory: loc.directory, project: loc.project } : null,
    );
  }

  const groups = new Map<string, WaitGroup>();
  for (const id of sessionIds) {
    const loc = locationById.get(id);
    if (!loc) continue;
    const group = groups.get(loc.directory) ?? {
      directory: loc.directory,
      sessionIds: [],
    };
    group.sessionIds.push(id);
    groups.set(loc.directory, group);
  }

  // Seed a last-known snapshot: not_found sessions are permanently not_found;
  // resolved sessions start as "running" until the first poll reports
  // otherwise. This is also what a poll failure falls back to (degrade
  // gracefully rather than throw or fabricate "complete").
  const lastKnown = new Map<string, SessionStateInfo>();
  for (const id of sessionIds) {
    const loc = locationById.get(id);
    lastKnown.set(id, {
      sessionId: id,
      project: loc?.project ?? "",
      state: loc ? "running" : "not_found",
      resultAvailable: false,
    });
  }

  return { locationById, groupList: Array.from(groups.values()), lastKnown };
}

export async function wait(
  sessionIds: string[],
  opts: CoreOpts & { timeoutMs?: number; pollIntervalMs?: number },
): Promise<Result<WaitResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  const uniqueIds = Array.from(new Set(sessionIds));
  if (uniqueIds.length === 0) {
    return { ok: true, sessions: [], waker: [], timedOut: true };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_WAIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  const { locationById, groupList, lastKnown } = await resolveWaitSessions(
    baseUrl,
    credentials,
    projects,
    uniqueIds,
  );

  async function pollGroup(group: {
    directory: string;
    sessionIds: string[];
  }): Promise<void> {
    const [statusRes, questionRes] = await Promise.all([
      api(baseUrl, credentials, group.directory, "/session/status"),
      api(baseUrl, credentials, group.directory, "/question"),
    ]);
    // A failed poll for this directory degrades gracefully: keep every
    // session in that group at its last-known state rather than throwing,
    // looping forever, or fabricating a state change.
    if (!statusRes.res.ok) return;
    let statusMap: z.infer<typeof sessionStatusMapSchema>;
    try {
      statusMap = sessionStatusMapSchema.parse(JSON.parse(statusRes.bodyText));
    } catch {
      return;
    }
    const pendingBySession = parsePendingQuestions(questionRes);
    for (const id of group.sessionIds) {
      const entry = statusMap[id];
      const busy = isStatusBusy(entry);
      const pendingQuestion = pendingBySession.get(id);
      const state = deriveSessionState({
        busy,
        pendingQuestion,
        resolved: true,
      });
      lastKnown.set(id, {
        sessionId: id,
        project: locationById.get(id)?.project ?? "",
        state,
        resultAvailable: state === "complete",
        pendingQuestion,
      });
    }
  }

  while (true) {
    await mapWithConcurrency(groupList, DEFAULT_WAIT_CONCURRENCY, pollGroup);
    // resolveWaitSessions seeds lastKnown for every id, so get() is always defined
    // biome-ignore lint/style/noNonNullAssertion: invariant documented above
    const sessions = uniqueIds.map((id) => lastKnown.get(id)!);
    const waker = sessions
      .filter((s) => NEEDS_ATTENTION_STATES.includes(s.state))
      .map((s) => s.sessionId);
    if (waker.length > 0) {
      return { ok: true, sessions, waker, timedOut: false };
    }
    if (Date.now() >= deadline) {
      return { ok: true, sessions, waker: [], timedOut: true };
    }
    const remaining = deadline - Date.now();
    await sleep(Math.min(pollIntervalMs, Math.max(0, remaining)));
  }
}

function parsePendingQuestions(questionRes: {
  res: Response;
  bodyText: string;
}): Map<string, { preview: string; options: string[] }> {
  if (!questionRes.res.ok) return new Map();
  try {
    const entries = pendingQuestionListSchema.parse(
      JSON.parse(questionRes.bodyText),
    );
    return new Map(entries.map((e) => [e.sessionID, formatQuestionEntry(e)]));
  } catch {
    return new Map();
  }
}

// --- messages (bounded full-message read) --------------------------------

const DEFAULT_MESSAGE_LIMIT = 20;
/** Hard maximum for a bounded message read — enforced before any fetch,
 * independent of any server-side limit behavior. */
const MAX_MESSAGE_LIMIT = 200;

export type MessageOpts = CoreOpts & { limit?: number };

export type SessionMessage = {
  id?: string;
  role: string;
  createdAt?: number;
  parts: { type: string; text?: string }[];
};

export type MessagesResult = {
  sessionId: string;
  project: string;
  messages: SessionMessage[];
};

/**
 * Bounded full-message read for a session. Resolves session ownership
 * against the roster (never a caller-supplied directory), then fetches
 * the message list through the same authenticated api() helper every
 * other core function uses. Returns messages in the order the server
 * returns them (chronological — verified live, newest-N ascending; see
 * docs/solutions/documentation-gaps/opencode-server-sse-contract-facts-2026-07-04.md).
 * No directory/credential fields are included in the result.
 */
function isValidMessageLimit(limit: number): boolean {
  return (
    Number.isFinite(limit) &&
    Number.isInteger(limit) &&
    limit > 0 &&
    limit <= MAX_MESSAGE_LIMIT
  );
}

export async function messages(
  sessionId: string,
  opts: MessageOpts,
): Promise<Result<MessagesResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  const limit = opts.limit ?? DEFAULT_MESSAGE_LIMIT;
  if (!isValidMessageLimit(limit)) {
    return err(
      `space-bus: limit must be a finite positive integer no greater than ${MAX_MESSAGE_LIMIT}, got ${limit}`,
    );
  }

  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    sessionId,
  );
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  const { res, bodyText } = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(sessionId)}/message?limit=${limit}`,
  );
  if (!res.ok) {
    return err(
      `space-bus: failed to fetch messages for ${sessionId} (${res.status})`,
    );
  }

  let parsed: z.infer<typeof messageListSchema>;
  try {
    parsed = messageListSchema.parse(JSON.parse(bodyText));
  } catch (e) {
    return err(
      `space-bus: unexpected response shape for session ${sessionId} messages: ${(e as Error).message}`,
    );
  }

  return {
    ok: true,
    sessionId,
    project,
    messages: parsed.map((m) => ({
      id: m.info.id,
      role: m.info.role,
      createdAt: m.info.time?.created,
      parts: m.parts.map((p) => ({ type: p.type, text: p.text })),
    })),
  };
}

// --- questions (full pending-question read) -------------------------------

export type QuestionTarget =
  | { project: string; sessionId?: undefined }
  | { sessionId: string; project?: undefined };

/** One subquestion within a pending-question request — a single request
 * (`requestId`) can carry multiple subquestions, each with its own
 * selection rules and option set. Preserving the full nested list (not
 * just the first subquestion) is required to round-trip a multi-question
 * request through answerQuestion()'s cardinality check. */
export type PendingSubquestion = {
  header?: string;
  question: string;
  multiple: boolean;
  custom: boolean;
  options: { label: string; description?: string }[];
};

export type PendingQuestionView = {
  requestId: string;
  sessionId: string;
  questions: PendingSubquestion[];
};

export type QuestionsResult = { questions: PendingQuestionView[] };

function toPendingQuestionView(
  entry: z.infer<typeof pendingQuestionListSchema>[number],
): PendingQuestionView {
  return {
    requestId: entry.id,
    sessionId: entry.sessionID,
    questions: (entry.questions ?? []).map((q) => ({
      header: q.header,
      question: q.question ?? "",
      multiple: q.multiple ?? false,
      custom: q.custom ?? false,
      options: (q.options ?? []).map((o) => ({
        label: o.label ?? "",
        description: o.description,
      })),
    })),
  };
}

/**
 * Resolves a questions() target to a fetchable directory. Exactly one of
 * project/sessionId must be present; both-present and neither-present are
 * rejected before any fetch. Returns the optional sessionFilter so the
 * caller can post-filter a project-directory's /question list down to one
 * session's entries.
 */
async function resolveQuestionsTarget(
  target: QuestionTarget,
  baseUrl: string,
  credentials: Credentials,
  projects: ProjectSchema[],
): Promise<Result<{ directory: string; sessionFilter: string | undefined }>> {
  const hasProject = "project" in target && !!target.project;
  const hasSessionId = "sessionId" in target && !!target.sessionId;

  if (hasProject && hasSessionId) {
    return err(
      "space-bus: questions target must specify exactly one of project or sessionId, not both",
    );
  }
  if (!hasProject && !hasSessionId) {
    return err(
      "space-bus: questions target must specify exactly one of project or sessionId",
    );
  }

  if (hasProject) {
    const projRes = resolveProjectOrErr(
      projects,
      (target as { project: string }).project,
    );
    if (!projRes.ok) return projRes;
    return {
      ok: true,
      directory: projRes.project.expandedPath,
      sessionFilter: undefined,
    };
  }

  const targetSessionId = (target as { sessionId: string }).sessionId;
  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    targetSessionId,
  );
  if (!loc.ok) return loc;
  return { ok: true, directory: loc.directory, sessionFilter: targetSessionId };
}

/**
 * Complete project- or session-scoped pending-question read. Resolves the
 * target to a manifest project (or a roster-owned session's project)
 * before fetching /question, then returns the full current contract
 * (requestID, sessionID, header/question text, selection rules, and
 * option labels/descriptions) with no directory/credential fields.
 */
export async function questions(
  target: QuestionTarget,
  opts: CoreOpts,
): Promise<Result<QuestionsResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  const targetRes = await resolveQuestionsTarget(
    target,
    baseUrl,
    credentials,
    projects,
  );
  if (!targetRes.ok) return targetRes;
  const { directory, sessionFilter } = targetRes;

  const { res, bodyText } = await api(
    baseUrl,
    credentials,
    directory,
    "/question",
  );
  if (!res.ok) {
    return err(`space-bus: failed to fetch questions (${res.status})`);
  }

  let entries: z.infer<typeof pendingQuestionListSchema>;
  try {
    entries = pendingQuestionListSchema.parse(JSON.parse(bodyText));
  } catch (e) {
    return err(
      `space-bus: unexpected response shape for questions: ${(e as Error).message}`,
    );
  }

  const filtered = sessionFilter
    ? entries.filter((e) => e.sessionID === sessionFilter)
    : entries;

  return { ok: true, questions: filtered.map(toPendingQuestionView) };
}

// --- answerQuestion (explicit question answer) -----------------------------

export type AnswerQuestionArgs = {
  sessionId: string;
  requestId: string;
  answers: string[][];
};

export type AnswerQuestionResult = {
  sessionId: string;
  requestId: string;
};

/**
 * Explicit question answer. Resolves the session to its owning project,
 * fetches the session's pending questions, and verifies the supplied
 * requestID actually belongs to that session before sending the reply —
 * a requestID for a different session is refused before any mutation.
 * Sends the complete string[][] answers payload; the server's /question
 * route expects the requestID (que_...), never an SSE envelope id.
 */
/**
 * Runtime shape check for the answers payload: must be a non-empty array
 * of arrays of strings. TypeScript's `string[][]` parameter type is
 * erased at runtime — a caller across a JSON/MCP boundary can hand us
 * anything, and this function is a mutation, so malformed input must be
 * rejected before any network call rather than surfacing as a confusing
 * upstream 400.
 */
function isValidAnswersShape(value: unknown): value is string[][] {
  if (!Array.isArray(value) || value.length === 0) return false;
  return value.every(
    (row) =>
      Array.isArray(row) && row.every((cell) => typeof cell === "string"),
  );
}

export async function answerQuestion(
  args: AnswerQuestionArgs,
  opts: CoreOpts,
): Promise<Result<AnswerQuestionResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  if (!isValidAnswersShape(args.answers)) {
    return err(
      "space-bus: answers must be a non-empty array of string arrays (string[][])",
    );
  }

  const loc = await findSessionDirectory(
    baseUrl,
    credentials,
    projects,
    args.sessionId,
  );
  if (!loc.ok) return loc;
  const { directory } = loc;

  const questionsRes = await api(baseUrl, credentials, directory, "/question");
  if (!questionsRes.res.ok) {
    return err(
      `space-bus: failed to fetch questions for session ${args.sessionId} (${questionsRes.res.status})`,
    );
  }
  let pendingList: z.infer<typeof pendingQuestionListSchema>;
  try {
    pendingList = pendingQuestionListSchema.parse(
      JSON.parse(questionsRes.bodyText),
    );
  } catch (e) {
    return err(
      `space-bus: unexpected response shape for questions: ${(e as Error).message}`,
    );
  }

  const pending = pendingList.find(
    (q) => q.id === args.requestId && q.sessionID === args.sessionId,
  );
  if (!pending) {
    return err(
      `space-bus: request ${args.requestId} does not belong to a pending question on session ${args.sessionId} — refusing to answer`,
    );
  }

  // `questions` must be present and non-empty to compute cardinality at
  // all — an entry with missing/empty subquestion metadata is not a
  // 1-row request by default; that would silently accept an arbitrary
  // answers shape against upstream data we can't actually verify.
  if (!pending.questions || pending.questions.length === 0) {
    return err(
      `space-bus: request ${args.requestId} for session ${args.sessionId} has no subquestion metadata — refusing to answer without a verified cardinality`,
    );
  }

  const expectedRows = pending.questions.length;
  if (args.answers.length !== expectedRows) {
    return err(
      `space-bus: answers has ${args.answers.length} row(s) but request ${args.requestId} has ${expectedRows} subquestion(s) — refusing to answer with mismatched cardinality`,
    );
  }

  const replyRes = await api(
    baseUrl,
    credentials,
    directory,
    `/question/${encodeURIComponent(args.requestId)}/reply`,
    {
      method: "POST",
      body: JSON.stringify({ answers: args.answers }),
    },
  );
  if (!replyRes.res.ok) {
    return err(
      `space-bus: failed to answer question ${args.requestId} for session ${args.sessionId} (${replyRes.res.status})`,
    );
  }

  return { ok: true, sessionId: args.sessionId, requestId: args.requestId };
}
