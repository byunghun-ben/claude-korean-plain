import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCUMENTS = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "docs/EVALUATION.md",
  "docs/RELEASE-CHECKLIST.md",
  "docs/releases/v0.1.0.md",
  ".github/ISSUE_TEMPLATE/bug-report.yml",
  ".github/ISSUE_TEMPLATE/config.yml",
];

function text(root, relativePath) {
  return readFileSync(join(root, relativePath), "utf8");
}

function includesAll(source, values, label) {
  for (const value of values) assert(source.includes(value), `${label} must include: ${value}`);
}

function validate(root) {
  const readme = text(root, "README.md");
  includesAll(readme, [
    "claude plugin marketplace add https://github.com/byunghun-ben/claude-korean-plain.git --scope user",
    "claude plugin install korean-plain@claude-korean-plain --scope user",
    "claude plugin marketplace add https://github.com/byunghun-ben/claude-korean-plain.git --scope project",
    "claude plugin install korean-plain@claude-korean-plain --scope project",
    "/config",
    "/clear",
    "새 세션",
    "Default",
    "claude plugin disable",
    "claude plugin uninstall",
    "claude plugin marketplace remove",
    "enabledPlugins",
    "outputStyle",
    "force-for-plugin: true",
    "claude plugin disable korean-plain@claude-korean-plain --scope user",
    "subagent",
    "fork",
    "system prompt",
    "global `CLAUDE.md`",
    "permissions",
    "hooks",
    "MCP",
    "무조건 짧게",
    "영어로 질문해도 한국어 답이 옵니다",
    "keep-coding-instructions",
    "Claude Code 2.1.223에서 검증",
    "MIT License",
    "사실 보존",
    "번역투 완화",
    "불필요한 영어 제거",
    "절제된 구조",
  ], "README");
  assert.match(readme, /user 설정\(`~\/\.claude\/settings\.json`\)/);
  assert.match(readme, /project 설정\(`\.claude\/settings\.json`\)/);
  assert.match(readme, /일반 subagent에는 적용되지 않습니다/);
  assert.match(readme, /`\/config`에서 따로 고를 필요가 없습니다/);
  assert.match(readme, /끄는 방법은 플러그인을 비활성화하는 것입니다/);
  assert.match(readme, /fork한 agent는 부모 system prompt를 상속합니다/);

  const evaluation = text(root, "docs/EVALUATION.md");
  includesAll(evaluation, ["결정적 gate", "결정적 gate가 덮지 않는 범위", "opt-in 증명", "선택적인 유료 모델 실행", "--allow-model-calls", "정제한 집계", "mode `0600`", "Claude Code 2.1.223에서 검증"], "EVALUATION");
  assert.match(evaluation, /모델이나 네트워크를 호출하지 않습니다/);
  assert.match(evaluation, /원시 (?:model output|응답).*공개하거나 commit하지 않습니다/s);

  const contributing = text(root, "CONTRIBUTING.md");
  includesAll(contributing, ["재현 fixture를 먼저 추가", "결정적 검사", "secret", "원시 대화 transcript"], "CONTRIBUTING");

  const issue = text(root, ".github/ISSUE_TEMPLATE/bug-report.yml");
  includesAll(issue, ["claude-version", "model", "regression-type", "reproduction-input", "expected", "actual", "번역투", "사실 왜곡", "과잉 구조", "지나친 축약", "Secret", "원시 대화 transcript"], "issue template");

  const release = text(root, "docs/RELEASE-CHECKLIST.md");
  includesAll(release, ["claude plugin validate --strict", "user scope", "project scope", "전체 Git history", "public clone", "cache", "완전히 회수할 수 없습니다", "Community Marketplace", "v0.1.0 완료 범위에 포함하지 않습니다"], "release checklist");

  const changelogAndNote = `${text(root, "CHANGELOG.md")}\n${text(root, "docs/releases/v0.1.0.md")}`;
  includesAll(changelogAndNote, ["0.1.0", "output style", "별도의 업로드 release asset"], "release documents");
  assert.match(text(root, "SECURITY.md"), /공개 issue.*secret/s);

  const publicDocs = DOCUMENTS.map((file) => text(root, file)).join("\n");
  const forbidden = [
    /settings\.json을 (?:전혀 |절대 )?(?:수정하지|바꾸지)/,
    /최소 지원 버전/,
    /설치 자체가 output style을 선택하지는 않습니다/,
  ];
  for (const pattern of forbidden) assert.doesNotMatch(publicDocs, pattern, `public documentation contains a forbidden claim: ${pattern}`);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "korean-plain-docs-"));
  for (const relativePath of DOCUMENTS) cpSync(join(ROOT, relativePath), join(root, relativePath), { recursive: true });
  return root;
}

function negativeCase(name, mutate, expected) {
  const root = fixture();
  try {
    mutate(root);
    assert.throws(() => validate(root), expected, `${name} must fail closed`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

validate(ROOT);

negativeCase("missing required install command", (root) => {
  const path = join(root, "README.md");
  writeFileSync(path, text(root, "README.md").replaceAll("claude plugin install korean-plain@claude-korean-plain", "claude plugin install korean-plain"));
}, /must include/);

negativeCase("misleading settings claim", (root) => {
  const path = join(root, "README.md");
  writeFileSync(path, `${text(root, "README.md")}\nsettings.json을 전혀 수정하지 않습니다.\n`);
}, /forbidden claim/);

negativeCase("unsupported minimum-version claim", (root) => {
  const path = join(root, "README.md");
  writeFileSync(path, `${text(root, "README.md")}\n최소 지원 버전은 2.1.0입니다.\n`);
}, /forbidden claim/);

console.log("docs contract: ok");
