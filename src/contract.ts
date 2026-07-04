/**
 * @experimental
 * Experimental — shapes may change in minor releases. These schemas track
 * the upstream OpenCode server API; they are parsing aids, not a security
 * boundary or compatibility guarantee.
 */
import { z } from "zod";

// --- Loose response schemas (parse only fields we consume) -----------------

export const sessionSchema = z
  .object({
    id: z.string(),
    directory: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();
export type SessionSchema = z.infer<typeof sessionSchema>;

export const sessionListSchema = z.array(sessionSchema);
export type SessionListSchema = z.infer<typeof sessionListSchema>;

export const sessionStatusMapSchema = z.record(
  z.string(),
  z.object({ type: z.string() }).passthrough(),
);
export type SessionStatusMapSchema = z.infer<typeof sessionStatusMapSchema>;

export const todoSchema = z
  .array(
    z
      .object({ content: z.string(), status: z.string(), priority: z.string() })
      .passthrough(),
  )
  .default([]);
export type TodoSchema = z.infer<typeof todoSchema>;

export const diffEntrySchema = z
  .object({
    file: z.string().optional(),
    additions: z.number(),
    deletions: z.number(),
    status: z.string().optional(),
  })
  .passthrough();
export type DiffEntrySchema = z.infer<typeof diffEntrySchema>;

export const diffSchema = z.array(diffEntrySchema).default([]);
export type DiffSchema = z.infer<typeof diffSchema>;

export const vcsStatusEntrySchema = z
  .object({
    file: z.string(),
    additions: z.number(),
    deletions: z.number(),
    status: z.string().optional(),
  })
  .passthrough();
export type VcsStatusEntrySchema = z.infer<typeof vcsStatusEntrySchema>;

export const vcsStatusSchema = z.array(vcsStatusEntrySchema).default([]);
export type VcsStatusSchema = z.infer<typeof vcsStatusSchema>;

// Loose schema for per-turn diffs embedded on user messages
// (info.summary.diffs). Upstream opencode #30127 (v1.16.0) zeroes
// session-level diff summaries, so /session/{id}/diff returns [] even
// though per-turn diffs on messages remain intact (including untracked
// files). We aggregate those as a fallback, last-turn-wins per file —
// same semantics as upstream PR #33444.
export const turnDiffEntrySchema = diffEntrySchema;
export type TurnDiffEntrySchema = z.infer<typeof turnDiffEntrySchema>;

export const turnMessageSchema = z
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
export type TurnMessageSchema = z.infer<typeof turnMessageSchema>;

export const turnMessageListSchema = z.array(turnMessageSchema);
export type TurnMessageListSchema = z.infer<typeof turnMessageListSchema>;

// Session-level summary populated by harness builds carrying upstream
// #33444 (e.g. 1.17.13+harness.ee55e157). GET /session/{id}.summary.diffs
// mirrors the same per-file shape as the per-turn diffs above; when
// present it's equivalent fidelity to /session/{id}/diff, so it reports
// diffSource "session" too. Optional/absent on stock 1.16+ binaries.
export const sessionSummarySchema = z
  .object({
    summary: z
      .object({
        diffs: z.array(turnDiffEntrySchema).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type SessionSummarySchema = z.infer<typeof sessionSummarySchema>;

export const messagePartSchema = z
  .object({ type: z.string(), text: z.string().optional() })
  .passthrough();
export type MessagePartSchema = z.infer<typeof messagePartSchema>;

export const messageEnvelopeSchema = z
  .object({
    info: z.object({ role: z.string() }).passthrough(),
    parts: z.array(messagePartSchema),
  })
  .passthrough();
export type MessageEnvelopeSchema = z.infer<typeof messageEnvelopeSchema>;

export const messageListSchema = z.array(messageEnvelopeSchema);
export type MessageListSchema = z.infer<typeof messageListSchema>;

export const pendingQuestionEntrySchema = z
  .object({
    id: z.string(),
    sessionID: z.string(),
    questions: z
      .array(
        z
          .object({
            question: z.string().optional(),
            options: z
              .array(z.object({ label: z.string().optional() }).passthrough())
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
export type PendingQuestionEntrySchema = z.infer<
  typeof pendingQuestionEntrySchema
>;

export const pendingQuestionListSchema = z.array(pendingQuestionEntrySchema);
export type PendingQuestionListSchema = z.infer<
  typeof pendingQuestionListSchema
>;

export const questionEntrySchema = z
  .object({ id: z.string(), sessionID: z.string() })
  .passthrough();
export type QuestionEntrySchema = z.infer<typeof questionEntrySchema>;

export const questionListSchema = z.array(questionEntrySchema);
export type QuestionListSchema = z.infer<typeof questionListSchema>;
