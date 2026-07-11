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
type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
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
): Promise<Result<{ sessionId: string; project: string; directory: string }>> {
  const resolved = resolveProjectOrErr(projects, project);
  if (!resolved.ok) return resolved;
  const directory = resolved.project.expandedPath;

  const sessionTitle = title ?? `bus: ${prompt.slice(0, 60)}`;
  const createRes = await api(baseUrl, credentials, directory, "/session", {
    method: "POST",
    body: JSON.stringify({ title: sessionTitle }),
  });
  if (!createRes.res.ok) {
    return err(
      `space-bus: failed to create session in "${project}" (${createRes.res.status}): ${createRes.bodyText}`,
    );
  }
  let session: z.infer<typeof sessionSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(createRes.bodyText));
  } catch (e) {
    return err(
      `space-bus: unexpected /session response shape: ${(e as Error).message}`,
    );
  }

  const promptRes = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(session.id)}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
    },
  );
  if (promptRes.res.status !== 204) {
    return err(
      `space-bus: dispatch to "${project}" failed sending prompt (${promptRes.res.status}): ${promptRes.bodyText}`,
    );
  }

  return { ok: true, sessionId: session.id, project, directory };
}

export type DispatchResult = { sessionId: string; project: string } & (
  | { mode: "new"; directory: string }
  | { mode: "question-reply" | "follow-up" }
);

// project stays allowed alongside sessionId (the mismatch guard in the
// steering path consumes it) but a bare {prompt} with neither is now a
// compile error — new sessions require project, steering requires
// sessionId.
export type DispatchArgs = {
  prompt: string;
  title?: string;
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
}): Result<DispatchArgs> {
  if (input.sessionId !== undefined && input.sessionId === "") {
    return err("space-bus: sessionId must be a non-empty string");
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
    };
  }
  return {
    ok: true,
    prompt: input.prompt,
    title: input.title,
    sessionId: input.sessionId,
    project: input.project,
  };
}

export async function dispatch(
  args: DispatchArgs,
  opts: CoreOpts,
): Promise<Result<DispatchResult>> {
  const ctx = validateContext(opts.context);
  if (!ctx.ok) return ctx;
  const { baseUrl, projects, credentials } = ctx;

  if (args.sessionId !== undefined && args.sessionId === "") {
    return err("space-bus: sessionId must be a non-empty string");
  }

  if (!args.sessionId) {
    if (!args.project) {
      return err("space-bus: project is required when starting a new session");
    }
    const r = await dispatchNew(
      baseUrl,
      credentials,
      projects,
      args.project,
      args.prompt,
      args.title,
    );
    if (!r.ok) return r;
    return {
      ok: true,
      sessionId: r.sessionId,
      project: r.project,
      mode: "new",
      directory: r.directory,
    };
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

async function steerSession(
  baseUrl: string,
  credentials: Credentials,
  sessionId: string,
  message: string,
  directory: string,
  project: string,
): Promise<Result<DispatchResult>> {
  const questionsRes = await api(baseUrl, credentials, directory, "/question");
  if (questionsRes.res.ok) {
    let questions: z.infer<typeof questionListSchema>;
    try {
      questions = questionListSchema.parse(JSON.parse(questionsRes.bodyText));
    } catch {
      questions = [];
    }
    const pending = questions.find((q) => q.sessionID === sessionId);
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
        return err(
          `space-bus: failed to reply to question ${pending.id} for session ${sessionId} (${replyRes.res.status}): ${replyRes.bodyText}`,
        );
      }
      return { ok: true, sessionId, project, mode: "question-reply" };
    }
  }

  const promptRes = await api(
    baseUrl,
    credentials,
    directory,
    `/session/${encodeURIComponent(sessionId)}/prompt_async`,
    {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
    },
  );
  if (promptRes.res.status !== 204) {
    return err(
      `space-bus: follow-up prompt to session ${sessionId} failed (${promptRes.res.status}): ${promptRes.bodyText}`,
    );
  }
  return { ok: true, sessionId, project, mode: "follow-up" };
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
