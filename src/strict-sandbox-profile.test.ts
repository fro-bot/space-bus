/**
 * The shared test-harness sandbox profile (scripts/verify-host-matrix.ts
 * makeIso, used by the U1 loader check and the U2 delegation check) must deny
 * every write outside the run's work dir, deny the real home, and allow only
 * loopback network. A real `sandbox-exec` child proves it, with a loose
 * profile as the negative control (so the probe can tell the difference).
 *
 * macOS only (sandbox-exec). No external network: the network egress probes of
 * the full self-test (which run an unsandboxed control against the internet)
 * are NOT repeated here. Canaries live in private directories this test
 * creates and always removes.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  BASE_PATH,
  inSandbox,
  makeIso,
  WORK_MARKER,
} from "../scripts/verify-host-matrix";

const onMac =
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");

const PROBE = `
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const [out1, out2, work, name] = process.argv.slice(2);
const t = (fn) => { try { fn(); return "allowed"; } catch (e) { return "denied:" + e.code; } };
console.log(JSON.stringify({
  writeOutsideTmp: t(() => writeFileSync(join(out1, name), "x", { flag: "wx" })),
  writeOutsideVarTmp: t(() => writeFileSync(join(out2, name), "x", { flag: "wx" })),
  mkdirOutside: t(() => mkdirSync(join(out1, name + "-d"))),
  writeWork: t(() => writeFileSync(join(work, name), "x", { flag: "wx" })),
}));`;

const cleanup: string[] = [];
afterAll(() => {
  for (const d of cleanup) rmSync(d, { recursive: true, force: true });
});

function probe(profile: string, work: string, node: string) {
  const out1 = mkdtempSync("/private/tmp/hm-profile-test-");
  const out2 = mkdtempSync("/private/var/tmp/hm-profile-test-");
  cleanup.push(out1, out2);
  const script = join(work, "probe.mjs");
  writeFileSync(script, PROBE);
  const name = ".canary";
  const c = inSandbox({ work, node, realHome: "", profile }, node, [
    script,
    out1,
    out2,
    work,
    name,
  ]);
  const r = spawnSync(c.cmd, c.args, {
    cwd: work,
    env: { PATH: BASE_PATH },
    timeout: 30_000,
  });
  return {
    result: JSON.parse(
      r.stdout.toString().trim().split("\n").pop() ?? "{}",
    ) as Record<string, string>,
    landed: [...readdirSync(out1), ...readdirSync(out2)],
  };
}

describe("shared harness sandbox profile", () => {
  test.skipIf(!onMac)(
    "denies every write outside the work dir and allows the work dir",
    () => {
      const iso = makeIso();
      cleanup.push(iso.work);
      const { result, landed } = probe(iso.profile, iso.work, iso.node);
      expect(result["writeOutsideTmp"]).toBe("denied:EPERM");
      expect(result["writeOutsideVarTmp"]).toBe("denied:EPERM");
      expect(result["mkdirOutside"]).toBe("denied:EPERM");
      expect(result["writeWork"]).toBe("allowed");
      expect(landed).toEqual([]);
    },
  );

  test.skipIf(!onMac)(
    "negative control: a profile without the global write deny lets the same probe write outside",
    () => {
      const iso = makeIso();
      cleanup.push(iso.work);
      const strict = readFileSync(iso.profile, "utf8");
      const loose = strict.replace(
        /^\(deny file-write\*\)\n^\(allow file-write\*.*\n/m,
        "",
      );
      expect(loose).not.toBe(strict);
      const loosePath = join(iso.work, "loose.sb");
      writeFileSync(loosePath, loose);
      const { result, landed } = probe(loosePath, iso.work, iso.node);
      expect(result["writeOutsideTmp"]).toBe("allowed");
      expect(result["writeOutsideVarTmp"]).toBe("allowed");
      // two canary files and the canary directory landed outside the work dir
      expect(landed.filter((n) => n === ".canary").length).toBe(2);
      expect(landed).toContain(".canary-d");
    },
  );

  test.skipIf(!onMac)(
    "profile text: global write deny, work-only allow, home unreadable, loopback-only network",
    () => {
      const iso = makeIso();
      cleanup.push(iso.work);
      expect(existsSync(join(iso.work, WORK_MARKER))).toBe(true);
      const text = readFileSync(iso.profile, "utf8");
      expect(text).toMatch(/^\(deny file-write\*\)$/m);
      const allow = text
        .split("\n")
        .find((l) => l.startsWith("(allow file-write*"));
      expect(allow).toContain(JSON.stringify(iso.work));
      // the write allow-list is the work dir plus device nodes, nothing else
      const subpaths = [
        ...(allow ?? "").matchAll(/\(subpath ("[^"]+")\)/g),
      ].map((m) => m[1]);
      expect(subpaths).toEqual([JSON.stringify(iso.work)]);
      expect(text).toContain(
        `(deny file-read-data (subpath ${JSON.stringify(iso.realHome)})`,
      );
      expect(text).toMatch(/^\(deny network\*\)$/m);
      expect(text).toContain(
        '(allow network-outbound (remote ip "localhost:*") (remote unix-socket))',
      );
      expect(text).not.toMatch(/\(allow network\*\)/);
    },
  );

  test.skipIf(!onMac)(
    "makeIso creates its work dir only under the OS temp dir with the marker",
    () => {
      const iso = makeIso();
      cleanup.push(iso.work);
      expect(iso.work).toContain("space-bus-host-matrix-");
      mkdirSync(join(iso.work, "x"), { recursive: true });
    },
  );
});
