#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STYLE_SETTING_VALUE = "korean-plain:Korean Plain";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const REQUIRED_EVALUATIONS = new Set(["sonnet:high", "opus:xhigh"]);

function parseArgs(argv) {
  const options = {};
  const valueArguments = new Set([
    "--repo", "--tag", "--require-claude-version", "--expected-remote",
    "--model-attestation", "--require-evaluation", "--claude-bin",
  ]);
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (seen.has(key) && key !== "--require-evaluation") throw new Error("Duplicate release-gate argument");
    seen.add(key);
    if (key === "--require-no-remote") options.requireNoRemote = true;
    else if (key === "--allow-authenticated-config-picker") options.allowAuthenticatedConfigPicker = true;
    else if (valueArguments.has(key)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing release-gate argument value");
      if (key === "--require-evaluation") (options.requireEvaluations ??= []).push(value);
      else options[key.slice(2)] = value;
    } else throw new Error("Unknown release-gate argument");
  }
  for (const key of ["repo", "tag", "require-claude-version", "model-attestation", "claude-bin"]) {
    if (!options[key]) throw new Error("Missing release-gate argument");
  }
  if (options.requireNoRemote === Boolean(options["expected-remote"])) throw new Error("Choose exactly one remote policy");
  if (!options.allowAuthenticatedConfigPicker) throw new Error("Authenticated config picker proof requires explicit opt-in");
  if (!/^v/.test(options.tag) || !SEMVER_PATTERN.test(options.tag.slice(1))) throw new Error("Release tag must be v-prefixed semver");
  if (!SEMVER_PATTERN.test(options["require-claude-version"])) throw new Error("Claude version must be semver");
  if (!path.isAbsolute(options["claude-bin"])) throw new Error("Claude executable must be an absolute path");
  const requested = options.requireEvaluations ?? [];
  if (requested.length !== REQUIRED_EVALUATIONS.size || new Set(requested).size !== requested.length ||
      requested.some((value) => !REQUIRED_EVALUATIONS.has(value))) {
    throw new Error("Exactly sonnet:high and opus:xhigh evaluations are required");
  }
  return options;
}

function command(executable, args, cwd, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let error = null;
    let timedOut = false;
    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (killError) {
        if (killError.code !== "ESRCH") error ||= killError;
      }
    };
    const collect = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) {
        error ||= new Error("command output exceeded limit");
        killTree();
      } else target.push(chunk);
    };
    child.stdout.on("data", (chunk) => collect(stdout, chunk));
    child.stderr.on("data", (chunk) => collect(stderr, chunk));
    child.on("error", (spawnError) => { error = spawnError; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, 10 * 60 * 1000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        status,
        error: error || (timedOut ? new Error("command timed out") : null),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function requireCommand(label, executable, args, cwd, statuses, env) {
  const result = await command(executable, args, cwd, env);
  statuses.push({ label, status: result.status ?? 1 });
  if (result.error || result.status !== 0) throw new Error(label);
  return result.stdout.trim();
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

export function hashDirectory(directory) {
  const root = fs.realpathSync(directory);
  const records = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("Plugin contains a symbolic link");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) records.push(`${relative}\0${sha256File(absolute)}\n`);
      else throw new Error("Plugin contains an unsupported entry");
    }
  };
  visit(root);
  if (records.length === 0) throw new Error("Plugin directory is empty");
  return sha256Bytes(records.join(""));
}

function evaluationConfigSha256() {
  return sha256Bytes(`${JSON.stringify({ outputStyle: STYLE_SETTING_VALUE }, null, 2)}\n`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function assertExternalAttestationPath(repo, candidate) {
  const supplied = path.resolve(candidate);
  if (!fs.existsSync(supplied) || fs.lstatSync(supplied).isSymbolicLink()) throw new Error("Model attestation must not be a symbolic link");
  const resolved = fs.realpathSync(candidate);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile()) throw new Error("Model attestation must be a regular file");
  const relative = path.relative(repo, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("Model attestation must be outside the release repository");
  const containingGit = spawnSync("git", ["-C", path.dirname(resolved), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (containingGit.status === 0) throw new Error("Model attestation must be outside every Git worktree");
  if ((stat.mode & 0o777) !== 0o600) throw new Error("Model attestation must have mode 0600");
  return resolved;
}

// The gate never reads the user's settings, which can hold credentials and
// environment values, so this observes the file without opening it. Claude
// Code rewrites the file atomically when an interactive session starts and
// exits, which changes its inode and timestamps while the bytes stay the
// same; those fields are therefore excluded. The remaining limit is that an
// edit keeping both size and permissions is not detected.
export function guardedSettingsSnapshot(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false };
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Guarded user settings are not a regular file");
  return {
    exists: true,
    mode: (stat.mode & 0o777).toString(8),
    size: stat.size.toString(),
  };
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readJson(filePath) {
  const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Picker settings are invalid");
  return value;
}

function assertPickerSettings(filePath) {
  const value = readJson(filePath);
  if (JSON.stringify(value.localSentinel) !== JSON.stringify({ preserve: true })) throw new Error("Picker changed sentinel settings");
  const keys = Object.keys(value).sort();
  const expectedKeys = ["localSentinel", "outputStyle"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys.sort())) throw new Error("Picker changed unexpected settings");
  if (value.outputStyle !== STYLE_SETTING_VALUE) throw new Error("Picker selected an unexpected output style");
}

async function runAuthenticatedConfigPicker(repo, claudeBin, statuses) {
  const picker = path.join(repo, "tests", "config-picker.exp");
  if (!fs.existsSync(picker)) throw new Error("Config picker proof script is missing");
  const userSettings = path.join(os.homedir(), ".claude", "settings.json");
  const before = guardedSettingsSnapshot(userSettings);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "release-picker-proof-"));
  const project = path.join(temporary, "project");
  const localSettings = path.join(project, ".claude", "settings.local.json");
  try {
    fs.mkdirSync(path.dirname(localSettings), { recursive: true, mode: 0o700 });
    fs.writeFileSync(localSettings, `${JSON.stringify({ localSentinel: { preserve: true } }, null, 2)}\n`, { mode: 0o600 });
    // Restoring Default in /config is no longer the off switch: the style sets
    // force-for-plugin, so disabling the plugin is. The install E2E covers that.
    for (const mode of ["select", "persist"]) {
      const output = await requireCommand(`config-picker-${mode}`, "/usr/bin/expect", [picker, mode, claudeBin, path.join(repo, "plugins", "korean-plain"), project], repo, statuses);
      if (!output.includes(`CONFIG_PICKER_${mode.toUpperCase()}_OK`)) throw new Error(`config-picker-${mode}`);
      assertPickerSettings(localSettings);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  if (!sameSnapshot(before, guardedSettingsSnapshot(userSettings))) throw new Error("Authenticated picker changed user settings");
}

export function expectedReleaseIdentity(repo, options, headCommit) {
  const pluginRoot = path.join(repo, "plugins", "korean-plain");
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
  if (typeof pluginManifest.version !== "string" || !SEMVER_PATTERN.test(pluginManifest.version)) {
    throw new Error("Plugin version is invalid");
  }
  if (options.tag !== `v${pluginManifest.version}`) throw new Error("Tag and plugin version differ");
  return {
    releaseVersion: pluginManifest.version,
    tag: options.tag,
    headCommit,
    claudeVersion: `${options["require-claude-version"]} (Claude Code)`,
    requiredEvaluations: new Set(options.requireEvaluations),
    identity: {
      pluginSha256: hashDirectory(pluginRoot),
      styleSha256: sha256File(path.join(pluginRoot, "output-styles", "korean-plain.md")),
      configSha256: evaluationConfigSha256(),
      styleSettingValue: STYLE_SETTING_VALUE,
    },
  };
}

export function validateModelAttestation(repo, attestationPath, expected) {
  const resolved = assertExternalAttestationPath(repo, attestationPath);
  const attestation = JSON.parse(fs.readFileSync(resolved, "utf8"));
  exactKeys(attestation, ["schemaVersion", "status", "redacted", "rawOutputsIncluded", "releaseVersion", "tag", "headCommit", "identity", "evaluations"], "Model attestation");
  exactKeys(attestation.identity, ["pluginSha256", "styleSha256", "configSha256", "styleSettingValue"], "Model attestation identity");
  if (attestation.schemaVersion !== 1 || attestation.status !== "pass" || attestation.redacted !== true || attestation.rawOutputsIncluded !== false) {
    throw new Error("Model attestation is not a passing redacted attestation");
  }
  if (attestation.releaseVersion !== expected.releaseVersion || attestation.tag !== expected.tag || attestation.headCommit !== expected.headCommit) {
    throw new Error("Model attestation release differs");
  }
  for (const key of ["pluginSha256", "styleSha256", "configSha256"]) {
    if (!HASH_PATTERN.test(attestation.identity[key]) || attestation.identity[key] !== expected.identity[key]) {
      throw new Error("Model attestation identity differs");
    }
  }
  if (attestation.identity.styleSettingValue !== expected.identity.styleSettingValue) {
    throw new Error("Model attestation style setting differs");
  }
  if (!Array.isArray(attestation.evaluations) || attestation.evaluations.length !== expected.requiredEvaluations.size) {
    throw new Error("Model attestation evaluations are incomplete");
  }
  const observed = new Set();
  for (const evaluation of attestation.evaluations) {
    exactKeys(evaluation, ["requestedModel", "effort", "claudeVersion", "caseIds", "overallPass"], "Model attestation evaluation");
    const pair = `${evaluation.requestedModel}:${evaluation.effort}`;
    if (!expected.requiredEvaluations.has(pair) || observed.has(pair)) throw new Error("Model attestation evaluation differs");
    if (evaluation.claudeVersion !== expected.claudeVersion || evaluation.overallPass !== true ||
        !Array.isArray(evaluation.caseIds) || evaluation.caseIds.length === 0 ||
        new Set(evaluation.caseIds).size !== evaluation.caseIds.length ||
        evaluation.caseIds.some((caseId) => typeof caseId !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(caseId))) {
      throw new Error("Model attestation evaluation is invalid");
    }
    observed.add(pair);
  }
  return true;
}

export async function runReleaseGate(argv) {
  const statuses = [];
  try {
    const options = parseArgs(argv);
    const repo = fs.realpathSync(options.repo);
    const claudeBin = fs.realpathSync(options["claude-bin"]);
    if (await requireCommand("branch", "git", ["branch", "--show-current"], repo, statuses) !== "main") throw new Error("branch");
    if (await requireCommand("clean-tree", "git", ["status", "--porcelain"], repo, statuses) !== "") throw new Error("clean-tree");

    const head = await requireCommand("head", "git", ["rev-parse", "HEAD"], repo, statuses);
    const expected = expectedReleaseIdentity(repo, options, head);
    validateModelAttestation(repo, options["model-attestation"], expected);
    statuses.push({ label: "model-attestation", status: 0 });

    const remotes = (await requireCommand("remote-policy", "git", ["remote"], repo, statuses)).split("\n").filter(Boolean);
    if (options.requireNoRemote && remotes.length !== 0) throw new Error("remote-policy");
    if (options["expected-remote"]) {
      if (remotes.length !== 1 || remotes[0] !== "origin") throw new Error("remote-policy");
      const url = await requireCommand("remote-url", "git", ["remote", "get-url", "origin"], repo, statuses);
      if (url !== options["expected-remote"]) throw new Error("remote-url");
    }

    const tagCommit = await requireCommand("tag-commit", "git", ["rev-parse", `${options.tag}^{commit}`], repo, statuses);
    if (head !== tagCommit) throw new Error("tag-commit");
    const tagType = await requireCommand("annotated-tag", "git", ["cat-file", "-t", options.tag], repo, statuses);
    if (tagType !== "tag") throw new Error("annotated-tag");
    const tagSha = await requireCommand("tag-sha", "git", ["rev-parse", options.tag], repo, statuses);

    const claudeVersion = await requireCommand("claude-version", claudeBin, ["--version"], repo, statuses);
    if (claudeVersion !== expected.claudeVersion) throw new Error("claude-version");
    await requireCommand("marketplace-validation", claudeBin, ["plugin", "validate", "--strict", repo], repo, statuses);
    await requireCommand("plugin-validation", claudeBin, ["plugin", "validate", "--strict", path.join(repo, "plugins", "korean-plain")], repo, statuses);
    await requireCommand("deterministic-tests", process.execPath, [path.join(repo, "tests", "run-all.mjs")], repo, statuses, {
      ...process.env,
      CLAUDE_BIN: claudeBin,
    });
    await runAuthenticatedConfigPicker(repo, claudeBin, statuses);
    await requireCommand("working-tree-boundary", process.execPath, [path.join(repo, "scripts", "check-public-boundary.mjs"), "--repo", repo, "--working-tree"], repo, statuses);
    await requireCommand("history-boundary", process.execPath, [path.join(repo, "scripts", "check-public-boundary.mjs"), "--repo", repo, "--history"], repo, statuses);
    await requireCommand("tag-archive-boundary", process.execPath, [path.join(repo, "scripts", "check-public-boundary.mjs"), "--repo", repo, "--archive", options.tag], repo, statuses);

    console.log(`Release gate passed. commit=${head} tag=${tagSha} claude=${claudeVersion}`);
    for (const item of statuses) console.log(`${item.label}: exit ${item.status}`);
    return 0;
  } catch {
    console.error("Release gate failed. Command output is redacted.");
    for (const item of statuses) console.error(`${item.label}: exit ${item.status}`);
    return 1;
  }
}

// process.argv[1] is absent under `node -e`, where this module is imported
// for its exports rather than run as the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runReleaseGate(process.argv.slice(2));
}
