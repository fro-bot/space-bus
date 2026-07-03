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

const spacebusSource = Bun.file(resolve(repoRoot, "spacebus.json"));
await Bun.write(
  resolve(fixtureDir, "spacebus.json"),
  await spacebusSource.text(),
);

console.log(`fixture: wrote ${fixtureDir}`);
