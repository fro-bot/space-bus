// Disposable synthetic listener for the U1 feasibility diagnostic. Binds an
// OS-assigned port on 127.0.0.1 ONLY, prints {"pid","port"} once, accepts no
// data and sends none, and exits when stdin closes or on SIGTERM.
//
// Optional `--hand-off`: also forks ONE child that shares the same listening
// socket handle (so two processes hold it) and reports both pids; used as a
// live "ambiguous owner" control. Needs Node's IPC handle passing.
import { fork } from "node:child_process";
import { createServer } from "node:net";

const handOff = process.argv.includes("--hand-off");

if (process.argv.includes("--hold")) {
  // Grandchild: received the listening handle over IPC, just keeps it open.
  process.on("message", (_message, server) => {
    process.send?.({ pid: process.pid, ready: server !== undefined });
  });
  setInterval(() => {}, 1 << 30);
} else {
  const server = createServer((socket) => socket.destroy());
  server.listen({ host: "127.0.0.1", port: 0 }, () => {
    const { port } = server.address();
    const report = { pid: process.pid, port };
    if (!handOff) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
      return;
    }
    const child = fork(new URL(import.meta.url).pathname, ["--hold"]);
    child.on("message", (m) => {
      report.holders = [process.pid, m.pid];
      process.stdout.write(`${JSON.stringify(report)}\n`);
    });
    child.send("server", server);
    process.on("exit", () => child.kill());
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdin.resume();
  process.on("SIGTERM", () => process.exit(0));
}
