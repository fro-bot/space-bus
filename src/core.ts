import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const manifestSchema = z.object({
  server: z.object({ baseUrl: z.string() }),
  projects: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      description: z.string(),
    }),
  ),
});

type Manifest = z.infer<typeof manifestSchema>;

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

function loadManifest(): Manifest {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifestPath = resolve(here, "..", "workspace.json");
  let raw: string;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch (err) {
    throw new Error(`space-bus: cannot read manifest at ${manifestPath}: ${(err as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`space-bus: manifest at ${manifestPath} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`space-bus: manifest at ${manifestPath} failed schema validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

const manifest = loadManifest();

type Project = Manifest["projects"][number] & { expandedPath: string };

const projects: Project[] = manifest.projects.map((p) => ({
  ...p,
  expandedPath: expandHome(p.path),
}));

function findProject(name: string): Project | undefined {
  return projects.find((p) => p.name === name);
}

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
}

// --- HTTP helper -----------------------------------------------------------

function authHeader(): Record<string, string> {
  const password = process.env["OPENCODE_SERVER_PASSWORD"];
  if (!password) return {};
  const username = process.env["OPENCODE_SERVER_USERNAME"] ?? "opencode";
  const token = Buffer.from(`${username}:${password}`).toString("base64");
  return { Authorization: `Basic ${token}` };
}

async function api(
  directory: string,
  path: string,
  init?: RequestInit,
): Promise<{ res: Response; bodyText: string }> {
  const res = await fetch(`${manifest.server.baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...authHeader(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const bodyText = await res.text().catch(() => "<unreadable body>");
  return { res, bodyText };
}

// --- Loose response schemas (parse only fields we consume) -----------------

const sessionSchema = z
  .object({
    id: z.string(),
    directory: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();

const sessionListSchema = z.array(sessionSchema);

const sessionStatusMapSchema = z.record(
  z.string(),
  z.object({ type: z.string() }).passthrough(),
);

const todoSchema = z
  .array(z.object({ content: z.string(), status: z.string(), priority: z.string() }).passthrough())
  .default([]);

const diffEntrySchema = z
  .object({
    file: z.string().optional(),
    additions: z.number(),
    deletions: z.number(),
    status: z.string().optional(),
  })
  .passthrough();

const diffSchema = z.array(diffEntrySchema).default([]);

const vcsStatusEntrySchema = z
  .object({
    file: z.string(),
    additions: z.number(),
    deletions: z.number(),
    status: z.string().optional(),
  })
  .passthrough();

const vcsStatusSchema = z.array(vcsStatusEntrySchema).default([]);

export type DiffSource = "session" | "turns" | "working-tree";

// Loose schema for per-turn diffs embedded on user messages
// (info.summary.diffs). Upstream opencode #30127 (v1.16.0) zeroes
// session-level diff summaries, so /session/{id}/diff returns [] even
// though per-turn diffs on messages remain intact (including untracked
// files). We aggregate those as a fallback, last-turn-wins per file —
// same semantics as upstream PR #33444.
const turnDiffEntrySchema = z
  .object({
    file: z.string().optional(),
    additions: z.number(),
    deletions: z.number(),
    status: z.string().optional(),
  })
  .passthrough();

const turnMessageSchema = z
  .object({
    info: z
      .object({
        role: z.string(),
        summary: z
          .object({
            diffs: z.array(turnDiffEntrySchema).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

const turnMessageListSchema = z.array(turnMessageSchema);

// Session-level summary populated by harness builds carrying upstream
// #33444 (e.g. 1.17.13+harness.ee55e157). GET /session/{id}.summary.diffs
// mirrors the same per-file shape as the per-turn diffs above; when
// present it's equivalent fidelity to /session/{id}/diff, so it reports
// diffSource "session" too. Optional/absent on stock 1.16+ binaries.
const sessionSummarySchema = z
  .object({
    summary: z
      .object({
        diffs: z.array(turnDiffEntrySchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

async function fetchTurnDiffs(
  directory: string,
  sessionId: string,
): Promise<z.infer<typeof diffSchema>> {
  const { res, bodyText } = await api(directory, `/session/${sessionId}/message?limit=100`);
  if (!res.ok) return [];
  let messages: z.infer<typeof turnMessageListSchema>;
  try {
    messages = turnMessageListSchema.parse(JSON.parse(bodyText));
  } catch {
    return [];
  }
  const byFile = new Map<string, z.infer<typeof diffEntrySchema>>();
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
  directory: string,
  sessionId: string,
): Promise<{ diff: z.infer<typeof diffSchema>; diffSource: DiffSource }> {
  const diffRes = await api(directory, `/session/${sessionId}/diff`);
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
    const sessionRes = await api(directory, `/session/${sessionId}`);
    if (sessionRes.res.ok) {
      const parsed = sessionSummarySchema.parse(JSON.parse(sessionRes.bodyText));
      const summaryDiffs = parsed.summary?.diffs;
      if (summaryDiffs && summaryDiffs.length > 0) {
        return { diff: summaryDiffs, diffSource: "session" };
      }
    }
  } catch {
    // ignore, fall through to per-turn aggregation
  }
  try {
    const turnDiffs = await fetchTurnDiffs(directory, sessionId);
    if (turnDiffs.length > 0) {
      return { diff: turnDiffs, diffSource: "turns" };
    }
  } catch {
    // ignore, fall through to working-tree fallback
  }
  try {
    const vcsRes = await api(directory, "/vcs/status");
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

const messagePartSchema = z.object({ type: z.string(), text: z.string().optional() }).passthrough();

const messageEnvelopeSchema = z
  .object({
    info: z.object({ role: z.string() }).passthrough(),
    parts: z.array(messagePartSchema),
  })
  .passthrough();

const messageListSchema = z.array(messageEnvelopeSchema);

// --- Path guard --------------------------------------------------------------

function resolveProjectOrErr(name: string): Result<{ project: Project }> {
  const project = findProject(name);
  if (!project) {
    const valid = projects.map((p) => p.name).join(", ");
    return err(`space-bus: unknown project "${name}". Valid projects: ${valid}`);
  }
  if (!existsSync(project.expandedPath)) {
    return err(`space-bus: project "${name}" path does not exist on disk: ${project.expandedPath}`);
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

export async function roster(): Promise<Result<{ projects: RosterProject[] }>> {
  const results = await Promise.all(
    projects.map(async (p): Promise<RosterProject> => {
      const pathExists = existsSync(p.expandedPath);
      if (!pathExists) {
        return { name: p.name, path: p.expandedPath, description: p.description, pathExists: false };
      }
      try {
        const [statusRes, listRes] = await Promise.all([
          api(p.expandedPath, "/session/status"),
          api(p.expandedPath, "/session?limit=101"),
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
        const statusMap = sessionStatusMapSchema.parse(JSON.parse(statusRes.bodyText));
        const sessions = sessionListSchema.parse(JSON.parse(listRes.bodyText));
        const busyCount = Object.values(statusMap).filter((s) => s.type === "busy" || s.type === "retry").length;
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
  project: string,
  prompt: string,
  title?: string,
): Promise<Result<{ sessionId: string; project: string; directory: string }>> {
  const resolved = resolveProjectOrErr(project);
  if (!resolved.ok) return resolved;
  const directory = resolved.project.expandedPath;

  const sessionTitle = title ?? `bus: ${prompt.slice(0, 60)}`;
  const createRes = await api(directory, "/session", {
    method: "POST",
    body: JSON.stringify({ title: sessionTitle }),
  });
  if (!createRes.res.ok) {
    return err(`space-bus: failed to create session in "${project}" (${createRes.res.status}): ${createRes.bodyText}`);
  }
  let session: z.infer<typeof sessionSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(createRes.bodyText));
  } catch (e) {
    return err(`space-bus: unexpected /session response shape: ${(e as Error).message}`);
  }

  const promptRes = await api(directory, `/session/${session.id}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }),
  });
  if (promptRes.res.status !== 204) {
    return err(
      `space-bus: dispatch to "${project}" failed sending prompt (${promptRes.res.status}): ${promptRes.bodyText}`,
    );
  }

  return { ok: true, sessionId: session.id, project, directory };
}

export type DispatchResult = {
  sessionId: string;
  project: string;
  mode: "new" | "question-reply" | "follow-up";
  directory?: string;
};

export async function dispatch(args: {
  project?: string;
  prompt: string;
  title?: string;
  sessionId?: string;
}): Promise<Result<DispatchResult>> {
  if (!args.sessionId) {
    if (!args.project) {
      return err("space-bus: project is required when starting a new session");
    }
    const r = await dispatchNew(args.project, args.prompt, args.title);
    if (!r.ok) return r;
    return { ok: true, sessionId: r.sessionId, project: r.project, mode: "new", directory: r.directory };
  }

  const loc = await findSessionDirectory(args.sessionId);
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  if (args.project && args.project !== project) {
    return err(
      `space-bus: session ${args.sessionId} belongs to project "${project}", not "${args.project}" — refusing to steer the wrong session`,
    );
  }

  return steerSession(args.sessionId, args.prompt, directory, project);
}

// --- session resolution by id (try each project's directory) ------------------

async function findSessionDirectory(sessionId: string): Promise<Result<{ directory: string; project: string }>> {
  // Session lookup succeeds regardless of which directory header is sent (the
  // session store is global), so probe with any reachable project directory
  // and trust the returned session's own `directory` field to identify the
  // owning manifest project.
  for (const p of projects) {
    if (!existsSync(p.expandedPath)) continue;
    const { res, bodyText } = await api(p.expandedPath, `/session/${sessionId}`);
    if (!res.ok) continue;
    let session: z.infer<typeof sessionSchema>;
    try {
      session = sessionSchema.parse(JSON.parse(bodyText));
    } catch {
      continue;
    }
    const owner = session.directory ? projects.find((proj) => proj.expandedPath === session.directory) : undefined;
    if (owner) {
      return { ok: true, directory: owner.expandedPath, project: owner.name };
    }
    // Session exists but its directory isn't a manifest project (shouldn't
    // happen for bus-dispatched sessions) — fall back to the probing project.
    return { ok: true, directory: p.expandedPath, project: p.name };
  }
  return err(`space-bus: no manifest project has a session with id ${sessionId}`);
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
};

const pendingQuestionEntrySchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    questions: z
      .array(
        z
          .object({
            question: z.string().optional(),
            options: z.array(z.object({ label: z.string().optional() }).passthrough()).optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const pendingQuestionListSchema = z.array(pendingQuestionEntrySchema);

async function fetchPendingQuestion(
  directory: string,
  sessionId: string,
): Promise<{ preview: string; options: string[] } | undefined> {
  try {
    const { res, bodyText } = await api(directory, "/question");
    if (!res.ok) return undefined;
    const entries = pendingQuestionListSchema.parse(JSON.parse(bodyText));
    const entry = entries.find((e) => e.sessionID === sessionId);
    if (!entry) return undefined;
    const firstQuestion = entry.questions?.[0];
    const text = firstQuestion?.question ?? "";
    const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
    const options = (firstQuestion?.options ?? []).map((o) => o.label ?? "").filter((l) => l.length > 0);
    return { preview, options };
  } catch {
    return undefined;
  }
}

export async function status(sessionId: string): Promise<Result<SessionStatusResult>> {
  const loc = await findSessionDirectory(sessionId);
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  const [sessionRes, statusMapRes, todoRes, diffResult, pendingQuestion] = await Promise.all([
    api(directory, `/session/${sessionId}`),
    api(directory, "/session/status"),
    api(directory, `/session/${sessionId}/todo`),
    fetchDiffWithFallback(directory, sessionId),
    fetchPendingQuestion(directory, sessionId),
  ]);

  if (!sessionRes.res.ok) {
    return err(`space-bus: failed to fetch session ${sessionId} (${sessionRes.res.status}): ${sessionRes.bodyText}`);
  }

  let session: z.infer<typeof sessionSchema>;
  let statusMap: z.infer<typeof sessionStatusMapSchema>;
  let todos: z.infer<typeof todoSchema>;
  try {
    session = sessionSchema.parse(JSON.parse(sessionRes.bodyText));
    statusMap = statusMapRes.res.ok ? sessionStatusMapSchema.parse(JSON.parse(statusMapRes.bodyText)) : {};
    todos = todoRes.res.ok ? todoSchema.parse(JSON.parse(todoRes.bodyText)) : [];
  } catch (e) {
    return err(`space-bus: unexpected response shape for session ${sessionId}: ${(e as Error).message}`);
  }

  const entry = statusMap[sessionId];
  const busy = entry ? entry.type === "busy" || entry.type === "retry" : false;

  const { diff, diffSource } = diffResult;
  const additions = diff.reduce((sum, d) => sum + d.additions, 0);
  const deletions = diff.reduce((sum, d) => sum + d.deletions, 0);

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
  };
}

// --- steering (question-reply / follow-up) ------------------------------------

const questionEntrySchema = z.object({ id: z.string(), sessionID: z.string() }).passthrough();
const questionListSchema = z.array(questionEntrySchema);

async function steerSession(
  sessionId: string,
  message: string,
  directory: string,
  project: string,
): Promise<Result<DispatchResult>> {
  const questionsRes = await api(directory, "/question");
  if (questionsRes.res.ok) {
    let questions: z.infer<typeof questionListSchema>;
    try {
      questions = questionListSchema.parse(JSON.parse(questionsRes.bodyText));
    } catch {
      questions = [];
    }
    const pending = questions.find((q) => q.sessionID === sessionId);
    if (pending) {
      const replyRes = await api(directory, `/question/${pending.id}/reply`, {
        method: "POST",
        body: JSON.stringify({ answers: [[message]] }),
      });
      if (!replyRes.res.ok) {
        return err(
          `space-bus: failed to reply to question ${pending.id} for session ${sessionId} (${replyRes.res.status}): ${replyRes.bodyText}`,
        );
      }
      return { ok: true, sessionId, project, mode: "question-reply" };
    }
  }

  const promptRes = await api(directory, `/session/${sessionId}/prompt_async`, {
    method: "POST",
    body: JSON.stringify({ parts: [{ type: "text", text: message }] }),
  });
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
  diff: { file?: string; additions: number; deletions: number; status?: string }[];
  diffSource: DiffSource;
};

export async function result(sessionId: string): Promise<Result<SessionResultResult>> {
  const loc = await findSessionDirectory(sessionId);
  if (!loc.ok) return loc;
  const { directory, project } = loc;

  const statusMapRes = await api(directory, "/session/status");
  if (statusMapRes.res.ok) {
    try {
      const statusMap = sessionStatusMapSchema.parse(JSON.parse(statusMapRes.bodyText));
      const entry = statusMap[sessionId];
      if (entry && (entry.type === "busy" || entry.type === "retry")) {
        return err(`space-bus: session ${sessionId} is still running, use bus_status`);
      }
    } catch {
      // ignore malformed status map, proceed
    }
  }

  const [messageRes, diffResult] = await Promise.all([
    api(directory, `/session/${sessionId}/message?limit=50`),
    fetchDiffWithFallback(directory, sessionId),
  ]);

  if (!messageRes.res.ok) {
    return err(`space-bus: failed to fetch messages for ${sessionId} (${messageRes.res.status}): ${messageRes.bodyText}`);
  }

  let messages: z.infer<typeof messageListSchema>;
  try {
    messages = messageListSchema.parse(JSON.parse(messageRes.bodyText));
  } catch (e) {
    return err(`space-bus: unexpected response shape for session ${sessionId}: ${(e as Error).message}`);
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
