#!/usr/bin/env node

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const claude = process.env.CLAUDE_BIN || spawnSync("sh", ["-c", "command -v claude"], { encoding: "utf8" }).stdout.trim();
const commands = [
  [process.execPath, ["tests/plugin-contract.test.mjs"]],
  [process.execPath, ["tests/evaluate.test.mjs"]],
  [process.execPath, ["tests/docs-contract.test.mjs"]],
  [process.execPath, ["tests/public-boundary.test.mjs"]],
  [process.execPath, ["tests/release-gate.test.mjs"]],
  [process.execPath, ["tests/install-e2e.mjs", "--source", "local", "--scope", "user", "--claude", claude]],
  [process.execPath, ["tests/install-e2e.mjs", "--source", "local", "--scope", "project", "--claude", claude]],
];

if (!claude) {
  console.error("Deterministic suite failed: Claude executable was not found.");
  process.exit(1);
}

for (const [executable, args] of commands) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}

console.log("deterministic suite: ok");
