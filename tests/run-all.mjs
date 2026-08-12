#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claude = process.env.CLAUDE_BIN || spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
// tests/install-e2e.mjs pins the same version, and CI installs it before
// running this suite. Raising it needs a fresh model attestation.
const PINNED_CLAUDE_VERSION = "2.1.223";
const PINNED_VERSION_OUTPUT = `${PINNED_CLAUDE_VERSION} (Claude Code)`;
const deterministic = [
  ["tests/plugin-contract.test.mjs"],
  ["tests/evaluate.test.mjs"],
  ["tests/docs-contract.test.mjs"],
  ["tests/public-boundary.test.mjs"],
  ["tests/release-gate.test.mjs"],
];

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

function reportPinnedVersion(problem) {
  console.error(`Deterministic tests passed. The install E2E did not run: ${problem}`);
  console.error(`It is pinned to Claude Code ${PINNED_VERSION_OUTPUT}.`);
  console.error("Install that version, or point CLAUDE_BIN at an absolute path to it:");
  console.error(`  npm install --global @anthropic-ai/claude-code@${PINNED_CLAUDE_VERSION}`);
  console.error("  CLAUDE_BIN=/absolute/path/to/claude node tests/run-all.mjs");
  console.error("CI installs this exact version; see CONTRIBUTING.md.");
  process.exit(1);
}

for (const args of deterministic) run(args);

if (!claude) reportPinnedVersion("a Claude executable was not found.");

const version = spawnSync(claude, ["--version"], { encoding: "utf8" });
const reported = (version.stdout || "").trim();
if (version.error || version.status !== 0) reportPinnedVersion("the version check failed.");
if (reported !== PINNED_VERSION_OUTPUT) reportPinnedVersion(`${reported} answered instead.`);

for (const scope of ["user", "project"]) {
  run(["tests/install-e2e.mjs", "--source", "local", "--scope", scope, "--claude", claude]);
}

console.log("deterministic suite: ok");
