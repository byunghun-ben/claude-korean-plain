#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts", "evaluate.mjs");
const FIXTURES = path.join(ROOT, "fixtures", "claude-response-quality-cases.json");
const module = await import(`file://${SCRIPT}`);
const fixtures = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));

function run(args, options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", ...options });
}

function responseEnvelope(testCase, output, overrides = {}) {
  const matrix = {
    modelRequested: "fixture-model",
    effort: "high",
    caseIds: [testCase.id],
    repetitions: 1,
    ...overrides
  };
  return {
    expectedMatrix: matrix,
    runs: [{
      caseId: testCase.id,
      modelRequested: matrix.modelRequested,
      effort: matrix.effort,
      repetition: 1,
      output
    }]
  };
}

function requiredExpectations(evidence) {
  return [
    "--expect-claude-version", evidence.execution.claudeVersion,
    "--expect-model", evidence.execution.requestedModel,
    "--expect-effort", evidence.execution.effort,
    "--expect-style-name", evidence.execution.styleName,
    "--expect-style-setting-value", evidence.execution.styleSettingValue,
    "--expect-plugin-sha256", evidence.identity.pluginSha256,
    "--expect-style-sha256", evidence.identity.styleSha256,
    "--expect-config-sha256", evidence.identity.configSha256
  ];
}

assert.deepEqual(module.validateFixtures(fixtures), []);
assert.equal(fixtures.cases.length, 10);
assert.match(fixtures.description, /synthetic/i);

const missingFacts = structuredClone(fixtures);
missingFacts.cases[0].requiredFacts = [];
assert(module.validateFixtures(missingFacts).some((error) => error.includes("requiredFacts")));

const duplicateCase = structuredClone(fixtures);
duplicateCase.cases[1].id = duplicateCase.cases[0].id;
assert(module.validateFixtures(duplicateCase).some((error) => error.includes("duplicated")));

const duplicateFact = structuredClone(fixtures);
duplicateFact.cases[0].requiredFacts[1].id = duplicateFact.cases[0].requiredFacts[0].id;
assert(module.validateFixtures(duplicateFact).some((error) => error.includes("duplicated")));

const unknownField = structuredClone(fixtures);
unknownField.cases[0].unexpected = true;
assert(module.validateFixtures(unknownField).some((error) => error.includes("unknown fields")));

const emptyForbidden = structuredClone(fixtures);
emptyForbidden.cases[0].forbiddenFacts = [];
assert(module.validateFixtures(emptyForbidden).some((error) => error.includes("forbiddenFacts")));

const shortPattern = structuredClone(fixtures);
shortPattern.cases[0].requiredFacts[0].patterns = ["A", "수정"];
assert(module.validateFixtures(shortPattern).some((error) => error.includes("shorter than")));

const shortGroupPattern = structuredClone(fixtures);
shortGroupPattern.cases[0].requiredFacts[1].patternGroups[0] = ["정"];
assert(module.validateFixtures(shortGroupPattern).some((error) => error.includes("shorter than")));

const invalidForbiddenPattern = structuredClone(fixtures);
invalidForbiddenPattern.cases[0].forbiddenPatterns = ["("];
assert(module.validateFixtures(invalidForbiddenPattern).some((error) => error.includes("invalid regular expressions")));

const duplicateForbiddenPattern = structuredClone(fixtures);
duplicateForbiddenPattern.cases[0].forbiddenPatterns = ["반나절", "반나절"];
assert(module.validateFixtures(duplicateForbiddenPattern).some((error) => error.includes("forbiddenPatterns")));

const qaCase = fixtures.cases.find((item) => item.id === "qa-gap");
const goodText = "결제 오류는 수정했습니다. 자동 테스트 18개는 통과했습니다. iOS 실제 기기 확인은 아직입니다.";
const goodScore = module.scoreOutput(qaCase, goodText);
assert.equal(goodScore.absolutePass, true);
assert.equal(goodScore.facts.requiredFactRetention, 1);
assert.equal(module.scoreOutput(qaCase, "결제 오류 수정과 자동 테스트 18개는 완료됐고, iOS 실제 기기 확인은 아직입니다.").absolutePass, true);
assert.equal(module.scoreOutput(qaCase, "결제 오류 수정과 자동 테스트 18개는 끝났고, iOS 실제 기기 확인은 아직입니다.").absolutePass, true);

const missingScore = module.scoreOutput(qaCase, "결제 오류를 수정했습니다.");
assert.equal(missingScore.absolutePass, false);
assert.deepEqual(missingScore.facts.missingRequired, ["tests", "device-gap"]);

const forbiddenScore = module.scoreOutput(qaCase, `${goodText} 스토어 승인 완료.`);
assert.equal(forbiddenScore.absolutePass, false);
assert.deepEqual(forbiddenScore.facts.forbiddenMatches, ["스토어 승인 완료"]);

const uncertaintyCase = fixtures.cases.find((item) => item.id === "sample-flag-explanation");
const uncertainText = "sample_flag는 예시 API 응답에서 찾지 못했습니다. 현재는 group metadata의 알림 설정을 사용합니다.";
assert.equal(module.scoreOutput(uncertaintyCase, uncertainText).absolutePass, true);
const strengthened = module.scoreOutput(uncertaintyCase, "sample_flag는 존재하지 않습니다. 현재는 group metadata의 알림 설정을 사용합니다.");
assert.equal(strengthened.absolutePass, false);
assert(strengthened.facts.forbiddenMatches.includes("sample_flag는 존재하지"));
const uncertaintyLost = module.scoreOutput(uncertaintyCase, "sample_flag를 조사했습니다. 현재는 group metadata의 알림 설정을 사용합니다.");
assert.equal(uncertaintyLost.facts.uncertaintyPresent, false);
assert.equal(uncertaintyLost.absolutePass, false);

const kana = module.scoreOutput(qaCase, `${goodText} 次に確認します。`);
assert(kana.kanaChars > 0);
assert.equal(kana.absolutePass, false);
const noKorean = module.scoreOutput(qaCase, "iOS 18 PASS");
assert.equal(noKorean.koreanPresent, false);
assert.equal(noKorean.absolutePass, false);

const inventedCase = fixtures.cases.find((item) => item.id === "no-invented-experience");
const invented = module.scoreOutput(inventedCase, "작은 자동화는 확인 비용을 줄입니다. 저희 팀은 검토 시간을 40퍼센트 줄였고, 반나절 걸리던 작업이 20분으로 끝났습니다.");
assert.equal(invented.absolutePass, false, "invented figures must fail even when no forbidden string matches");
assert.deepEqual(invented.facts.forbiddenMatches, [], "the counterexample must be caught by patterns, not by literal strings");
assert(invented.facts.forbiddenPatternMatches.length > 0);
const grounded = module.scoreOutput(inventedCase, "작은 자동화는 확인 비용을 줄입니다. 사람이 매번 같은 것을 다시 확인하지 않아도 되기 때문입니다.");
assert.equal(grounded.absolutePass, true, "a general statement without invented figures must still pass");

const optionCase = fixtures.cases.find((item) => item.id === "option-comparison");
const unlabeled = module.scoreOutput(optionCase, "이번 주 위험을 줄이는 것이 목표라면 수동 확인이 필요한 쪽을 먼저 적용하는 편이 낫습니다. 자동화된 쪽은 2주 개발이 필요합니다. API 문서도 함께 봅니다.");
assert.equal(unlabeled.absolutePass, false);
assert.deepEqual(unlabeled.facts.missingRequired, ["a", "b"], "an incidental latin letter must not satisfy an option label");
assert.equal(module.scoreOutput(optionCase, "A안은 이번 주에 적용할 수 있지만 수동 확인이 필요합니다. B안은 자동화되지만 2주 개발이 필요합니다. 이번 주 위험을 줄이는 것이 목표라면 A안이 낫습니다.").absolutePass, true);

const retryCase = fixtures.cases.find((item) => item.id === "retry-decision");
assert.equal(module.scoreOutput(retryCase, "알림 재시도는 최대 2회입니다. 중복 발송 위험이 있습니다. 재시도 간격, 예시 데이터, 정말 다양합니다.").absolutePass, false);
assert.equal(module.scoreOutput(retryCase, "알림 재시도는 최대 2회입니다. 중복 발송 위험 때문입니다. 재시도 간격은 예시 데이터를 확인한 뒤 정합니다.").absolutePass, true);

const boundary = module.scoreOutput(optionCase, "Bash와 API를 썼습니다.");
assert.deepEqual(boundary.unnecessaryEnglish.tokens, ["bash"], "allowed terms must not be stripped from inside other words");
assert.equal(boundary.unnecessaryEnglish.count, 1);
assert.equal(module.scoreOutput(uncertaintyCase, "group metadata와 sample_flag를 확인했습니다.").unnecessaryEnglish.count, 0);

const signals = module.scoreOutput(qaCase, `# Result\n- ${goodText}\n  - Extra Detail\n|a|b|`);
assert.equal(signals.structure.headings, 1);
assert.equal(signals.structure.bullets, 2);
assert.equal(signals.structure.nestedBullets, 1);
assert.equal(signals.structure.tableRows, 1);
assert(signals.unnecessaryEnglish.count >= 2);

const report = module.scoreRuns(fixtures, responseEnvelope(qaCase, goodText));
assert.equal(report.summary.complete, true);
assert.equal(report.summary.overallPass, true);
assert.match(module.formatText(report), /PASS qa-gap/);
assert.equal("output" in report.results[0], false, "score report must not retain raw output");

const duplicateRuns = responseEnvelope(qaCase, goodText);
duplicateRuns.runs.push(structuredClone(duplicateRuns.runs[0]));
assert.throws(() => module.scoreRuns(fixtures, duplicateRuns), /duplicated/);

const missingRun = responseEnvelope(qaCase, goodText, { repetitions: 2 });
assert.throws(() => module.scoreRuns(fixtures, missingRun), /matrix is incomplete/);

const unknownRun = responseEnvelope(qaCase, goodText);
unknownRun.runs[0].caseId = "unknown-case";
assert.throws(() => module.scoreRuns(fixtures, unknownRun), /unknown case/);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "korean-evaluator-test-"));
try {
  const validate = run(["validate", "--fixtures", FIXTURES]);
  assert.equal(validate.status, 0, validate.stderr);
  assert.match(validate.stdout, /10 cases/);

  // The exact command documented in docs/EVALUATION.md.
  const documented = spawnSync(process.execPath, [
    "-e",
    'import("./scripts/evaluate.mjs").then((m) => console.log(m.hashDirectory("plugins/korean-plain")))'
  ], { cwd: ROOT, encoding: "utf8" });
  assert.equal(documented.status, 0, documented.stderr);
  assert.match(documented.stdout.trim(), /^[a-f0-9]{64}$/);
  assert(!documented.stdout.includes("Usage:"), "importing the module must not run the CLI");

  const failingResponses = path.join(tempDir, "failing.json");
  fs.writeFileSync(failingResponses, JSON.stringify(responseEnvelope(qaCase, "결제 오류를 수정했습니다.")));
  const requiredPass = run(["score", "--responses", failingResponses, "--fixtures", FIXTURES, "--require-pass"]);
  assert.equal(requiredPass.status, 2, requiredPass.stderr);
  assert.match(requiredPass.stderr, /status must be complete/);

  const blockedOutput = path.join(tempDir, "blocked.json");
  const blocked = run(["run", "--model", "sonnet", "--effort", "high", "--output", blockedOutput]);
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /--allow-model-calls/);
  assert.equal(fs.existsSync(blockedOutput), false);

  assert.throws(() => module.assertEvidencePathSafe(path.join(ROOT, "raw-output.json")), /outside a Git worktree/);
  assert.throws(() => module.assertEvidencePathSafe(path.join(ROOT, "does-not-exist", "nested", "raw-output.json")), /outside a Git worktree/);
  const privateOutput = path.join(tempDir, "nested", "atomic.json");
  module.writePrivateJsonAtomic(privateOutput, { status: "ok" });
  assert.equal(fs.statSync(privateOutput).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(privateOutput, "utf8")), { status: "ok" });

  const pluginDir = path.join(tempDir, "plugin");
  const styleDir = path.join(pluginDir, "output-styles");
  const stylePath = path.join(styleDir, "korean-plain.md");
  fs.mkdirSync(styleDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "plugin.json"), '{"name":"korean-plain"}\n');
  fs.writeFileSync(stylePath, "---\nname: Korean Plain\ndescription: Test style\n---\n\n한국어로 답합니다.\n");

  const fakeClaude = path.join(tempDir, "fake-claude.mjs");
  const fakeLog = path.join(tempDir, "fake-log.json");
  fs.writeFileSync(fakeClaude, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const logPath = process.env.FAKE_LOG;
if (process.argv.includes("--version")) {
  console.log("9.9.9 (Claude Code)");
  process.exit(0);
}
if (process.env.FAKE_MODE === "malformed") {
  console.log("{not-json");
  process.exit(0);
}
if (process.env.FAKE_MODE === "nonzero") process.exit(23);
if (process.env.FAKE_MODE === "planned-check") {
  const planned = JSON.parse(fs.readFileSync(process.env.PLANNED_EVIDENCE, "utf8"));
  if (planned.status !== "planned" || planned.runs.length !== 0) process.exit(24);
  process.exit(23);
}
if (process.env.FAKE_MODE === "timeout") {
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync(process.env.TIMEOUT_MARKER, 'survived'), 1800)"], {
    env: process.env,
    stdio: ["ignore", "inherit", "inherit"]
  });
  child.unref();
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const args = process.argv.slice(2);
const settingsIndex = args.indexOf("--settings");
const settingsPath = args[settingsIndex + 1];
const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
fs.writeFileSync(logPath, JSON.stringify({ args, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, settingsPath, settings }));
console.log(JSON.stringify({ result: ${JSON.stringify(goodText)}, modelUsage: { "fixture-resolved": {} } }));
`, { mode: 0o755 });

  const evidencePath = path.join(tempDir, "model-evidence.json");
  const fakeRun = run([
    "run", "--allow-model-calls", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", evidencePath,
    "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog } });
  assert.equal(fakeRun.status, 0, fakeRun.stderr);
  const evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
  const invocation = JSON.parse(fs.readFileSync(fakeLog, "utf8"));
  assert.equal(evidence.status, "complete");
  assert.equal(evidence.execution.claudeVersion, "9.9.9 (Claude Code)");
  assert.equal(evidence.execution.requestedModel, "fixture-model");
  assert.equal(evidence.execution.effort, "high");
  assert.equal(evidence.execution.styleName, "Korean Plain");
  assert.equal(evidence.execution.styleSettingValue, "korean-plain:Korean Plain");
  assert.equal(evidence.identity.pluginSha256, module.hashDirectory(pluginDir));
  assert.equal(evidence.identity.styleSha256, crypto.createHash("sha256").update(fs.readFileSync(stylePath)).digest("hex"));
  assert.match(evidence.identity.configSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(evidencePath).mode & 0o777, 0o600);
  assert.equal(invocation.settings.outputStyle, "korean-plain:Korean Plain");
  assert.equal(invocation.configDir, process.env.CLAUDE_CONFIG_DIR ?? null, "runner must not replace CLAUDE_CONFIG_DIR or copy authentication");
  const settingsArgument = invocation.args.indexOf("--settings");
  assert(settingsArgument >= 0);
  assert.equal(invocation.args[settingsArgument + 1], invocation.settingsPath);
  const settingSourcesArgument = invocation.args.indexOf("--setting-sources");
  assert(settingSourcesArgument >= 0);
  assert.equal(invocation.args[settingSourcesArgument + 1], "project");
  const pluginArgument = invocation.args.indexOf("--plugin-dir");
  assert(pluginArgument >= 0);
  assert.equal(invocation.args[pluginArgument + 1], fs.realpathSync(pluginDir));
  assert.equal(fs.existsSync(invocation.settingsPath), false, "isolated settings are removed after the run");

  const scoreArgs = ["score", "--responses", evidencePath, "--fixtures", FIXTURES, "--require-pass", ...requiredExpectations(evidence)];
  const scoredEvidence = run(scoreArgs);
  assert.equal(scoredEvidence.status, 0, scoredEvidence.stderr);
  assert(!scoredEvidence.stdout.includes(goodText), "text score report must not emit raw output");
  const missingExpectations = run(["score", "--responses", evidencePath, "--fixtures", FIXTURES, "--require-pass"]);
  assert.equal(missingExpectations.status, 2);
  assert.match(missingExpectations.stderr, /needs explicit expectations/);
  const scoredJson = run([...scoreArgs, "--format", "json"]);
  assert.equal(scoredJson.status, 0, scoredJson.stderr);
  assert(!scoredJson.stdout.includes(goodText), "JSON score report must not emit raw output");
  assert.equal("output" in JSON.parse(scoredJson.stdout).results[0], false);

  for (const [flag, replacement, message] of [
    ["--expect-model", "other-model", /requestedModel/],
    ["--expect-effort", "low", /effort/],
    ["--expect-claude-version", "0.0.0", /claudeVersion/],
    ["--expect-style-name", "Other Style", /styleName/],
    ["--expect-style-setting-value", "other:Other Style", /styleSettingValue/],
    ["--expect-plugin-sha256", "0".repeat(64), /pluginSha256/],
    ["--expect-style-sha256", "1".repeat(64), /styleSha256/],
    ["--expect-config-sha256", "2".repeat(64), /configSha256/]
  ]) {
    const mismatched = [...scoreArgs];
    mismatched[mismatched.indexOf(flag) + 1] = replacement;
    const rejected = run(mismatched);
    assert.equal(rejected.status, 2, `${flag} mismatch must fail closed`);
    assert.match(rejected.stderr, message);
  }

  const staleEvidencePath = path.join(tempDir, "stale-evidence.json");
  fs.writeFileSync(staleEvidencePath, JSON.stringify({ ...evidence, status: "running" }));
  const staleArgs = [...scoreArgs];
  staleArgs[staleArgs.indexOf(evidencePath)] = staleEvidencePath;
  const stale = run(staleArgs);
  assert.equal(stale.status, 2);
  assert.match(stale.stderr, /status must be complete/);

  const completeFailPath = path.join(tempDir, "complete-fail.json");
  const completeFail = structuredClone(evidence);
  completeFail.runs[0].output = "결제 오류를 수정했습니다. RAW_FAILURE_MARKER";
  fs.writeFileSync(completeFailPath, JSON.stringify(completeFail));
  const completeFailArgs = [...scoreArgs];
  completeFailArgs[completeFailArgs.indexOf(evidencePath)] = completeFailPath;
  const completeFailScore = run(completeFailArgs);
  assert.equal(completeFailScore.status, 1, completeFailScore.stderr);
  assert.match(completeFailScore.stdout, /Overall: FAIL/);
  assert(!completeFailScore.stdout.includes("RAW_FAILURE_MARKER"));

  for (const mode of ["malformed", "nonzero"]) {
    const failedPath = path.join(tempDir, `${mode}.json`);
    const failedRun = run([
      "run", "--allow-model-calls", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
      "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", failedPath,
      "--fixtures", FIXTURES
    ], { env: { ...process.env, FAKE_LOG: fakeLog, FAKE_MODE: mode } });
    assert.equal(failedRun.status, 2, `${mode} output must fail closed`);
    assert.match(failedRun.stderr, mode === "malformed" ? /invalid JSON/ : /Claude call failed/);
    assert.equal(JSON.parse(fs.readFileSync(failedPath, "utf8")).status, "failed", `${mode} failure must write terminal evidence`);
  }

  const plannedPath = path.join(tempDir, "planned.json");
  const plannedRun = run([
    "run", "--allow-model-calls", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", plannedPath,
    "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog, FAKE_MODE: "planned-check", PLANNED_EVIDENCE: plannedPath } });
  assert.equal(plannedRun.status, 2);
  assert.match(plannedRun.stderr, /Claude call failed/);
  assert.equal(JSON.parse(fs.readFileSync(plannedPath, "utf8")).status, "failed");

  const timeoutPath = path.join(tempDir, "timeout.json");
  const timeoutMarker = path.join(tempDir, "timeout-descendant-survived");
  const started = Date.now();
  const timeoutRun = run([
    "run", "--allow-model-calls", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", timeoutPath,
    "--timeout", "1", "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog, FAKE_MODE: "timeout", TIMEOUT_MARKER: timeoutMarker }, timeout: 5_000 });
  assert.equal(timeoutRun.status, 2, timeoutRun.stderr);
  assert.match(timeoutRun.stderr, /timed out/);
  assert(Date.now() - started < 4_000, "timeout must return promptly");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
  assert.equal(fs.existsSync(timeoutMarker), false, "timed-out descendants must be killed");
  const timeoutEvidence = JSON.parse(fs.readFileSync(timeoutPath, "utf8"));
  assert.equal(timeoutEvidence.status, "failed");
  assert.match(timeoutEvidence.error.message, /timed out/);

  fs.writeFileSync(fakeLog, "[]");
  const resumeSeed = structuredClone(evidence);
  resumeSeed.status = "failed";
  const resumePath = path.join(tempDir, "resume.json");
  fs.writeFileSync(resumePath, JSON.stringify(resumeSeed));
  const resumed = run([
    "run", "--allow-model-calls", "--resume", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", resumePath,
    "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog } });
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resumePath, "utf8")).status, "complete");
  assert.equal(fs.readFileSync(fakeLog, "utf8"), "[]", "resume must skip validated completed keys");

  const journalResume = structuredClone(resumeSeed);
  journalResume.runs = [];
  fs.writeFileSync(resumePath, JSON.stringify(journalResume));
  fs.writeFileSync(`${resumePath}.runs.jsonl`, `${JSON.stringify(evidence.runs[0])}\n`, { mode: 0o600 });
  const resumedJournal = run([
    "run", "--allow-model-calls", "--resume", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", resumePath,
    "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog } });
  assert.equal(resumedJournal.status, 0, resumedJournal.stderr);
  assert.equal(JSON.parse(fs.readFileSync(resumePath, "utf8")).runs.length, 1);
  assert.equal(fs.existsSync(`${resumePath}.runs.jsonl`), false, "completed resume must remove its raw journal");
  assert.equal(fs.readFileSync(fakeLog, "utf8"), "[]", "resume must recover and skip a journaled completed key");

  const mismatchedResume = structuredClone(resumeSeed);
  mismatchedResume.execution.effort = "low";
  fs.writeFileSync(resumePath, JSON.stringify(mismatchedResume));
  const rejectedResume = run([
    "run", "--allow-model-calls", "--resume", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", resumePath,
    "--fixtures", FIXTURES
  ], { env: { ...process.env, FAKE_LOG: fakeLog } });
  assert.equal(rejectedResume.status, 2);
  assert.match(rejectedResume.stderr, /does not match the requested execution identity/);

  const refusedOutput = path.join(ROOT, "refused-evidence.json");
  const refused = run([
    "run", "--allow-model-calls", "--case", "qa-gap", "--model", "fixture-model", "--effort", "high",
    "--plugin", pluginDir, "--style", stylePath, "--claude", fakeClaude, "--output", refusedOutput
  ], { env: { ...process.env, FAKE_LOG: fakeLog } });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /outside a Git worktree/);
  assert.equal(fs.existsSync(refusedOutput), false);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("All evaluator tests passed.");
