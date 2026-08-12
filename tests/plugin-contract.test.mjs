import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_STYLE_SHA256 =
  "8485edaf14ff512d6cc30d201efb7d24b3259bfffa0aefbe3c1e136a5b1c228b";
const ALLOWED_PLUGIN_PATHS = new Set([
  ".claude-plugin",
  ".claude-plugin/plugin.json",
  "output-styles",
  "output-styles/korean-plain.md",
]);
const PROHIBITED_COMPONENTS = new Set([
  "skills",
  "agents",
  "hooks",
  ".mcp.json",
  ".lsp.json",
  "bin",
  "settings.json",
  "package.json",
]);

function readJson(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON at ${path}: ${error.message}`);
  }
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), `${path} must contain an object`);
  return parsed;
}

function assertExactKeys(object, expectedKeys, label) {
  assert.deepEqual(Object.keys(object).sort(), [...expectedKeys].sort(), `${label} has unexpected or missing fields`);
}

function parseFrontmatter(contents) {
  const match = contents.match(/^---\n([\s\S]*?)\n---\n(?:\n|$)([\s\S]*)$/);
  assert(match, "style must have a complete YAML frontmatter block");

  const fields = Object.create(null);
  for (const line of match[1].split("\n")) {
    const field = line.match(/^([a-z][a-z-]*):(?: (.*))?$/);
    assert(field, `invalid frontmatter line: ${line}`);
    assert(!(field[1] in fields), `duplicate frontmatter field: ${field[1]}`);
    fields[field[1]] = field[2] ?? "";
  }
  assert(match[2].trim(), "style body must not be empty");
  return fields;
}

function walkPlugin(pluginRoot) {
  const found = [];
  function walk(directory) {
    for (const entry of readdirSync(directory)) {
      const absolutePath = join(directory, entry);
      const pluginPath = relative(pluginRoot, absolutePath);
      const stat = lstatSync(absolutePath);
      assert(!stat.isSymbolicLink(), `symlink is prohibited: ${pluginPath}`);
      assert(ALLOWED_PLUGIN_PATHS.has(pluginPath), `prohibited component or extra file: ${pluginPath}`);
      assert(!PROHIBITED_COMPONENTS.has(entry), `prohibited component: ${pluginPath}`);
      assert(stat.isDirectory() || stat.isFile(), `unsupported filesystem entry: ${pluginPath}`);
      if (stat.isFile()) {
        assert.equal(stat.mode & 0o111, 0, `executable is prohibited: ${pluginPath}`);
      }
      found.push(pluginPath);
      if (stat.isDirectory()) walk(absolutePath);
    }
  }
  walk(pluginRoot);
  assert.deepEqual(found.sort(), [...ALLOWED_PLUGIN_PATHS].sort(), "plugin tree does not match the output-style-only allowlist");
}

function validateContract(repositoryRoot) {
  const marketplacePath = join(repositoryRoot, ".claude-plugin", "marketplace.json");
  const pluginRoot = join(repositoryRoot, "plugins", "korean-plain");
  const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
  const stylePath = join(pluginRoot, "output-styles", "korean-plain.md");

  const marketplace = readJson(marketplacePath);
  assertExactKeys(marketplace, ["name", "description", "owner", "plugins"], "marketplace");
  assert.equal(marketplace.name, "claude-korean-plain");
  assert.equal(typeof marketplace.description, "string");
  assert(marketplace.description.trim(), "marketplace description must not be empty");
  assertExactKeys(marketplace.owner, ["name"], "marketplace owner");
  assert.equal(marketplace.owner.name, "Byunghun");
  assert.equal(marketplace.plugins.length, 1, "marketplace must contain exactly one plugin");
  const marketplacePlugin = marketplace.plugins[0];
  assertExactKeys(marketplacePlugin, ["name", "description", "source"], "marketplace plugin entry");
  assert.equal(marketplacePlugin.name, "korean-plain");
  assert(marketplacePlugin.description.trim(), "marketplace plugin description must not be empty");
  assert.equal(marketplacePlugin.source, "./plugins/korean-plain");
  assert(!("version" in marketplacePlugin), "marketplace plugin entry must not own a version");

  const manifest = readJson(manifestPath);
  assertExactKeys(
    manifest,
    ["name", "description", "version", "author", "homepage", "repository", "license", "keywords"],
    "plugin manifest",
  );
  assert.equal(manifest.name, "korean-plain");
  assert.equal(manifest.version, "0.2.0", "plugin manifest version must be 0.2.0");
  assert(manifest.description.trim(), "plugin description must not be empty");
  assert.deepEqual(manifest.author, { name: "Byunghun" });
  assert.equal(manifest.homepage, "https://github.com/byunghun-ben/claude-korean-plain");
  assert.equal(manifest.repository, "https://github.com/byunghun-ben/claude-korean-plain");
  assert.equal(manifest.license, "MIT");
  assert(Array.isArray(manifest.keywords) && manifest.keywords.length > 0, "plugin keywords must not be empty");

  const style = readFileSync(stylePath, "utf8");
  const frontmatter = parseFrontmatter(style);
  assertExactKeys(frontmatter, ["name", "description", "keep-coding-instructions", "force-for-plugin"], "style frontmatter");
  assert.equal(frontmatter.name, "Korean Plain");
  assert(frontmatter.description.trim(), "style description must not be empty");
  assert.equal(frontmatter["keep-coding-instructions"], "true");
  assert.equal(frontmatter["force-for-plugin"], "true", "the style must apply while the plugin is enabled");
  assert.equal(createHash("sha256").update(style).digest("hex"), EXPECTED_STYLE_SHA256, "style SHA-256 must match the seed");

  walkPlugin(pluginRoot);
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "korean-plain-contract-"));
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  mkdirSync(join(root, "plugins"), { recursive: true });
  cpSync(join(REPOSITORY_ROOT, ".claude-plugin", "marketplace.json"), join(root, ".claude-plugin", "marketplace.json"));
  cpSync(join(REPOSITORY_ROOT, "plugins", "korean-plain"), join(root, "plugins", "korean-plain"), { recursive: true });
  return root;
}

function negativeCase(name, mutate, expectedMessage) {
  const root = makeFixture();
  try {
    mutate(root);
    assert.throws(() => validateContract(root), expectedMessage, `${name} must fail closed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

validateContract(REPOSITORY_ROOT);

negativeCase(
  "prohibited component",
  (root) => {
    const path = join(root, "plugins", "korean-plain", "skills", "unexpected.md");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "prohibited\n");
  },
  /prohibited component or extra file/,
);

negativeCase(
  "additional marketplace plugin",
  (root) => {
    const path = join(root, ".claude-plugin", "marketplace.json");
    const marketplace = readJson(path);
    marketplace.plugins.push({ name: "unexpected", description: "Unexpected", source: "./plugins/unexpected" });
    writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`);
  },
  /exactly one plugin/,
);

negativeCase(
  "version mismatch",
  (root) => {
    const path = join(root, "plugins", "korean-plain", ".claude-plugin", "plugin.json");
    const manifest = readJson(path);
    manifest.version = "0.2.1";
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  },
  /version must be 0\.2\.0/,
);

negativeCase(
  "missing force-for-plugin",
  (root) => {
    const path = join(root, "plugins", "korean-plain", "output-styles", "korean-plain.md");
    const style = readFileSync(path, "utf8").replace("\nforce-for-plugin: true", "");
    writeFileSync(path, style);
  },
  /style frontmatter has unexpected or missing fields/,
);

negativeCase(
  "invalid frontmatter",
  (root) => {
    const path = join(root, "plugins", "korean-plain", "output-styles", "korean-plain.md");
    const style = readFileSync(path, "utf8").replace("description: Natural", "description Natural");
    writeFileSync(path, style);
  },
  /invalid frontmatter line/,
);

negativeCase(
  "symlinked plugin file",
  (root) => {
    const path = join(root, "plugins", "korean-plain", "output-styles", "korean-plain.md");
    rmSync(path);
    symlinkSync(join(REPOSITORY_ROOT, "plugins", "korean-plain", "output-styles", "korean-plain.md"), path);
  },
  /symlink is prohibited/,
);

negativeCase(
  "executable plugin file",
  (root) => {
    chmodSync(join(root, "plugins", "korean-plain", "output-styles", "korean-plain.md"), 0o755);
  },
  /executable is prohibited/,
);

console.log("plugin contract: ok");
