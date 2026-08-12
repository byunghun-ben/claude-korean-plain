#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const CONTRACT = "docs/PUBLICATION-CONTRACT.md";
const PUBLIC_NAME = "Byunghun";
const PUBLIC_EMAIL = "byunghun-ben@users.noreply.github.com";
const ALLOWED_REF_PATTERNS = [
  /^refs\/heads\/main$/,
  /^refs\/remotes\/origin\/HEAD$/,
  /^refs\/remotes\/origin\/main$/,
  /^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/,
];

function git(repo, args, options = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: options.binary ? null : "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Git inspection failed (${args[0]})`);
  return result.stdout;
}

export function readAllowlist(repo) {
  const source = fs.readFileSync(path.join(repo, CONTRACT), "utf8");
  const section = source.match(/## Path allowlist\s+([\s\S]*?)(?=\n## )/);
  if (!section) throw new Error("Publication contract has no path allowlist");
  const entries = [...section[1].matchAll(/^- `([^`]+)`\s*$/gm)].map((match) => match[1]);
  if (entries.length === 0 || new Set(entries).size !== entries.length) {
    throw new Error("Publication contract path allowlist is empty or duplicated");
  }
  return new Set(entries);
}

function forbiddenPatterns() {
  const joined = (...parts) => parts.join("");
  return [
    { kind: "private-identity", regex: new RegExp(joined("service", "_suspended", "_at"), "i") },
    { kind: "private-identity", regex: new RegExp(joined("house", "hold"), "i") },
    { kind: "private-path", regex: new RegExp(joined("/Us", "ers/")) },
    { kind: "private-identity", regex: new RegExp(joined("claude", "-harness"), "i") },
    { kind: "private-identity", regex: new RegExp(joined("847", "e752"), "i") },
    { kind: "private-identity", regex: new RegExp(joined("session", "[_ -]?id"), "i") },
    { kind: "private-identity", regex: new RegExp(joined("deploy", "(?:ment)?[ _-]?manifest"), "i") },
    { kind: "private-branch", regex: /refs\/heads\/(?!main(?:\b|$))[^\s]+/i },
    { kind: "secret", regex: new RegExp(joined("AK", "IA", "[A-Z0-9]{16}")) },
    { kind: "secret", regex: new RegExp(joined("AS", "IA", "[A-Z0-9]{16}")) },
    { kind: "secret", regex: new RegExp(joined("gh", "[posur]_[A-Za-z0-9]{30,}")) },
    { kind: "secret", regex: new RegExp(joined("github", "_pat_[A-Za-z0-9_]{30,}"), "i") },
    { kind: "secret", regex: new RegExp(joined("sk", "-ant-[A-Za-z0-9_-]{20,}"), "i") },
    { kind: "secret", regex: new RegExp(joined("xox", "[abprs]-[A-Za-z0-9-]{20,}"), "i") },
    { kind: "secret", regex: new RegExp(joined("-----BEGIN ", "(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")) },
  ];
}

function contentViolations(buffer, locationKind) {
  if (buffer.includes(0)) return [{ kind: "binary-content", locationKind }];
  const text = buffer.toString("utf8");
  return forbiddenPatterns()
    .filter(({ regex }) => regex.test(text))
    .map(({ kind }) => ({ kind, locationKind }));
}

function pathViolations(relativePath, allowlist, locationKind) {
  const normalized = relativePath.split(path.sep).join("/").replace(/^\.\//, "");
  const results = [];
  if (!allowlist.has(normalized)) results.push({ kind: "path-not-allowlisted", locationKind });
  if (/(?:^|\/)(?:\.env(?:\.|$)|raw(?:[-_ ]?(?:model|output|response))?|evaluation[-_ ]?evidence|transcript)(?:[./_-]|$)/i.test(normalized)) {
    results.push({ kind: "prohibited-path", locationKind });
  }
  return results;
}

export function scanFilesystem(root, allowlist = readAllowlist(root), locationKind = "working-tree") {
  const violations = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        violations.push({ kind: "symbolic-link", locationKind });
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        violations.push(...pathViolations(relative, allowlist, locationKind));
        violations.push(...contentViolations(fs.readFileSync(absolute), locationKind));
      } else {
        violations.push({ kind: "unsupported-entry", locationKind });
      }
    }
  };
  visit(root);
  return violations;
}

export function scanWorkingTree(repo) {
  const allowlist = readAllowlist(repo);
  const violations = scanFilesystem(repo, allowlist, "working-tree");
  const tracked = git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean);
  for (const file of tracked) violations.push(...pathViolations(file, allowlist, "index"));
  return violations;
}

function objectType(repo, oid) {
  return git(repo, ["cat-file", "-t", oid]).trim();
}

function headerValue(rawObject, header) {
  const headerBlock = rawObject.split("\n\n", 1)[0];
  return headerBlock.split("\n").find((line) => line.startsWith(`${header} `))?.slice(header.length + 1) ?? null;
}

function validPublicIdentity(value) {
  if (!value) return false;
  const match = value.match(/^(.*?) <([^<>]+)> \d+ [+-]\d{4}$/);
  return match?.[1] === PUBLIC_NAME && match?.[2] === PUBLIC_EMAIL;
}

function identityViolation(rawObject, header, locationKind) {
  return validPublicIdentity(headerValue(rawObject, header)) ? [] : [{ kind: `invalid-${header}`, locationKind }];
}

export function scanRefs(repo) {
  const refs = git(repo, ["for-each-ref", "--format=%(refname)"]).split("\n").filter(Boolean);
  const violations = refs
    .filter((ref) => !ALLOWED_REF_PATTERNS.some((pattern) => pattern.test(ref)))
    .map(() => ({ kind: "unexpected-ref", locationKind: "git-ref" }));
  if (refs.includes("refs/remotes/origin/HEAD")) {
    const target = spawnSync("git", ["-C", repo, "symbolic-ref", "refs/remotes/origin/HEAD"], { encoding: "utf8" });
    if (target.status !== 0 || target.stdout.trim() !== "refs/remotes/origin/main") {
      violations.push({ kind: "unexpected-ref", locationKind: "git-ref" });
    }
  }
  return violations;
}

export function scanHistory(repo) {
  const allowlist = readAllowlist(repo);
  const violations = scanRefs(repo);
  const head = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return violations;

  const objects = git(repo, ["rev-list", "--objects", "--all"]).split("\n").filter(Boolean);
  for (const record of objects) {
    const separator = record.indexOf(" ");
    const oid = separator === -1 ? record : record.slice(0, separator);
    const objectPath = separator === -1 ? null : record.slice(separator + 1);
    if (objectType(repo, oid) !== "blob") continue;
    if (objectPath) violations.push(...pathViolations(objectPath, allowlist, "history-blob"));
    violations.push(...contentViolations(git(repo, ["cat-file", "blob", oid], { binary: true }), "history-blob"));
  }

  const commits = git(repo, ["rev-list", "--all"]).split("\n").filter(Boolean);
  for (const oid of commits) {
    const rawCommit = git(repo, ["cat-file", "commit", oid]);
    const message = rawCommit.slice(rawCommit.indexOf("\n\n") + 2);
    violations.push(...identityViolation(rawCommit, "author", "commit-header"));
    violations.push(...identityViolation(rawCommit, "committer", "commit-header"));
    violations.push(...contentViolations(Buffer.from(rawCommit.split("\n\n", 1)[0]), "commit-header"));
    violations.push(...contentViolations(Buffer.from(message), "commit-message"));
  }

  const tags = git(repo, ["for-each-ref", "--format=%(objectname) %(objecttype)", "refs/tags"])
    .split("\n").filter(Boolean);
  for (const record of tags) {
    const [oid, type] = record.split(" ");
    if (type !== "tag") continue;
    const rawTag = git(repo, ["cat-file", "tag", oid]);
    const message = rawTag.slice(rawTag.indexOf("\n\n") + 2);
    violations.push(...identityViolation(rawTag, "tagger", "tag-header"));
    violations.push(...contentViolations(Buffer.from(rawTag.split("\n\n", 1)[0]), "tag-header"));
    violations.push(...contentViolations(Buffer.from(message), "tag-message"));
  }
  return violations;
}

export function scanArchive(repo, tag) {
  if (!tag || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag)) throw new Error("Archive tag is invalid");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "public-boundary-archive-"));
  try {
    const archive = git(repo, ["archive", "--format=tar", tag], { binary: true });
    const tarPath = path.join(temporary, "archive.tar");
    const treePath = path.join(temporary, "tree");
    fs.writeFileSync(tarPath, archive, { mode: 0o600 });
    fs.mkdirSync(treePath, { mode: 0o700 });
    const extracted = spawnSync("tar", ["-xf", tarPath, "-C", treePath], { encoding: "utf8" });
    if (extracted.status !== 0) throw new Error("Tag archive extraction failed");
    return scanFilesystem(treePath, readAllowlist(treePath), "tag-archive");
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Naming the offending ref or path would defeat the redaction, so each kind
// that has a routine cause states the allowed set and the next step instead.
const REMEDIATION = new Map([
  ["unexpected-ref", [
    "Allowed refs: refs/heads/main, refs/remotes/origin/HEAD, refs/remotes/origin/main, and v-prefixed semver tags.",
    "Local tooling can leave refs in its own refs/<tool>/ namespace. List them with `git for-each-ref --format='%(refname)'`",
    "and delete the ones that do not belong with `git update-ref -d <ref>`.",
  ]],
]);

export function formatFailure(violations) {
  const counts = new Map();
  for (const violation of violations) counts.set(violation.kind, (counts.get(violation.kind) || 0) + 1);
  const kinds = [...counts].sort();
  return [
    `Public boundary failed: ${violations.length} violation(s).`,
    ...kinds.map(([kind, count]) => `- ${kind}: ${count}`),
    "Candidate values and paths are redacted.",
    ...kinds.flatMap(([kind]) => REMEDIATION.get(kind) ?? []),
  ].join("\n");
}

function parseArgs(argv) {
  let repo;
  let mode;
  let tag;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repo") repo = argv[++index];
    else if (argument === "--working-tree" || argument === "--history") mode = argument.slice(2);
    else if (argument === "--archive") { mode = "archive"; tag = argv[++index]; }
    else throw new Error("Unknown public-boundary argument");
  }
  if (!repo || !mode) throw new Error("Usage: check-public-boundary.mjs --repo PATH (--working-tree|--history|--archive TAG)");
  return { repo: fs.realpathSync(repo), mode, tag };
}

function main() {
  try {
    const { repo, mode, tag } = parseArgs(process.argv.slice(2));
    const violations = mode === "working-tree" ? scanWorkingTree(repo) : mode === "history" ? scanHistory(repo) : scanArchive(repo, tag);
    if (violations.length) {
      console.error(formatFailure(violations));
      process.exitCode = 1;
    } else {
      console.log(`Public boundary passed (${mode}).`);
    }
  } catch (error) {
    console.error("Public boundary failed before completion. Details are redacted.");
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
