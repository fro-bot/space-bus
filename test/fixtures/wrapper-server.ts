/**
 * Test-only stub WRAPPER process for src/server.test.ts. Models the real
 * `harness serve`/`opencode serve` shape: a thin process that itself spawns
 * the actual server (stub-server.ts) as a CHILD which binds the port and
 * prints the readiness line — the wrapper just stays alive holding the
 * child.
 *
 * Deliberately does NOT forward SIGTERM to the child. That's the whole
 * point of this fixture: it models a wrapper that dies without cleaning up
 * its child, so only process-GROUP signaling (see signalGroup in
 * src/server.ts) can tear down both. If the wrapper forwarded SIGTERM, it
 * would mask the bug this fixture exists to catch.
 *
 * Not shipped: `files` in package.json whitelists dist/README/LICENSE only.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stubPath = join(here, "stub-server.ts");

const portIdx = process.argv.indexOf("--port");
const port =
  portIdx !== -1 && portIdx + 1 < process.argv.length
    ? (process.argv[portIdx + 1] as string)
    : "0";

const child = spawn("bun", [stubPath, "--port", port], {
  stdio: ["ignore", "inherit", "inherit"],
  // Forwards STUB_IGNORE_SIGTERM (if set) so tests can model a child that
  // ignores SIGTERM even while the wrapper itself still exits on it —
  // forcing stopServer's group-SIGKILL escalation path.
  env: { ...process.env },
});

// Print a marker line with the child's pid so tests can locate it without
// relying on process-tree scraping.
// eslint-disable-next-line no-console
console.log(`wrapper-server: child pid ${child.pid}`);

// Deliberately no SIGTERM forwarding to the child — see doc comment above.
// The wrapper just stays alive until the whole process group is signaled.
process.on("SIGTERM", () => {
  process.exit(0);
});

child.on("exit", () => {
  process.exit(0);
});
