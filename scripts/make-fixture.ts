#!/usr/bin/env bun
/**
 * Generates a gitignored fixtures/dev-workspace/ directory referencing this
 * checkout by absolute file path, so the plugin can be dev-loop tested
 * without publishing. See plan Unit 3 "Dev loop".
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixtureDir = resolve(repoRoot, "fixtures/dev-workspace");

await Bun.write(
  resolve(fixtureDir, "opencode.json"),
  `${JSON.stringify({ plugin: [repoRoot] }, null, 2)}\n`,
);

const spacebusRoster = {
  server: { baseUrl: "http://127.0.0.1:4096" },
  projects: [
    {
      name: "agent",
      path: "~/src/github.com/fro-bot/agent",
      description: "Fro Bot agent runtime + gateway + Discord integration",
    },
    {
      name: "dashboard",
      path: "~/src/github.com/fro-bot/dashboard",
      description: "Operator dashboard (React + Vite PWA)",
    },
    {
      name: "control-plane",
      path: "~/src/github.com/fro-bot/.github",
      description: "Control plane + autoresearch + loop (org workflows)",
    },
    {
      name: "infra",
      path: "~/src/github.com/marcusrbrown/infra",
      description: "IaC — cloud deploys and log pulls",
    },
    {
      name: "space-bus",
      path: "~/src/github.com/fro-bot/space-bus",
      description: "Space Bus plugin development (@fro.bot/space-bus)",
    },
  ],
};
await Bun.write(
  resolve(fixtureDir, "spacebus.json"),
  `${JSON.stringify(spacebusRoster, null, 2)}\n`,
);

console.log(`fixture: wrote ${fixtureDir}`);
