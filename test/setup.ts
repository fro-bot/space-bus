import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
