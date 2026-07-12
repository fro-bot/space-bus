import { afterAll, afterEach } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Force all state-directory writes during the test suite (discovery.ts's
// stateDirFor, ensureServer, writeDiscovery/writeProvisional, acquireLock)
// into an isolated temp dir instead of the developer's real
// ~/.local/state/space-bus/. Tests randomize roster paths (mkdtemp) but
// never override XDG_STATE_HOME, so without this preload every test run
// leaks a fresh per-roster state dir into the real home directory.
const originalXdgStateHome = process.env["XDG_STATE_HOME"];
const tempRoot = mkdtempSync(join(tmpdir(), "space-bus-xdg-state-"));
process.env["XDG_STATE_HOME"] = tempRoot;

// Force all config-directory writes during the test suite (registry.ts's
// registryPath, registerRoster/unregisterRoster/setDefaultRoster) into an
// isolated temp dir instead of the developer's real ~/.config/space-bus/.
// Same bug class as the XDG_STATE_HOME leak above — see the LaunchAgents
// guard below for the incident this pattern exists to prevent.
const originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
const configTempRoot = mkdtempSync(join(tmpdir(), "space-bus-xdg-config-"));
process.env["XDG_CONFIG_HOME"] = configTempRoot;

function cleanup(): void {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; ignore
  }
  try {
    rmSync(configTempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; ignore
  }
  if (originalXdgStateHome === undefined) {
    delete process.env["XDG_STATE_HOME"];
  } else {
    process.env["XDG_STATE_HOME"] = originalXdgStateHome;
  }
  if (originalXdgConfigHome === undefined) {
    delete process.env["XDG_CONFIG_HOME"];
  } else {
    process.env["XDG_CONFIG_HOME"] = originalXdgConfigHome;
  }
}

afterAll(cleanup);
process.on("exit", cleanup);

// --- Real ~/.config/space-bus/rosters.json leak guard ---------------------
//
// Same bug class as the LaunchAgents guard below: registry.ts's
// registryPath() derives its fallback from homedir() when XDG_CONFIG_HOME
// is unset in the *production* code path, but a test that bypasses the
// preload above (e.g. by deleting process.env.XDG_CONFIG_HOME mid-test) or
// a future writer that reads homedir() directly could still leak into the
// operator's real config dir. Snapshot existence+mtime of the real
// rosters.json before the suite runs; fail loudly if it gains content
// (goes from absent to present, or its mtime advances) during the run.

const realRegistryPath = join(
  homedir(),
  ".config",
  "space-bus",
  "rosters.json",
);

export interface RegistrySnapshot {
  exists: boolean;
  mtimeMs: number | null;
}

function snapshotRealRegistry(): RegistrySnapshot {
  try {
    const stat = statSync(realRegistryPath);
    return { exists: true, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, mtimeMs: null };
  }
}

const realRegistryBefore = snapshotRealRegistry();

/**
 * Pure comparison extracted so the leak guard's logic can be unit-tested
 * without touching the real filesystem: given a before/after snapshot pair,
 * throws with the guard message if the "after" state indicates the real
 * registry file was written to (appeared from nothing, or mutated in
 * place); otherwise returns without side effects.
 *
 * `path` is only used to compose the error message — callers pass the real
 * path in production, tests pass a fabricated label.
 */
export function assertNoRealConfigLeak(
  before: RegistrySnapshot,
  after: RegistrySnapshot,
  path: string = realRegistryPath,
): void {
  const gainedContent = !before.exists && after.exists;
  const mutated =
    before.exists && after.exists && after.mtimeMs !== before.mtimeMs;
  if (gainedContent || mutated) {
    throw new Error(
      `Real config leak guard: ${path} was written to during ` +
        `the test run. A test wrote to the real ~/.config/space-bus instead ` +
        `of relying on the XDG_CONFIG_HOME isolation preloaded in ` +
        `test/setup.ts — see docs/solutions/best-practices/` +
        `test-isolation-xdg-state-home-2026-07-05.md for the same bug class.`,
    );
  }
}

function checkRealRegistryLeak(): void {
  assertNoRealConfigLeak(realRegistryBefore, snapshotRealRegistry());
}

afterEach(checkRealRegistryLeak);
afterAll(checkRealRegistryLeak);
process.on("exit", checkRealRegistryLeak);

// --- LaunchAgents leak guard ---------------------------------------------
//
// Same bug class as the XDG_STATE_HOME leak above: src/launchd.ts's
// plistPath() derives its default from homedir(), and src/service.ts's
// ServiceDeps.launchAgentsDir must be injected by every test. Unlike
// XDG_STATE_HOME there is no single env var to globally override here
// (launchd plists must live at a fixed, launchctl-resolvable path when
// actually loaded), so instead of redirecting writes we snapshot the real
// ~/Library/LaunchAgents/bot.fro.space-bus.*.plist files before the suite
// runs and fail the run if any new one appears — a hard guard against a
// test that forgot to inject launchAgentsDir.
function listSpaceBusPlists(): Set<string> {
  const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
  try {
    return new Set(
      readdirSync(launchAgentsDir).filter(
        (name) =>
          name.startsWith("bot.fro.space-bus.") && name.endsWith(".plist"),
      ),
    );
  } catch {
    // LaunchAgents dir doesn't exist (e.g. non-macOS CI) — nothing to guard.
    return new Set();
  }
}

const plistsBefore = listSpaceBusPlists();

/**
 * Pure comparison extracted for unit-testability, same rationale as
 * `assertNoRealConfigLeak` above: given a before/after set of plist
 * filenames, throws with the guard message if any name in `after` is
 * absent from `before`; otherwise returns without side effects.
 */
export function assertNoLaunchAgentsLeak(
  before: Set<string>,
  after: Set<string>,
): void {
  const leaked = [...after].filter((name) => !before.has(name));
  if (leaked.length > 0) {
    throw new Error(
      `LaunchAgents leak guard: ${leaked.length} new bot.fro.space-bus.*.plist ` +
        `file(s) appeared in the real ~/Library/LaunchAgents during the test ` +
        `run: ${leaked.join(", ")}. A test wrote to the real LaunchAgents dir ` +
        `instead of injecting ServiceDeps.launchAgentsDir / launchd.ts's ` +
        `plistPath(label, baseDir) — see docs/solutions/best-practices/` +
        `test-isolation-xdg-state-home-2026-07-05.md for the same bug class.`,
    );
  }
}

function checkLaunchAgentsLeak(): void {
  assertNoLaunchAgentsLeak(plistsBefore, listSpaceBusPlists());
}

afterAll(checkLaunchAgentsLeak);
process.on("exit", checkLaunchAgentsLeak);
