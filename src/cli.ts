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
import { fileURLToPath } from "node:url";

import { resolveRosterPath } from "./config";
import {
  ensureServer,
  type ServerHandle,
  type SuperviseOutcome,
  serverStatus,
  stopServer,
  superviseServer,
} from "./server";
import {
  installService,
  serviceStatus,
  startService,
  stopService,
  uninstallService,
} from "./service";

const USAGE = `space-bus — thin CLI for the managed OpenCode bus server

Usage:
  space-bus serve [--foreground] [--json] [--config <path>]
  space-bus status [--json] [--config <path>]
  space-bus stop [--json] [--config <path>]
  space-bus service install [--json] [--config <path>]    install the launchd agent (macOS)
  space-bus service uninstall [--json] [--config <path>]  remove the launchd agent
  space-bus service status [--json] [--config <path>]     installed/loaded/running state
  space-bus service stop [--json] [--config <path>]       bootout the loaded job (plist stays)
  space-bus service start [--json] [--config <path>]      bootstrap + kickstart the job
  space-bus --help

Roster resolution: SPACE_BUS_CONFIG env var, or --config <path>.
`;

interface ParsedArgs {
  command: string | undefined;
  /** Second positional arg — only meaningful when command === "service". */
  subcommand?: string | undefined;
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
    subcommand: undefined,
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
  } else if (
    result.command === "service" &&
    result.subcommand === undefined &&
    arg !== undefined
  ) {
    result.subcommand = arg;
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

/** Injectable dependencies for `runServe`'s foreground supervision — lets
 * tests drive the signal/died/hung outcomes deterministically without a
 * real daemon or real timers. Defaults to the real implementations. */
export interface RunServeDeps {
  ensureServer?: typeof ensureServer;
  stopServer?: typeof stopServer;
  /** Receives a `shouldStop` seam wired to the process signal handlers —
   * when a signal fires, `shouldStop()` starts returning true so the loop
   * (real or injected) can break with `{ reason: "signal" }` — plus an
   * `interrupt` promise that resolves immediately on signal, so the
   * inter-tick sleep doesn't have to wait out the full interval. */
  superviseServer?: (
    rosterPath: string,
    handle: ServerHandle,
    shouldStop: () => boolean,
    interrupt: Promise<void>,
  ) => Promise<SuperviseOutcome>;
}

export async function runServe(
  args: ParsedArgs,
  deps: RunServeDeps = {},
): Promise<number> {
  const doEnsureServer = deps.ensureServer ?? ensureServer;
  const doStopServer = deps.stopServer ?? stopServer;
  const doSuperviseServer =
    deps.superviseServer ??
    ((rosterPath, handle, shouldStop, interrupt) =>
      superviseServer(rosterPath, handle, { shouldStop, interrupt }));

  const rosterPath = resolveRoster(args.config);
  const handle = await doEnsureServer(rosterPath);
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
    let stopRequested = false;
    let wake: () => void = () => {};
    const interrupt = new Promise<void>((r) => {
      wake = r;
    });
    const sigintHandler = () => onSignal("SIGINT");
    const sigtermHandler = () => onSignal("SIGTERM");
    const removeSignalHandlers = () => {
      process.off("SIGINT", sigintHandler);
      process.off("SIGTERM", sigtermHandler);
    };
    const onSignal = (signal: NodeJS.Signals) => {
      if (stopRequested) return;
      stopRequested = true;
      process.stderr.write(`space-bus: received ${signal}, stopping...\n`);
      // Wired into superviseServer's shouldStop seam below — the loop
      // breaks with {reason:"signal"} on its next tick, and the
      // .then() handler below performs the actual stopServer/resolve.
      // wake() also breaks the inter-tick sleep immediately instead of
      // waiting out the full interval.
      wake();
    };
    process.on("SIGINT", sigintHandler);
    process.on("SIGTERM", sigtermHandler);

    void doSuperviseServer(rosterPath, handle, () => stopRequested, interrupt)
      .then((outcome) => {
        if (outcome.reason === "signal") {
          // Keep signal handlers live during the stop grace window, so a
          // second Ctrl+C during shutdown hits our idempotent handler
          // (stopRequested guard) instead of Node's default hard-kill.
          void doStopServer(rosterPath).finally(() => {
            removeSignalHandlers();
            resolve(0);
          });
          return;
        }
        removeSignalHandlers();
        process.stderr.write(
          `space-bus: managed daemon ${outcome.reason}; exiting for supervisor restart\n`,
        );
        resolve(1);
      })
      .catch((err) => {
        removeSignalHandlers();
        process.stderr.write(
          `space-bus: supervision failed unexpectedly: ${(err as Error).message}\n`,
        );
        resolve(1);
      });
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

const SERVICE_VERBS = [
  "install",
  "uninstall",
  "status",
  "stop",
  "start",
] as const;
type ServiceVerb = (typeof SERVICE_VERBS)[number];

function isServiceVerb(value: string | undefined): value is ServiceVerb {
  return SERVICE_VERBS.includes(value as ServiceVerb);
}

function servicePlainMessage(
  verb: ServiceVerb,
  result: { ok: true; [key: string]: unknown },
): string {
  switch (verb) {
    case "install":
      return `space-bus: service installed: ${result["label"]}${result["pid"] !== undefined ? ` (pid ${result["pid"]})` : ""}${result["warning"] ? `\nwarning: ${result["warning"]}` : ""}`;
    case "uninstall": {
      const removed = result["removed"] as { job: boolean; plist: boolean };
      return `space-bus: service uninstalled: ${result["label"]} (job removed: ${removed.job}, plist removed: ${removed.plist})`;
    }
    case "status":
      return `space-bus: service ${result["label"]} — installed: ${result["installed"]}, loaded: ${result["loaded"]}, running: ${result["running"]}${result["pid"] !== undefined ? ` (pid ${result["pid"]})` : ""}`;
    case "stop":
      return `space-bus: service stopped: ${result["label"]} (was loaded: ${result["wasLoaded"]})`;
    case "start":
      return `space-bus: service started: ${result["label"]}${result["pid"] !== undefined ? ` (pid ${result["pid"]})` : ""}`;
    default:
      return "space-bus: service ok";
  }
}

/** Injectable dependencies for `runService` — lets tests swap in fake
 * verb implementations so they never touch the real launchd / LaunchAgents
 * directory. Defaults to the real implementations from service.ts. */
export interface RunServiceDeps {
  installService?: typeof installService;
  uninstallService?: typeof uninstallService;
  serviceStatus?: typeof serviceStatus;
  stopService?: typeof stopService;
  startService?: typeof startService;
}

export async function runService(
  args: ParsedArgs,
  deps: RunServiceDeps = {},
): Promise<number> {
  if (!isServiceVerb(args.subcommand)) {
    process.stderr.write(
      `space-bus: unknown or missing service verb "${args.subcommand ?? ""}"\n\n`,
    );
    process.stderr.write(USAGE);
    return 1;
  }

  const doInstallService = deps.installService ?? installService;
  const doUninstallService = deps.uninstallService ?? uninstallService;
  const doServiceStatus = deps.serviceStatus ?? serviceStatus;
  const doStopService = deps.stopService ?? stopService;
  const doStartService = deps.startService ?? startService;

  const rosterPath = resolveRoster(args.config);
  const serviceDeps = { cliEntryPath: fileURLToPath(import.meta.url) };

  const result = await (() => {
    switch (args.subcommand) {
      case "install":
        return doInstallService(rosterPath, serviceDeps);
      case "uninstall":
        return doUninstallService(rosterPath, serviceDeps);
      case "status":
        return doServiceStatus(rosterPath, serviceDeps);
      case "stop":
        return doStopService(rosterPath, serviceDeps);
      case "start":
        return doStartService(rosterPath, serviceDeps);
      default:
        throw new Error("unreachable");
    }
  })();

  if (!result.ok) {
    process.stderr.write(`space-bus: ${result.error}\n`);
    return 1;
  }

  const plain = servicePlainMessage(
    args.subcommand,
    result as { ok: true; [key: string]: unknown },
  );
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
    case "service":
      return await runService(args);
    default:
      process.stderr.write(`space-bus: unknown command "${args.command}"\n\n`);
      process.stderr.write(USAGE);
      return 1;
  }
}

// Guard so importing this module (e.g. from cli.test.ts to reach the
// exported `runServe` for injected-dependency tests) doesn't also run the
// CLI against the importer's own argv.
if (import.meta.main) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`space-bus: ${(err as Error).message}\n`);
      process.exitCode = 1;
    });
}
