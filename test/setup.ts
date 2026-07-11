import { afterAll } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
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

function cleanup(): void {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; ignore
  }
  if (originalXdgStateHome === undefined) {
    delete process.env["XDG_STATE_HOME"];
  } else {
    process.env["XDG_STATE_HOME"] = originalXdgStateHome;
  }
}

afterAll(cleanup);
process.on("exit", cleanup);

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

function checkLaunchAgentsLeak(): void {
  const plistsAfter = listSpaceBusPlists();
  const leaked = [...plistsAfter].filter((name) => !plistsBefore.has(name));
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

afterAll(checkLaunchAgentsLeak);
process.on("exit", checkLaunchAgentsLeak);
