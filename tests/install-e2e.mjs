import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIXTURE_ROOT = join(REPOSITORY_ROOT, "tests", "fixtures");
const PLUGIN_ROOT = join(REPOSITORY_ROOT, "plugins", "korean-plain");
const PLUGIN_ID = "korean-plain@claude-korean-plain";
const INLINE_PLUGIN_ID = "korean-plain@inline";
const MARKETPLACE_NAME = "claude-korean-plain";
const README_MARKETPLACE_SOURCE = "https://github.com/byunghun-ben/claude-korean-plain.git";
const EXPECTED_VERSION = "2.1.223 (Claude Code)";
const CACHE_PLUGIN_FILES = [
  ".claude-plugin/plugin.json",
  "output-styles/korean-plain.md",
];
const INSTALLER_MANAGED_KEYS = new Set(["enabledPlugins", "extraKnownMarketplaces"]);
const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
];
const GITHUB_CREDENTIAL_ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_ENTERPRISE_TOKEN",
];

function usage(message) {
  if (message) process.stderr.write(`${message}\n\n`);
  process.stderr.write(
    "Usage: node tests/install-e2e.mjs --source local|github --scope user|project " +
      "--claude /absolute/path/to/claude [--anonymous]\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const options = { source: undefined, scope: undefined, claude: undefined, anonymous: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--anonymous") {
      options.anonymous = true;
      continue;
    }
    if (!["--source", "--scope", "--claude"].includes(argument)) {
      usage(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }

  if (!new Set(["local", "github"]).has(options.source)) usage("--source must be local or github");
  if (!new Set(["user", "project"]).has(options.scope)) usage("--scope must be user or project");
  if (!options.claude || !isAbsolute(options.claude)) usage("--claude must be an absolute path");
  if (options.source === "local" && options.anonymous) usage("--anonymous is only valid with github source");
  return options;
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function metadataSnapshot(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path, { bigint: true });
  assert(stat.isFile(), `guarded path is not a regular file: ${path}`);
  return {
    exists: true,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    mode: stat.mode.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  };
}

function realClaudeGuard() {
  const root = join(homedir(), ".claude");
  const rootSnapshot = existsSync(root)
    ? (() => {
        const stat = lstatSync(root, { bigint: true });
        assert(stat.isDirectory(), "the real ~/.claude path must be a directory");
        return {
          exists: true,
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
          mode: stat.mode.toString(),
          mtimeNs: stat.mtimeNs.toString(),
        };
      })()
    : { exists: false };
  const guardedFiles = ["settings.json", "plugins/installed_plugins.json", "plugins/known_marketplaces.json"];
  return {
    root,
    rootSnapshot,
    files: new Map(guardedFiles.map((path) => [path, metadataSnapshot(join(root, path))])),
  };
}

function assertRealClaudeUnchanged(guard) {
  const currentRoot = existsSync(guard.root)
    ? (() => {
        const stat = lstatSync(guard.root, { bigint: true });
        return {
          exists: true,
          device: stat.dev.toString(),
          inode: stat.ino.toString(),
          mode: stat.mode.toString(),
          mtimeNs: stat.mtimeNs.toString(),
        };
      })()
    : { exists: false };
  assert.deepEqual(currentRoot, guard.rootSnapshot, "the real ~/.claude directory identity or mtime changed");
  for (const [path, snapshot] of guard.files) {
    assert.deepEqual(metadataSnapshot(join(guard.root, path)), snapshot, `the real ~/.claude/${path} changed`);
  }
}

function assertOnlyManagedSettingsChanged(before, after, label) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (INSTALLER_MANAGED_KEYS.has(key)) continue;
    assert.deepEqual(after[key], before[key], `${label} changed non-installer setting ${key}`);
  }
}

function walkFiles(root) {
  const files = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const path = relative(root, absolutePath).split(sep).join("/");
      const stat = lstatSync(absolutePath);
      assert(!stat.isSymbolicLink(), `cache contains a symlink: ${path}`);
      if (stat.isDirectory()) visit(absolutePath);
      else {
        assert(stat.isFile(), `cache contains an unsupported entry: ${path}`);
        assert.equal(stat.mode & 0o111, 0, `cache contains an executable: ${path}`);
        files.push(path);
      }
    }
  }
  visit(root);
  return files.sort();
}

function makeEnvironment(options) {
  const root = mkdtempSync(join(tmpdir(), "korean-plain-install-e2e-"));
  const fakeHome = join(root, "home");
  const config = join(root, "config");
  const cache = join(root, "plugin-cache");
  const project = join(root, "project");
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(cache, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });

  const userSettings = join(config, "settings.json");
  const projectSettings = join(project, ".claude", "settings.json");
  const localSettings = join(project, ".claude", "settings.local.json");
  const mcp = join(project, ".mcp.json");
  copyFileSync(join(FIXTURE_ROOT, "user-settings.json"), userSettings);
  copyFileSync(join(FIXTURE_ROOT, "project-settings.json"), projectSettings);
  copyFileSync(join(FIXTURE_ROOT, "project-mcp.json"), mcp);
  writeJson(localSettings, { localSentinel: { preserve: true }, outputStyle: "Explanatory" });

  const environment = { ...process.env };
  for (const key of CREDENTIAL_ENV_KEYS) delete environment[key];
  if (options.anonymous) {
    for (const key of GITHUB_CREDENTIAL_ENV_KEYS) delete environment[key];
    for (const key of Object.keys(environment)) {
      if (/^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete environment[key];
    }
    delete environment.GIT_ASKPASS;
    delete environment.SSH_ASKPASS;
    delete environment.CLAUDE_CODE_PLUGIN_PREFER_HTTPS;
    environment.GH_CONFIG_DIR = join(root, "empty-gh-config");
    environment.GIT_CONFIG_GLOBAL = join(root, "empty-gitconfig");
    environment.GIT_CONFIG_NOSYSTEM = "1";
    environment.GIT_TERMINAL_PROMPT = "0";
    environment.GCM_INTERACTIVE = "never";
    environment.SSH_AUTH_SOCK = "";
    writeFileSync(environment.GIT_CONFIG_GLOBAL, "", { mode: 0o600 });
  }
  Object.assign(environment, {
    HOME: fakeHome,
    CLAUDE_CONFIG_DIR: config,
    CLAUDE_CODE_PLUGIN_CACHE_DIR: cache,
    CLAUDE_CODE_USE_BEDROCK: "0",
    CLAUDE_CODE_USE_VERTEX: "0",
    CLAUDE_CODE_USE_FOUNDRY: "0",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    NO_COLOR: "1",
  });

  const realRoot = resolve(join(homedir(), ".claude"));
  for (const isolatedPath of [root, fakeHome, config, cache, project]) {
    const resolved = resolve(isolatedPath);
    assert(resolved !== realRoot && !resolved.startsWith(`${realRoot}${sep}`), "isolated path escaped into the real ~/.claude");
  }

  return { root, config, cache, project, userSettings, projectSettings, localSettings, mcp, environment };
}

function killProcessGroup(child, signal) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
    return;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function spawnWithHardTimeout(command, args, { cwd, env, timeoutMs = 30_000, stdin = "ignore" }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: [stdin, "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let settled = false;

    const append = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) {
        killProcessGroup(child, "SIGKILL");
        reject(new Error(`command exceeded 4 MiB output limit: ${command} ${args.join(" ")}`));
        settled = true;
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      if (!settled) reject(error);
      settled = true;
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, "SIGTERM");
      setTimeout(() => killProcessGroup(child, "SIGKILL"), 750).unref();
    }, timeoutMs);

    child.on("close", (status, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const result = {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(new Error(`command timed out after ${timeoutMs}ms and its process group was killed: ${command} ${args.join(" ")}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

function commandRunner(options, sandbox) {
  return async function run(args, { json = false } = {}) {
    assert(
      args.length === 1 && args[0] === "--version" || args.includes("plugin"),
      "install E2E may only invoke version and plugin-management commands",
    );
    const result = await spawnWithHardTimeout(options.claude, args, {
      cwd: sandbox.project,
      env: sandbox.environment,
    });
    assert.equal(
      result.status,
      0,
      `claude command failed (${args.join(" ")}): ${(result.stderr || result.stdout).trim()}`,
    );
    const output = result.stdout.trim();
    return json ? JSON.parse(output || "null") : output;
  };
}

function findInstalledPlugin(plugins, enabled) {
  assert(Array.isArray(plugins), "plugin list --json must return an array");
  const matches = plugins.filter((plugin) => plugin.id === PLUGIN_ID);
  assert.equal(matches.length, 1, `expected exactly one ${PLUGIN_ID} installation`);
  const plugin = matches[0];
  assert.equal(plugin.version, "0.1.1");
  assert.equal(plugin.enabled, enabled);
  return plugin;
}

function assertCache(installPath) {
  assert(isAbsolute(installPath), "plugin install path must be absolute");
  const allFiles = walkFiles(installPath);
  const installerMarkers = allFiles.filter((path) => path.startsWith(".in_use/"));
  assert(
    installerMarkers.every((path) => /^\.in_use\/[A-Za-z0-9._-]+$/.test(path)),
    "installed plugin cache has an invalid installer marker",
  );
  const pluginFiles = allFiles.filter((path) => !path.startsWith(".in_use/"));
  assert.deepEqual(pluginFiles, CACHE_PLUGIN_FILES, "installed plugin cache has unexpected plugin contents");
  for (const path of CACHE_PLUGIN_FILES) {
    assert.equal(
      sha256(readFileSync(join(installPath, path))),
      sha256(readFileSync(join(PLUGIN_ROOT, path))),
      `cached ${path} differs from the source plugin`,
    );
  }
}

function assertCacheMetadata(sandbox, scope, installPath) {
  const installedMetadata = readJson(join(sandbox.cache, "installed_plugins.json"));
  assert.equal(installedMetadata.version, 2, "unexpected installed plugin metadata version");
  const records = installedMetadata.plugins?.[PLUGIN_ID];
  assert(Array.isArray(records), "installed plugin metadata is missing the target plugin");
  assert.equal(records.length, 1, "installed plugin metadata has duplicate target records");
  assert.equal(records[0].scope, scope);
  assert.equal(records[0].version, "0.1.1");
  assert.equal(resolve(records[0].installPath), resolve(installPath));

  const marketplaceMetadata = readJson(join(sandbox.cache, "known_marketplaces.json"));
  assert(marketplaceMetadata[MARKETPLACE_NAME], "cache metadata is missing the marketplace");
  assert.equal(typeof marketplaceMetadata[MARKETPLACE_NAME].source?.source, "string");
}

function assertPreexistingEnabledPlugin(settings, initialSettings, label) {
  assert.equal(
    settings.enabledPlugins?.["fixture-plugin@fixture-marketplace"],
    initialSettings.enabledPlugins["fixture-plugin@fixture-marketplace"],
    `${label} changed the preexisting enabledPlugins sentinel`,
  );
}

async function exerciseOutputStyleBoundary(run, sandbox) {
  const before = readJson(sandbox.localSettings);
  const selected = structuredClone(before);
  selected.outputStyle = "korean-plain:Korean Plain";
  writeJson(sandbox.localSettings, selected);
  const details = await run(["plugin", "details", PLUGIN_ID]);
  assert.match(details, /^korean-plain 0\.1\.1/m);
  assert.deepEqual(readJson(sandbox.localSettings), selected, "fresh CLI process did not preserve explicit outputStyle selection");

  const reset = structuredClone(selected);
  delete reset.outputStyle;
  writeJson(sandbox.localSettings, reset);
  assert.deepEqual(readJson(sandbox.localSettings), { localSentinel: before.localSentinel }, "Default reset changed local sentinel state");
}

async function runE2E(options, sandbox) {
  const run = commandRunner(options, sandbox);
  assert.equal(await run(["--version"]), EXPECTED_VERSION, `this E2E is pinned to Claude Code ${EXPECTED_VERSION}`);

  const initialUserBytes = readFileSync(sandbox.userSettings);
  const initialProjectBytes = readFileSync(sandbox.projectSettings);
  const initialLocalBytes = readFileSync(sandbox.localSettings);
  const initialMcpBytes = readFileSync(sandbox.mcp);
  const initialUser = readJson(sandbox.userSettings);
  const initialProject = readJson(sandbox.projectSettings);

  if (options.source === "local") {
    const inlinePlugins = await run(["--plugin-dir", PLUGIN_ROOT, "plugin", "list", "--json"], { json: true });
    const inline = inlinePlugins.filter((plugin) => plugin.id === INLINE_PLUGIN_ID);
    assert.equal(inline.length, 1, "local --plugin-dir did not discover korean-plain@inline");
    assert.equal(inline[0].version, "0.1.1");
    assert.equal(inline[0].scope, "session");
    assert.equal(inline[0].enabled, true);
    assert.equal(resolve(inline[0].installPath), resolve(PLUGIN_ROOT));
    const inlineDetails = await run(["--plugin-dir", PLUGIN_ROOT, "plugin", "details", "korean-plain"]);
    assert.match(inlineDetails, /Source: korean-plain@inline/);
    assert.deepEqual(readFileSync(sandbox.userSettings), initialUserBytes, "--plugin-dir changed user settings");
    assert.deepEqual(readFileSync(sandbox.projectSettings), initialProjectBytes, "--plugin-dir changed project settings");
    assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "--plugin-dir changed local settings");
    assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "--plugin-dir changed MCP fixture");
  }

  const marketplaceSource = options.source === "local" ? REPOSITORY_ROOT : README_MARKETPLACE_SOURCE;
  if (options.source === "github") {
    const readme = readFileSync(join(REPOSITORY_ROOT, "README.md"), "utf8");
    assert(
      readme.includes(`claude plugin marketplace add ${marketplaceSource} --scope ${options.scope}`),
      `README must contain the exact anonymous ${options.scope}-scope marketplace command exercised by this E2E`,
    );
  }
  await run(["plugin", "marketplace", "add", "--scope", options.scope, marketplaceSource]);

  const targetSettingsPath = options.scope === "user" ? sandbox.userSettings : sandbox.projectSettings;
  const otherSettingsPath = options.scope === "user" ? sandbox.projectSettings : sandbox.userSettings;
  const initialTarget = options.scope === "user" ? initialUser : initialProject;
  const initialOtherBytes = options.scope === "user" ? initialProjectBytes : initialUserBytes;
  let target = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, target, "marketplace add");
  assertPreexistingEnabledPlugin(target, initialTarget, "marketplace add");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "marketplace declaration is missing from target settings");
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "marketplace add changed the other settings scope");
  assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "marketplace add changed local settings");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "marketplace add changed MCP fixture");
  const marketplaces = await run(["plugin", "marketplace", "list", "--json"], { json: true });
  assert.equal(marketplaces.filter((marketplace) => marketplace.name === MARKETPLACE_NAME).length, 1);

  await run(["plugin", "install", "--scope", options.scope, PLUGIN_ID]);
  target = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, target, "plugin install");
  assertPreexistingEnabledPlugin(target, initialTarget, "plugin install");
  assert.equal(target.enabledPlugins?.[PLUGIN_ID], true, "plugin install did not enable the target plugin");
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "plugin install changed the other settings scope");
  assert.deepEqual(readFileSync(sandbox.localSettings), initialLocalBytes, "plugin install changed explicit outputStyle state");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "plugin install changed MCP fixture");

  let installed = findInstalledPlugin(await run(["plugin", "list", "--json"], { json: true }), true);
  assert.equal(installed.scope, options.scope);
  assertCache(installed.installPath);
  assertCacheMetadata(sandbox, options.scope, installed.installPath);
  const details = await run(["plugin", "details", PLUGIN_ID]);
  assert.match(details, /^korean-plain 0\.1\.1/m);
  assert.match(details, /Source: korean-plain@claude-korean-plain/);
  assert.match(details, /Skills \(0\)/);
  assert.match(details, /Agents \(0\)/);
  assert.match(details, /Hooks \(0\)/);
  assert.match(details, /MCP servers \(0\)/);

  await exerciseOutputStyleBoundary(run, sandbox);

  await run(["plugin", "disable", "--scope", options.scope, PLUGIN_ID]);
  installed = findInstalledPlugin(await run(["plugin", "list", "--json"], { json: true }), false);
  assertCache(installed.installPath);
  target = readJson(targetSettingsPath);
  assert.equal(target.enabledPlugins?.[PLUGIN_ID], false, "disable did not preserve a false enabled state");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "disable removed the marketplace declaration");
  assertOnlyManagedSettingsChanged(initialTarget, target, "plugin disable");
  assertPreexistingEnabledPlugin(target, initialTarget, "plugin disable");

  await run(["plugin", "uninstall", "--scope", options.scope, PLUGIN_ID]);
  const afterUninstall = await run(["plugin", "list", "--json"], { json: true });
  assert.equal(afterUninstall.some((plugin) => plugin.id === PLUGIN_ID), false, "uninstall left an active plugin");
  target = readJson(targetSettingsPath);
  assert.equal(PLUGIN_ID in (target.enabledPlugins ?? {}), false, "uninstall left an enabledPlugins declaration");
  assert(target.extraKnownMarketplaces?.[MARKETPLACE_NAME], "uninstall removed marketplace before explicit removal");

  await run(["plugin", "marketplace", "remove", "--scope", options.scope, MARKETPLACE_NAME]);
  const finalMarketplaces = await run(["plugin", "marketplace", "list", "--json"], { json: true });
  assert.equal(finalMarketplaces.some((marketplace) => marketplace.name === MARKETPLACE_NAME), false, "marketplace remove left a declaration");

  const finalTarget = readJson(targetSettingsPath);
  assertOnlyManagedSettingsChanged(initialTarget, finalTarget, "final lifecycle state");
  assertPreexistingEnabledPlugin(finalTarget, initialTarget, "final lifecycle state");
  assert.equal(PLUGIN_ID in (finalTarget.enabledPlugins ?? {}), false);
  assert.equal(MARKETPLACE_NAME in (finalTarget.extraKnownMarketplaces ?? {}), false);
  // Claude Code may retain the immutable payload with its own orphan marker;
  // installed_plugins.json, not cache presence, owns active-install state.
  const installedMetadataPath = join(sandbox.cache, "installed_plugins.json");
  if (existsSync(installedMetadataPath)) {
    const finalInstalledMetadata = readJson(installedMetadataPath);
    assert.equal(PLUGIN_ID in (finalInstalledMetadata.plugins ?? {}), false, "uninstall left plugin cache metadata");
  }
  const marketplaceMetadataPath = join(sandbox.cache, "known_marketplaces.json");
  if (existsSync(marketplaceMetadataPath)) {
    const finalMarketplaceMetadata = readJson(marketplaceMetadataPath);
    assert.equal(MARKETPLACE_NAME in finalMarketplaceMetadata, false, "marketplace remove left cache metadata");
  }
  assert.deepEqual(readFileSync(otherSettingsPath), initialOtherBytes, "lifecycle changed the other settings scope");
  assert.deepEqual(readFileSync(sandbox.mcp), initialMcpBytes, "lifecycle changed MCP fixture");
  assert.deepEqual(readJson(sandbox.localSettings), { localSentinel: { preserve: true } }, "outputStyle reset changed local sentinel state");
}

const options = parseArgs(process.argv.slice(2));
const guard = realClaudeGuard();
const sandbox = makeEnvironment(options);
let failure;
try {
  await runE2E(options, sandbox);
} catch (error) {
  failure = error;
}
try {
  assertRealClaudeUnchanged(guard);
} catch (error) {
  failure ??= error;
}
rmSync(sandbox.root, { recursive: true, force: true });
if (failure) throw failure;

console.log(`install e2e (${options.source}, ${options.scope}): ok`);
console.log("outputStyle boundary: isolated settings.local selection, fresh-process identity, and reset verified");
console.log("interactive /config proof is opt-in: expect tests/config-picker.exp select|persist|reset CLAUDE PLUGIN DISPOSABLE_PROJECT");
