import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  pendingQuestionEntrySchema,
  sessionSchema,
  sessionStateInfoSchema,
  sessionStateSchema,
  sessionStatusMapSchema,
  turnMessageSchema,
  vcsStatusEntrySchema,
} from "./contract";

describe("contract schemas", () => {
  test("sessionSchema parses a representative session", () => {
    const parsed = sessionSchema.parse({
      id: "ses_1",
      directory: "/tmp/proj",
      title: "hello",
    });
    expect(parsed).toEqual({
      id: "ses_1",
      directory: "/tmp/proj",
      title: "hello",
    });
  });

  test("sessionSchema passthrough preserves unknown fields", () => {
    const parsed = sessionSchema.parse({
      id: "ses_1",
      unknownField: "surprise",
    });
    expect((parsed as Record<string, unknown>)["unknownField"]).toBe(
      "surprise",
    );
  });

  test("sessionStatusMapSchema parses a representative status map", () => {
    const parsed = sessionStatusMapSchema.parse({
      ses_1: { type: "busy" },
      ses_2: { type: "idle", extra: "field" },
    });
    expect(parsed["ses_1"]?.type).toBe("busy");
    expect((parsed["ses_2"] as Record<string, unknown>)["extra"]).toBe("field");
  });

  test("sessionStateSchema accepts the 5 normalized states", () => {
    for (const s of [
      "running",
      "blocked",
      "complete",
      "failed",
      "not_found",
    ] as const) {
      expect(sessionStateSchema.parse(s)).toBe(s);
    }
  });

  test("sessionStateSchema rejects an unknown string", () => {
    expect(() => sessionStateSchema.parse("bogus")).toThrow();
  });

  test("sessionStateInfoSchema round-trips a full object", () => {
    const input = {
      sessionId: "ses_1",
      project: "alpha",
      state: "blocked" as const,
      resultAvailable: false,
      pendingQuestion: { preview: "Proceed?", options: ["Yes", "No"] },
    };
    expect(sessionStateInfoSchema.parse(input)).toEqual(input);
  });

  test("sessionStateInfoSchema round-trips an object without pendingQuestion", () => {
    const input = {
      sessionId: "ses_2",
      project: "beta",
      state: "complete" as const,
      resultAvailable: true,
    };
    expect(sessionStateInfoSchema.parse(input)).toEqual(input);
  });

  test("turnMessageSchema parses info.summary.diffs", () => {
    const parsed = turnMessageSchema.parse({
      info: {
        role: "user",
        summary: {
          diffs: [
            { file: "a.ts", additions: 1, deletions: 0, status: "modified" },
          ],
        },
      },
    });
    expect(parsed.info.summary?.diffs?.[0]?.file).toBe("a.ts");
  });

  test("turnMessageSchema passthrough preserves unknown fields on info", () => {
    const parsed = turnMessageSchema.parse({
      info: { role: "user", weirdField: 42 },
      extraTopLevel: true,
    });
    expect((parsed.info as Record<string, unknown>)["weirdField"]).toBe(42);
    expect((parsed as Record<string, unknown>)["extraTopLevel"]).toBe(true);
  });

  test("pendingQuestionEntrySchema parses questions/options", () => {
    const parsed = pendingQuestionEntrySchema.parse({
      id: "q_1",
      sessionID: "ses_1",
      questions: [
        {
          question: "Pick one",
          options: [{ label: "A" }, { label: "B", weight: 2 }],
        },
      ],
    });
    expect(parsed.questions?.[0]?.question).toBe("Pick one");
    expect(parsed.questions?.[0]?.options?.map((o) => o.label)).toEqual([
      "A",
      "B",
    ]);
    // passthrough on option objects
    expect(
      (parsed.questions?.[0]?.options?.[1] as Record<string, unknown>)[
        "weight"
      ],
    ).toBe(2);
  });

  test("vcsStatusEntrySchema parses a representative entry", () => {
    const parsed = vcsStatusEntrySchema.parse({
      file: "b.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
    });
    expect(parsed).toEqual({
      file: "b.ts",
      additions: 3,
      deletions: 1,
      status: "modified",
    });
  });

  test("vcsStatusEntrySchema passthrough preserves unknown fields", () => {
    const parsed = vcsStatusEntrySchema.parse({
      file: "b.ts",
      additions: 3,
      deletions: 1,
      commitHash: "deadbeef",
    });
    expect((parsed as Record<string, unknown>)["commitHash"]).toBe("deadbeef");
  });
});

describe("contract module purity", () => {
  test("src/contract.ts imports only zod", () => {
    const source = readFileSync(join(import.meta.dir, "contract.ts"), "utf8");
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).toMatch(/from\s+["']zod["']/);
    }
  });
});
