#!/usr/bin/env bun
/**
 * Generates a gitignored fixtures/dev-workspace/ directory referencing this
 * checkout by absolute file path, so the plugin can be dev-loop tested
 * without publishing. See plan Unit 3 "Dev loop".
 *
 * Fully self-contained: also generates two placeholder project directories
 * inside the fixture (alpha/beta) so the roster and smoke canary work on any
 * machine without assuming a particular local repo layout.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const fixtureDir = resolve(repoRoot, "fixtures/dev-workspace");
const projectsDir = resolve(fixtureDir, "projects");

const baseUrl =
  process.env["SPACE_BUS_FIXTURE_BASE_URL"] ?? "http://127.0.0.1:4096";

await Bun.write(
  resolve(fixtureDir, "opencode.json"),
  `${JSON.stringify({ plugin: [repoRoot] }, null, 2)}\n`,
);

const placeholderProjects = [
  {
    name: "alpha",
    description: "Fixture project alpha for space-bus development.",
  },
  {
    name: "beta",
    description: "Fixture project beta for space-bus development.",
  },
];

for (const project of placeholderProjects) {
  const projectDir = resolve(projectsDir, project.name);
  await Bun.write(resolve(projectDir, "AGENTS.md"), `${project.description}\n`);
}

const spacebusRoster = {
  server: { baseUrl },
  projects: placeholderProjects.map((project) => ({
    name: project.name,
    path: resolve(projectsDir, project.name),
    description: project.description,
  })),
};
await Bun.write(
  resolve(fixtureDir, "spacebus.json"),
  `${JSON.stringify(spacebusRoster, null, 2)}\n`,
);

console.log(`fixture: wrote ${fixtureDir}`);
