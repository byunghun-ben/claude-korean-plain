import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  formatFailure,
  scanArchive,
  scanHistory,
  scanRefs,
  scanWorkingTree,
} from "../scripts/check-public-boundary.mjs";

const badIdentity = () => ["session", "_id"].join("");
const shapedSecret = () => ["gh", "p_", "A".repeat(36)].join("");
const githubToken = (kind) => ["gh", `${kind}_`, "A".repeat(36)].join("");

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args[0]} failed`);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-boundary-test-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "PUBLICATION-CONTRACT.md"), [
    "# Publication Contract",
    "",
    "## Path allowlist",
    "",
    "- `docs/PUBLICATION-CONTRACT.md`",
    "- `allowed.txt`",
    "",
    "## Prohibited data",
    "",
    "No private material.",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "allowed.txt"), "synthetic public fixture\n");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Byunghun");
  git(root, "config", "user.email", "byunghun-ben@users.noreply.github.com");
  return root;
}

function withFixture(test) {
  const root = fixture();
  try { test(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

withFixture((root) => {
  assert.deepEqual(scanWorkingTree(root), []);
});

withFixture((root) => {
  fs.writeFileSync(path.join(root, ["raw", "output.json"].join("-")), "synthetic\n");
  assert(scanWorkingTree(root).some((item) => item.kind === "path-not-allowlisted"), "forbidden path must fail");
});

withFixture((root) => {
  fs.symlinkSync("allowed.txt", path.join(root, "link.txt"));
  assert(scanWorkingTree(root).some((item) => item.kind === "symbolic-link"), "untracked symlink must fail");
});

withFixture((root) => {
  fs.writeFileSync(path.join(root, "allowed.txt"), shapedSecret());
  const violations = scanWorkingTree(root);
  assert(violations.some((item) => item.kind === "secret"), "secret-shaped value must fail");
  const output = formatFailure(violations);
  assert(!output.includes(shapedSecret()), "failure output must redact candidate values");
});

for (const kind of ["o", "s", "u", "r"]) {
  withFixture((root) => {
    fs.writeFileSync(path.join(root, "allowed.txt"), githubToken(kind));
    assert(scanWorkingTree(root).some((item) => item.kind === "secret"), `gh${kind}_ token must fail`);
  });
}

withFixture((root) => {
  git(root, "add", ".");
  git(root, "commit", "-m", `contains ${badIdentity()}`);
  assert(scanHistory(root).some((item) => item.locationKind === "commit-message"), "forbidden commit message must fail");
});

withFixture((root) => {
  git(root, "add", ".");
  git(root, "commit", "-m", "clean release");
  git(root, "branch", "private-work");
  assert(scanRefs(root).some((item) => item.kind === "unexpected-ref"), "non-main branch ref must fail");
  assert(scanHistory(root).some((item) => item.kind === "unexpected-ref"), "history must include ref validation");
});

withFixture((root) => {
  git(root, "add", ".");
  git(root, "commit", "-m", "clean release");
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main");
  assert(scanRefs(root).some((item) => item.kind === "unexpected-ref"), "origin HEAD must point only to origin/main");
});

withFixture((root) => {
  git(root, "add", ".");
  const result = spawnSync("git", ["-C", root, "commit", "--author", "Private Person <private@example.invalid>", "-m", "clean message"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert(scanHistory(root).some((item) => item.kind === "invalid-author" && item.locationKind === "commit-header"), "raw author header must be public identity");
});

withFixture((root) => {
  git(root, "add", ".");
  const result = spawnSync("git", ["-C", root, "commit", "-m", "clean message"], {
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_NAME: "Private Person", GIT_COMMITTER_EMAIL: "private@example.invalid" },
  });
  assert.equal(result.status, 0);
  assert(scanHistory(root).some((item) => item.kind === "invalid-committer" && item.locationKind === "commit-header"), "raw committer header must be public identity");
});

withFixture((root) => {
  git(root, "add", ".");
  git(root, "commit", "-m", "clean release");
  const result = spawnSync("git", ["-C", root, "tag", "-a", "v0.0.0", "-m", "clean tag"], {
    encoding: "utf8",
    env: { ...process.env, GIT_COMMITTER_NAME: "Private Person", GIT_COMMITTER_EMAIL: "private@example.invalid" },
  });
  assert.equal(result.status, 0);
  assert(scanHistory(root).some((item) => item.kind === "invalid-tagger" && item.locationKind === "tag-header"), "raw tagger header must be public identity");
});

withFixture((root) => {
  git(root, "add", ".");
  git(root, "commit", "-m", "clean release");
  git(root, "tag", "-a", "v0.0.0", "-m", `contains ${badIdentity()}`);
  assert(scanHistory(root).some((item) => item.locationKind === "tag-message"), "forbidden annotated tag message must fail");
});

withFixture((root) => {
  fs.writeFileSync(path.join(root, "allowed.txt"), shapedSecret());
  git(root, "add", ".");
  git(root, "commit", "-m", "add temporary fixture");
  fs.writeFileSync(path.join(root, "allowed.txt"), "synthetic public fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "remove temporary fixture");
  assert.deepEqual(scanWorkingTree(root), []);
  assert(scanHistory(root).some((item) => item.locationKind === "history-blob" && item.kind === "secret"), "deleted reachable blob must fail");
});

withFixture((root) => {
  fs.writeFileSync(path.join(root, "allowed.txt"), githubToken("o"));
  git(root, "add", ".");
  git(root, "commit", "-m", "archive fixture");
  git(root, "tag", "-a", "v0.0.0", "-m", "archive fixture");
  const violations = scanArchive(root, "v0.0.0");
  assert(violations.some((item) => item.kind === "secret" && item.locationKind === "tag-archive"), "tag archive secret must fail");
  assert(!formatFailure(violations).includes(githubToken("o")), "archive failure output must redact secret");
});

withFixture((root) => {
  fs.writeFileSync(path.join(root, "not-allowlisted.txt"), "synthetic\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "archive path fixture");
  git(root, "tag", "-a", "v0.0.0", "-m", "archive path fixture");
  assert(scanArchive(root, "v0.0.0").some((item) => item.kind === "path-not-allowlisted" && item.locationKind === "tag-archive"), "tag archive path must be allowlisted");
});

console.log("public boundary: ok");
