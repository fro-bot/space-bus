/**
 * Test-only stub OpenCode server for src/server.test.ts. Dependency-free
 * Bun script: binds 127.0.0.1 on the given --port (0 = OS-assigned), prints
 * the readiness line exactly like real `harness serve`, enforces Basic auth
 * via OPENCODE_SERVER_PASSWORD on GET /session, and runs until SIGTERM.
 *
 * Not shipped: `files` in package.json whitelists dist/README/LICENSE only.
 */

function parsePort(): number {
  const idx = process.argv.indexOf("--port");
  if (idx === -1 || idx + 1 >= process.argv.length) return 0;
  const parsed = Number(process.argv[idx + 1]);
  return Number.isFinite(parsed) ? parsed : 0;
}

const requestedPort = parsePort();
const expectedPassword = process.env["OPENCODE_SERVER_PASSWORD"];

const forceUnauthorized = process.env["STUB_FORCE_401"] === "1";
const suppressReadinessLine = process.env["STUB_NO_READY"] === "1";

function isAuthorized(req: Request): boolean {
  if (forceUnauthorized) return false;
  if (!expectedPassword) return true;
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  const decoded = atob(header.slice("Basic ".length));
  const separatorIndex = decoded.indexOf(":");
  const password =
    separatorIndex === -1 ? "" : decoded.slice(separatorIndex + 1);
  return password === expectedPassword;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: requestedPort,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/session") {
      if (!isAuthorized(req)) {
        return new Response("Unauthorized", { status: 401 });
      }
      return new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },
});

if (!suppressReadinessLine) {
  // eslint-disable-next-line no-console
  console.log(`opencode server listening on http://127.0.0.1:${server.port}`);
}

if (process.env["STUB_IGNORE_SIGTERM"] !== "1") {
  process.on("SIGTERM", () => {
    server.stop(true);
    process.exit(0);
  });
}
