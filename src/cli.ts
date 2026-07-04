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
  /** --config was the last arg with no following value. */
  configMissingValue: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    command: undefined,
    json: false,
    foreground: false,
    config: undefined,
    help: false,
    unknownFlags: [],
    configMissingValue: false,
  };

  for (let i = 0; i < argv.length; i++) {
    i = consumeArg(argv, i, result);
  }

  return result;
}

/** Handles one arg (advancing `i` for `--config <value>`); returns the
 * (possibly advanced) index. Kept separate from parseArgs's loop to keep
 * cognitive complexity within the linter's threshold. */
function consumeArg(argv: string[], i: number, result: ParsedArgs): number {
  const arg = argv[i];
  if (arg === "--help" || arg === "-h") {
    result.help = true;
  } else if (arg === "--json") {
    result.json = true;
  } else if (arg === "--foreground") {
    result.foreground = true;
  } else if (arg === "--config") {
    const value = argv[i + 1];
    if (value === undefined) {
      result.configMissingValue = true;
    } else {
      result.config = value;
    }
    return i + 1;
  } else if (arg?.startsWith("--")) {
    result.unknownFlags.push(arg);
  } else if (result.command === undefined && arg !== undefined) {
    result.command = arg;
  }
  return i;
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
      void stopServer(rosterPath).finally(() => resolve(0));
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

async function runStop(args: ParsedArgs): Promise<number> {
  const rosterPath = resolveRoster(args.config);
  const result = await stopServer(rosterPath);
  const plain = result.stopped
    ? "space-bus: stopped"
    : "space-bus: nothing to stop";
  printJson(args.json, result, plain);
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.configMissingValue) {
    process.stderr.write("space-bus: --config requires a path argument\n\n");
    process.stderr.write(USAGE);
    return 1;
  }

  if (args.unknownFlags.length > 0) {
    process.stderr.write(
      `space-bus: unknown flag${args.unknownFlags.length > 1 ? "s" : ""}: ${args.unknownFlags.join(", ")}\n\n`,
    );
    process.stderr.write(USAGE);
    return 1;
  }

  if (args.command === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }

  switch (args.command) {
    case "serve":
      return await runServe(args);
    case "status":
      return runStatus(args);
    case "stop":
      return await runStop(args);
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
