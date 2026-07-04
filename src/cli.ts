/**
 * @experimental
 * Experimental — shapes may change in minor releases.
 *
 * Node-only `space-bus` CLI: thin arg parser + dispatcher wrapping
 * server.ts's lifecycle (ensure/status/stop). No roster-discovery logic
 * lives here — resolution rides config.ts's `resolveRosterPath`, same as
 * every other consumer. Never prints credentials: serve/status only ever
 * surface baseUrl + pid + port.
 */
import { resolveRosterPath } from "./config";
import { ensureServer, serverStatus, stopServer } from "./server";

const USAGE = `space-bus — thin CLI for the managed OpenCode bus server

Usage:
  space-bus serve [--foreground] [--json] [--config <path>]
  space-bus status [--json] [--config <path>]
  space-bus stop [--json] [--config <path>]
  space-bus --help

Roster resolution: SPACE_BUS_CONFIG env var, or --config <path>.
`;

interface ParsedArgs {
  command: string | undefined;
  json: boolean;
  foreground: boolean;
  config: string | undefined;
  help: boolean;
  unknownFlags: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined;
  let json = false;
  let foreground = false;
  let config: string | undefined;
  let help = false;
  const unknownFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--foreground") {
      foreground = true;
    } else if (arg === "--config") {
      i++;
      config = argv[i];
    } else if (arg?.startsWith("--")) {
      unknownFlags.push(arg);
    } else if (command === undefined && arg !== undefined) {
      command = arg;
    }
  }

  return { command, json, foreground, config, help, unknownFlags };
}

function resolveRoster(config: string | undefined): string {
  if (config) {
    process.env["SPACE_BUS_CONFIG"] = config;
  }
  return resolveRosterPath();
}

function printJson(json: boolean, data: unknown, plain: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data)}\n`);
  } else {
    process.stdout.write(`${plain}\n`);
  }
}

async function runServe(args: ParsedArgs): Promise<number> {
  const rosterPath = resolveRoster(args.config);
  const handle = await ensureServer(rosterPath);
  const data = {
    running: true,
    port: handle.port,
    pid: handle.pid,
    baseUrl: handle.baseUrl,
  };
  printJson(
    args.json,
    data,
    `space-bus: server running at ${handle.baseUrl} (pid ${handle.pid})`,
  );

  if (!args.foreground) return 0;

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = (signal: NodeJS.Signals) => {
      if (stopping) return;
      stopping = true;
      process.stderr.write(`space-bus: received ${signal}, stopping...\n`);
      stopServer(rosterPath);
      resolve(0);
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  });
}

function runStatus(args: ParsedArgs): number {
  const rosterPath = resolveRoster(args.config);
  const status = serverStatus(rosterPath);
  const plain = status.running
    ? `space-bus: running (pid ${status.pid}, port ${status.port})${status.configDrift ? " [config drift detected]" : ""}`
    : "space-bus: not running";
  printJson(args.json, status, plain);
  return 0;
}

function runStop(args: ParsedArgs): number {
  const rosterPath = resolveRoster(args.config);
  const result = stopServer(rosterPath);
  const plain = result.stopped
    ? "space-bus: stopped"
    : "space-bus: nothing to stop";
  printJson(args.json, result, plain);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || args.command === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (args.command) {
    case "serve":
      return await runServe(args);
    case "status":
      return runStatus(args);
    case "stop":
      return runStop(args);
    default:
      process.stderr.write(`space-bus: unknown command "${args.command}"\n\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`space-bus: ${(err as Error).message}\n`);
    process.exitCode = 1;
  });
