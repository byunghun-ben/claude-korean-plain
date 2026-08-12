import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guardedSettingsSnapshot, hashDirectory } from "../scripts/release-gate.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "release-gate.mjs");
const REDACTED_SECRET = ["gh", "o_", "Z".repeat(36)].join("");
const STYLE_SETTING_VALUE = "korean-plain:Korean Plain";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { mode: 0o755 });
}

function createFixture({ version = "0.1.0", lightweight = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-test-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  const plugin = path.join(repo, "plugins", "korean-plain");
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(plugin, "output-styles"), { recursive: true });
  fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const guardedUserSettings = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(guardedUserSettings, "content must never be read\n", { mode: 0o000 });
  fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), `${JSON.stringify({ name: "korean-plain", version }, null, 2)}\n`);
  fs.writeFileSync(path.join(plugin, "output-styles", "korean-plain.md"), "---\nname: Korean Plain\nkeep-coding-instructions: true\n---\n\n한국어로 답합니다.\n");
  writeExecutable(path.join(repo, "tests", "run-all.mjs"), `#!/usr/bin/env node
if (process.env.FAIL_DELEGATED) { console.error(${JSON.stringify(REDACTED_SECRET)}); process.exit(1); }
console.log("tests ok");
`);
  writeExecutable(path.join(repo, "scripts", "check-public-boundary.mjs"), `#!/usr/bin/env node
if (process.env.FAIL_BOUNDARY) { console.error(${JSON.stringify(REDACTED_SECRET)}); process.exit(1); }
console.log("boundary ok");
`);
  writeExecutable(path.join(repo, "tests", "config-picker.exp"), `#!/usr/bin/expect -f
set mode [lindex $argv 0]
set project [lindex $argv 3]
set settings "$project/.claude/settings.local.json"
if {$mode eq "select"} {
  set handle [open $settings "w"]
  puts $handle {{"localSentinel":{"preserve":true},"outputStyle":"korean-plain:Korean Plain"}}
  close $handle
} elseif {$mode eq "persist"} {
  # A real picker process performs /clear; this deterministic fixture preserves the selected state.
} else { exit 2 }
puts "CONFIG_PICKER_[string toupper $mode]_OK"
`);
  writeExecutable(path.join(bin, "claude"), `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.1.223 (Claude Code)"); process.exit(0); }
if (process.env.FAIL_CLAUDE) { console.error(${JSON.stringify(REDACTED_SECRET)}); process.exit(1); }
console.log("validation ok");
`);
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Byunghun");
  git(repo, "config", "user.email", "byunghun-ben@users.noreply.github.com");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "release fixture");
  if (lightweight) git(repo, "tag", "v0.1.0");
  else git(repo, "tag", "-a", "v0.1.0", "-m", "v0.1.0");
  return { root, repo, bin, home, plugin, guardedUserSettings, attestation: path.join(root, "attestation.json") };
}

function writeAttestation(fixture, overrides = {}) {
  const stylePath = path.join(fixture.plugin, "output-styles", "korean-plain.md");
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(fixture.plugin, ".claude-plugin", "plugin.json"), "utf8"));
  const base = {
    schemaVersion: 1,
    status: "pass",
    redacted: true,
    rawOutputsIncluded: false,
    releaseVersion: pluginManifest.version,
    tag: "v0.1.0",
    headCommit: git(fixture.repo, "rev-parse", "HEAD"),
    identity: {
      pluginSha256: hashDirectory(fixture.plugin),
      styleSha256: sha256(fs.readFileSync(stylePath)),
      configSha256: sha256(`${JSON.stringify({ outputStyle: STYLE_SETTING_VALUE }, null, 2)}\n`),
      styleSettingValue: STYLE_SETTING_VALUE,
    },
    evaluations: [
      { requestedModel: "sonnet", effort: "high", claudeVersion: "2.1.223 (Claude Code)", caseIds: ["qa-gap"], overallPass: true },
      { requestedModel: "opus", effort: "xhigh", claudeVersion: "2.1.223 (Claude Code)", caseIds: ["qa-gap"], overallPass: true },
    ],
  };
  const value = { ...base, ...overrides };
  fs.writeFileSync(fixture.attestation, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(fixture.attestation, 0o600);
  return value;
}

function args(fixture, extra = []) {
  return [
    "--repo", fixture.repo,
    "--tag", "v0.1.0",
    "--require-claude-version", "2.1.223",
    "--model-attestation", fixture.attestation,
    "--claude-bin", path.join(fixture.bin, "claude"),
    "--require-evaluation", "sonnet:high",
    "--require-evaluation", "opus:xhigh",
    "--allow-authenticated-config-picker",
    "--require-no-remote",
    ...extra,
  ];
}

function run(fixture, cliArgs = args(fixture), extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...cliArgs], {
    cwd: fixture.repo,
    encoding: "utf8",
    env: { ...process.env, HOME: fixture.home, PATH: `${fixture.bin}${path.delimiter}${process.env.PATH}`, ...extraEnv },
  });
}

function withFixture(options, test) {
  const fixture = createFixture(options);
  try { test(fixture); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  const result = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model-attestation: exit 0/);
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  fs.writeFileSync(path.join(fixture.repo, "dirty.txt"), "dirty\n");
  assert.equal(run(fixture).status, 1, "dirty tree must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  git(fixture.repo, "switch", "-c", "work");
  assert.equal(run(fixture).status, 1, "non-main branch must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  git(fixture.repo, "remote", "add", "origin", "https://example.invalid/wrong.git");
  const remoteArgs = args(fixture).filter((value) => value !== "--require-no-remote").concat(["--expected-remote", "https://github.com/byunghun-ben/claude-korean-plain.git"]);
  assert.equal(run(fixture, remoteArgs).status, 1, "remote mismatch must fail");
});

withFixture({}, (fixture) => {
  fs.writeFileSync(path.join(fixture.repo, "second.txt"), "second\n");
  git(fixture.repo, "add", ".");
  git(fixture.repo, "commit", "-m", "after tag");
  writeAttestation(fixture);
  assert.equal(run(fixture).status, 1, "tag not pointing to HEAD must fail");
});

withFixture({ lightweight: true }, (fixture) => {
  writeAttestation(fixture);
  assert.equal(run(fixture).status, 1, "lightweight tag must fail");
});

withFixture({ version: "0.2.0" }, (fixture) => {
  writeAttestation(fixture);
  assert.equal(run(fixture).status, 1, "plugin version and tag mismatch must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  const result = run(fixture, args(fixture), { FAIL_DELEGATED: "1" });
  assert.equal(result.status, 1, "delegated command failure must fail");
  assert.match(result.stderr, /Command output is redacted/);
  assert(!`${result.stdout}\n${result.stderr}`.includes(REDACTED_SECRET), "delegated secret output must be redacted");
});

withFixture({}, (fixture) => {
  const complete = writeAttestation(fixture);
  writeAttestation(fixture, { evaluations: [complete.evaluations[0]] });
  assert.equal(run(fixture).status, 1, "missing Opus evaluation must fail");
});

withFixture({}, (fixture) => {
  const complete = writeAttestation(fixture);
  writeAttestation(fixture, { evaluations: [complete.evaluations[1]] });
  assert.equal(run(fixture).status, 1, "missing Sonnet evaluation must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture, { headCommit: "0".repeat(40) });
  assert.equal(run(fixture).status, 1, "attestation HEAD mismatch must fail");
});

withFixture({}, (fixture) => {
  const complete = writeAttestation(fixture);
  writeAttestation(fixture, { identity: { ...complete.identity, styleSettingValue: "Korean Plain" } });
  assert.equal(run(fixture).status, 1, "unqualified outputStyle identity must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture, { redacted: false, rawOutputsIncluded: true });
  assert.equal(run(fixture).status, 1, "raw or unredacted attestation must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  fs.chmodSync(fixture.attestation, 0o644);
  assert.equal(run(fixture).status, 1, "attestation without exact mode 0600 must fail");
});

withFixture({}, (fixture) => {
  writeAttestation(fixture);
  const onlySonnet = args(fixture).filter((value, index, all) => !(value === "--require-evaluation" && all[index + 1] === "opus:xhigh") && value !== "opus:xhigh");
  assert.equal(run(fixture, onlySonnet).status, 1, "CLI must require both fixed evaluation pairs");
  assert.equal(run(fixture, [...args(fixture), "--unknown"]).status, 1, "unknown argument must fail closed");
  assert.equal(run(fixture, ["--repo", fixture.repo]).status, 1, "missing arguments must fail closed");
});

{
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-guard-"));
  try {
    const guarded = path.join(directory, "settings.json");
    assert.deepEqual(guardedSettingsSnapshot(guarded), { exists: false }, "a missing guarded file must be reported as absent");

    // The guard must never open the file, so an unreadable one still works.
    fs.writeFileSync(guarded, "content must never be read\n", { mode: 0o000 });
    const unreadable = guardedSettingsSnapshot(guarded);
    assert.equal(unreadable.exists, true, "the guard must observe a file it cannot read");
    fs.chmodSync(guarded, 0o600);

    fs.writeFileSync(guarded, '{"a":1}\n', { mode: 0o600 });
    const before = guardedSettingsSnapshot(guarded);

    // Claude Code replaces the file atomically; identical bytes are not a change.
    const temporary = path.join(directory, "settings.json.tmp");
    fs.writeFileSync(temporary, '{"a":1}\n', { mode: 0o600 });
    fs.renameSync(temporary, guarded);
    assert.deepEqual(guardedSettingsSnapshot(guarded), before, "an atomic rewrite of identical bytes must not count as a change");

    fs.writeFileSync(guarded, '{"added":true,"a":1}\n', { mode: 0o600 });
    assert.notDeepEqual(guardedSettingsSnapshot(guarded), before, "a settings edit that changes the size must be detected");

    fs.writeFileSync(guarded, '{"a":1}\n', { mode: 0o600 });
    fs.chmodSync(guarded, 0o644);
    assert.notDeepEqual(guardedSettingsSnapshot(guarded), before, "changed permissions must be detected");

    // Documented limit: without reading, a same-size edit is invisible.
    fs.chmodSync(guarded, 0o600);
    fs.writeFileSync(guarded, '{"a":2}\n');
    assert.deepEqual(guardedSettingsSnapshot(guarded), before, "a same-size edit is not detected because the guard never reads the file");

    fs.rmSync(guarded);
    fs.symlinkSync(path.join(directory, "missing.json"), guarded);
    assert.deepEqual(guardedSettingsSnapshot(guarded), { exists: false }, "a dangling symbolic link must not pass as settings");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

{
  // Importing the module for its exports must not run the CLI, and must work
  // under `node -e`, where process.argv[1] is absent.
  const imported = spawnSync(process.execPath, [
    "-e",
    'import("./scripts/release-gate.mjs").then((m) => console.log(typeof m.guardedSettingsSnapshot))'
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout.trim(), "function");
  assert(!imported.stderr.includes("Release gate"), "importing the module must not run the gate");
}

console.log("release gate: ok");
