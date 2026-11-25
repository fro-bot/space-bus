import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoveryManagedOrigin,
  managedBaseUrlOk,
  parseManagedOrigin,
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
    expect(parsed.questions?.[0]?.options?.[1]).toHaveProperty("weight", 2);
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

// Synthetic strings only: this validates the shape of a recorded endpoint, it
// never connects anywhere.
describe("managedBaseUrlOk", () => {
  test.each([
    ["http://127.0.0.1:4096", 4096],
    ["http://127.0.0.1:4096/", 4096],
    ["http://localhost:4096", 4096],
    ["http://LOCALHOST:4096", 4096],
    ["http://[::1]:4096", 4096],
    ["http://[::1]:4096/", 4096],
    ["http://127.0.0.1:80", 80],
    ["http://127.0.0.1", 80],
    ["http://127.0.0.1:65535", 65535],
  ] as const)(
    "accepts the legitimate loopback form %s (recorded port %d)",
    (url, port) => {
      expect(managedBaseUrlOk(url, port)).toBe(true);
      expect(managedBaseUrlOk(url)).toBe(true); // no recorded port: shape only
    },
  );

  test.each([
    ["not a url", 4096],
    ["", 4096],
    ["https://127.0.0.1:4096", 4096],
    ["ftp://127.0.0.1:4096", 4096],
    ["http://example.com:4096", 4096],
    ["http://127.0.0.1.example.com:4096", 4096],
    ["http://user:pass@127.0.0.1:4096", 4096],
    ["http://user@127.0.0.1:4096", 4096],
    ["http://127.0.0.1:4096@example.com", 4096],
    ["http://127.0.0.1:4096/session", 4096],
    ["http://127.0.0.1:4096/?x=1", 4096],
    ["http://127.0.0.1:4096?x=1", 4096],
    ["http://127.0.0.1:4096?", 4096],
    ["http://127.0.0.1:4096#frag", 4096],
    ["http://127.0.0.1:4096//", 4096],
    ["http://127.0.0.1:04096", 4096],
    ["http://127.1:4096", 4096],
    ["http://0x7f.1:4096", 4096],
    ["http://2130706433:4096", 4096],
    ["http://[0:0:0:0:0:0:0:1]:4096", 4096],
    ["http://127.0.0.1:0", 0],
  ] as const)(
    "rejects %p (recorded port %d): not a canonical managed origin",
    (url, port) => {
      expect(managedBaseUrlOk(url, port)).toBe(false);
    },
  );

  test("rejects a URL port that differs from the recorded port, in every form", () => {
    expect(managedBaseUrlOk("http://127.0.0.1:4096", 4097)).toBe(false);
    expect(managedBaseUrlOk("http://[::1]:4096", 1)).toBe(false);
    expect(managedBaseUrlOk("http://127.0.0.1", 4096)).toBe(false); // implicit :80
    expect(managedBaseUrlOk("http://127.0.0.1:80", 4096)).toBe(false);
  });
});

describe("parseManagedOrigin (canonical managed origin)", () => {
  test.each([
    ["http://127.0.0.1:4096", 4096, "http://127.0.0.1:4096"],
    ["http://127.0.0.1:4096/", 4096, "http://127.0.0.1:4096"],
    ["http://LOCALHOST:4096/", 4096, "http://localhost:4096"],
    ["http://localhost:6001", 6001, "http://localhost:6001"],
    ["http://[::1]:5000/", 5000, "http://[::1]:5000"],
    ["http://127.0.0.1", 80, "http://127.0.0.1:80"],
    ["http://127.0.0.1:80/", 80, "http://127.0.0.1:80"],
    ["http://127.0.0.1:65535", 65535, "http://127.0.0.1:65535"],
  ] as const)(
    "%s (port %d) => %s, built from the host literal and port, never the input",
    (input, port, canonical) => {
      expect(parseManagedOrigin(input, port)).toBe(canonical);
      expect(parseManagedOrigin(input)).toBe(canonical); // shape only
    },
  );

  test("the returned origin is always http://<allowed literal>:<numeric port>", () => {
    for (const url of [
      "http://127.0.0.1:4096/",
      "HTTP://LocalHost:4096",
      "http://[::1]:4096/",
    ]) {
      expect(parseManagedOrigin(url)).toMatch(
        /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):[1-9][0-9]{0,4}$/,
      );
    }
  });

  test.each([
    "not a url",
    "https://127.0.0.1:4096",
    "http://user:pw@127.0.0.1:4096",
    "http://127.0.0.1:4096/session",
    "http://127.0.0.1:4096?x=1",
    "http://127.0.0.1:4096//",
    "http://127.0.0.1:04096",
    "http://0x7f.1:4096",
    "http://[0:0:0:0:0:0:0:1]:4096",
    "http://example.com:4096",
    "http://127.0.0.1:0",
  ])("%p => null", (input) => {
    expect(parseManagedOrigin(input)).toBeNull();
  });

  test("a recorded-port mismatch is null", () => {
    expect(parseManagedOrigin("http://127.0.0.1:4096", 4097)).toBeNull();
    expect(parseManagedOrigin("http://127.0.0.1", 4096)).toBeNull();
  });

  test("managedBaseUrlOk stays the boolean view of the same parser", () => {
    for (const [url, port] of [
      ["http://127.0.0.1:4096/", 4096],
      ["http://[::1]:5000", 5000],
      ["http://127.0.0.1:4096/x", 4096],
      ["http://127.0.0.1:4097", 4096],
    ] as const) {
      expect(managedBaseUrlOk(url, port)).toBe(
        parseManagedOrigin(url, port) !== null,
      );
    }
  });

  test("discoveryManagedOrigin checks the RAW spelling before schema normalization", () => {
    expect(
      discoveryManagedOrigin({ baseUrl: "http://LOCALHOST:4096/" }, 4096),
    ).toBe("http://localhost:4096");
    for (const raw of [" http://127.0.0.1:4096", "http://127.0.0.1:4096\t"]) {
      expect(discoveryManagedOrigin({ baseUrl: raw }, 4096)).toBeNull();
    }
    expect(discoveryManagedOrigin(null, 4096)).toBeNull();
    expect(discoveryManagedOrigin({ baseUrl: 4096 }, 4096)).toBeNull();
  });
});
