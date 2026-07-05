/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Browser-safe managed-server resolver: reads the same on-disk discovery
 * contract as discovery.ts's Node-only writer, but through injected
 * filesystem/env/crypto seams so it can run in a webview (e.g. a Tauri
 * app) with zero node:fs/os/path/crypto/child_process imports. This is the
 * ONE function external attachers should call instead of reimplementing
 * space-bus's hash+path+discovery-schema+auth convention themselves.
 *
 * Decisions worth flagging explicitly:
 *
 * - XDG_STATE_HOME semantics: discovery.ts's stateDirFor uses
 *   `process.env["XDG_STATE_HOME"] ?? default` — an explicitly-set EMPTY
 *   string would be used as-is (falsy-but-defined, `??` only falls back on
 *   null/undefined). Here, `seams.env()` is contracted to return null for
 *   unset OR empty, so an empty-string override can never reach this code
 *   distinctly from "unset" — both collapse to the default. This is a
 *   deliberate, documented simplification: nobody sets XDG_STATE_HOME="" in
 *   practice, and the alternative (a raw env seam preserving "" vs null)
 *   would leak Node-ism into the seam contract for no real gain.
 *
 * - Liveness classification: this browser-safe lane has no pid to inspect
 *   (verifyIdentity is Node-only, via ps/process.kill), so liveness is
 *   reported via an authenticated HTTP probe instead:
 *     - 2xx response  -> ok:true, alive:true (the only value `alive` ever
 *       takes in a successful Result — there is no ok:true/alive:false
 *       case, see below).
 *     - 401            -> ok:false, "rejected credentials" — the daemon is
 *       up but the discovery file's password doesn't match (stale
 *       discovery from a since-restarted daemon). Distinct and actionable:
 *       restarting the *caller's* attach won't fix this, the workspace
 *       daemon needs a restart.
 *     - fetch throws / any other non-2xx -> ok:false, "not answering" —
 *       treated as an actionable failure (not a silent alive:false) because
 *       callers need something to show the user, not a value to ignore.
 *   Net effect: ok:true always means "reachable and authenticated"; every
 *   dead/misconfigured case surfaces as a distinct ok:false message instead
 *   of an opaque status. This is what replaces the generic core.ts `599`
 *   for this one call site.
 */
import { discoveryFileSchema, loopbackOk } from "./contract";

type Ok<T> = { ok: true } & T;
type Err = { ok: false; error: string };
export type Result<T> = Ok<T> | Err;

function err(error: string): Err {
  return { ok: false, error };
}

export interface AttachSeams {
  /** Canonicalize an absolute path (realpath); null if it doesn't exist. */
  realpath(path: string): Promise<string | null>;
  /** Read a file as utf8; null if absent/unreadable. */
  readTextFile(path: string): Promise<string | null>;
  /** Read an env var; null if unset/empty. */
  env(name: string): Promise<string | null>;
  /** Absolute home dir (for the ~/.local/state default). */
  homeDir(): Promise<string>;
}

export interface ResolvedManagedServer {
  baseUrl: string;
  credentials: { username: "opencode"; password: string };
  alive: true;
}

// --- pure helpers (browser-safe: no node:path, no node:crypto) -------------

/** Pure posix path join — avoids node:path in a browser-safe module. */
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

/** First 16 hex chars of sha256(input), via Web Crypto (no node:crypto). */
async function sha256Hex16(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}

function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function authHeader(password: string): Record<string, string> {
  const token = toBase64(`opencode:${password}`);
  return { Authorization: `Basic ${token}` };
}

// --- roster path resolution (mirrors config.ts's resolveRosterPath) -------

async function resolveRosterPath(
  workspaceDir: string,
  seams: AttachSeams,
): Promise<Result<{ rosterPath: string }>> {
  const override = await seams.env("SPACE_BUS_CONFIG");
  let candidate: string;
  if (override) {
    if (override.includes("://")) {
      return err(
        `space-bus: SPACE_BUS_CONFIG needs an absolute filesystem path or a ~-prefixed path, not a URL (got: ${override})`,
      );
    }
    // Only the "~/" prefix expands here (unlike config.ts's expandHome,
    // which also treats a bare "~" as home) — a bare "~" falls through to
    // the absolute-path rejection below; inconsequential in practice.
    const expanded = override.startsWith("~/")
      ? posixJoin(await seams.homeDir(), override.slice(2))
      : override;
    if (!expanded.startsWith("/")) {
      return err(
        `space-bus: SPACE_BUS_CONFIG needs an absolute filesystem path or a ~-prefixed path (got: ${override})`,
      );
    }
    candidate = expanded;
  } else {
    candidate = posixJoin(workspaceDir, "spacebus.json");
  }

  const canonical = await seams.realpath(candidate);
  if (canonical === null) {
    return err(`space-bus: no spacebus.json at ${candidate}`);
  }
  return { ok: true, rosterPath: canonical };
}

// --- state dir / discovery path (mirrors discovery.ts's stateDirFor) ------

async function discoveryPathFor(
  rosterPath: string,
  seams: AttachSeams,
): Promise<string> {
  const xdgStateHome = await seams.env("XDG_STATE_HOME");
  const base =
    xdgStateHome ?? posixJoin(await seams.homeDir(), ".local", "state");
  const hash = await sha256Hex16(rosterPath);
  return posixJoin(base, "space-bus", hash, "discovery.json");
}

// --- public entry point ------------------------------------------------------

export async function resolveManagedServer(
  workspaceDir: string,
  seams: AttachSeams,
): Promise<Result<ResolvedManagedServer>> {
  const rosterResult = await resolveRosterPath(workspaceDir, seams);
  if (!rosterResult.ok) return rosterResult;
  const { rosterPath } = rosterResult;

  const discoveryPath = await discoveryPathFor(rosterPath, seams);

  const raw = await seams.readTextFile(discoveryPath);
  if (raw === null) {
    return err(
      "space-bus: managed space-bus server is not running for this workspace (no discovery file) — run `space-bus serve` in the workspace (or use a space-bus tool in an opencode session)",
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return err(
      `space-bus: discovery file at ${discoveryPath} is not valid JSON: ${(e as Error).message}`,
    );
  }

  const parsed = discoveryFileSchema.safeParse(json);
  if (!parsed.success) {
    return err(
      `space-bus: discovery file at ${discoveryPath} failed schema validation: ${parsed.error.message}`,
    );
  }
  const discovery = parsed.data;

  if (!loopbackOk(discovery.baseUrl)) {
    const host = (() => {
      try {
        return new URL(discovery.baseUrl).hostname;
      } catch {
        return discovery.baseUrl;
      }
    })();
    return err(
      `space-bus: refusing to send credentials off-machine (got ${host})`,
    );
  }

  const probe = await probeLiveness(discovery.baseUrl, discovery.password);
  if (!probe.ok) return probe;

  return {
    ok: true,
    baseUrl: discovery.baseUrl,
    credentials: { username: "opencode", password: discovery.password },
    alive: true,
  };
}

// --- liveness probe -----------------------------------------------------------

async function probeLiveness(
  baseUrl: string,
  password: string,
): Promise<{ ok: true } | Err> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/session?limit=1`, {
      headers: authHeader(password),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    return err(
      `space-bus: managed daemon not answering at ${baseUrl} — it may have exited; run \`space-bus serve\` in the workspace to restart it`,
    );
  }

  if (res.status === 401) {
    return err(
      "space-bus: managed server rejected credentials (stale discovery?) — restart the workspace daemon",
    );
  }

  if (!res.ok) {
    return err(
      `space-bus: managed daemon not answering at ${baseUrl} — it may have exited; run \`space-bus serve\` in the workspace to restart it`,
    );
  }

  return { ok: true };
}
