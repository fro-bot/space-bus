/**
 * `portOpen` (scripts/verify-host-matrix.ts, shared by the U1 loader check and
 * the U2 delegation check) is a loopback connect whose port must be one this
 * harness reserved through `freePort()`. A port from any other source -- a
 * record a spawned host wrote, a literal -- is rejected before a socket opens.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { freePort, portOpen } from "../scripts/verify-host-matrix";

describe("portOpen destination constraint", () => {
  test("a reserved port with nothing listening reports closed", async () => {
    expect(await portOpen(await freePort())).toBe(false);
  });

  test("a reserved port with a listener reports open", async () => {
    const port = await freePort();
    const server = createServer();
    await new Promise<void>((ok) => server.listen(port, "127.0.0.1", ok));
    try {
      expect(await portOpen(port)).toBe(true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("an unreserved port is rejected without any connection attempt", async () => {
    let connections = 0;
    const server = createServer((s) => {
      connections++;
      s.destroy();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(portOpen(port)).rejects.toThrow(/not reserved/);
      await new Promise((r) => setTimeout(r, 100));
      expect(connections).toBe(0);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test("out-of-range and non-integer ports are rejected", async () => {
    for (const bad of [0, 22, 65536, -1, 1.5, Number.NaN]) {
      await expect(portOpen(bad)).rejects.toThrow(/not reserved/);
    }
  });
});
