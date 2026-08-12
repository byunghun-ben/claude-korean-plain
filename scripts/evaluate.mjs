#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FIXTURES = path.join(ROOT, "fixtures", "claude-response-quality-cases.json");
const STYLE_NAME = "Korean Plain";
const STYLE_SETTING_VALUE = `korean-plain:${STYLE_NAME}`;
const KNOWN_DIMENSIONS = new Set([
  "natural_korean",
  "reader_first_structure",
  "terminology_clarity",
  "formatting_restraint",
  "factual_clarity"
]);
const GLOBAL_ALLOWED_ENGLISH = new Set(["api", "ci", "ios", "sha", "json"]);
const CASE_KEYS = new Set([
  "id", "category", "prompt", "requiredFacts", "forbiddenFacts", "forbiddenPatterns", "allowedEnglish",
  "mustExpressUncertainty", "uncertaintyPatterns", "rubricDimensions"
]);
const FACT_KEYS = new Set(["id", "patterns", "patternGroups"]);
// A one-character pattern matches incidental letters and syllables, so a fact
// built from one would pass on responses that never state it.
const MINIMUM_PATTERN_LENGTH = 2;

function usage(exitCode = 0) {
  const message = `Usage:
  evaluate.mjs validate [--fixtures PATH]
  evaluate.mjs score --responses PATH [--ratings PATH] [--fixtures PATH] [--format text|json] [--require-pass]
  evaluate.mjs run --allow-model-calls --model NAME --effort LEVEL --plugin DIR --style PATH [--output PATH] [options]

Required-pass expectations:
  --expect-claude-version VERSION  --expect-model NAME  --expect-effort LEVEL
  --expect-style-name NAME         --expect-style-setting-value VALUE
  --expect-plugin-sha256 SHA256
  --expect-style-sha256 SHA256     --expect-config-sha256 SHA256

Run options:
  --case ID             Run one case (repeatable; default: all cases)
  --claude PATH         Claude executable (default: claude)
  --repetitions N       Runs per case (default: 1)
  --timeout SEC         Per-call timeout (default: 180)

Model calls never run without --allow-model-calls.`;
  (exitCode ? console.error : console.log)(message);
  process.exit(exitCode);
}

export function parseArgs(argv) {
  const parsed = { _: [], case: [] };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      parsed._.push(argument);
      continue;
    }
    const key = argument.slice(2);
    if (key === "allow-model-calls" || key === "require-pass" || key === "resume") {
      parsed[key === "allow-model-calls" ? "allowModelCalls" : key === "require-pass" ? "requirePass" : "resume"] = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    if (key === "case") parsed.case.push(value);
    else parsed[key] = value;
  }
  return parsed;
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function unknownKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).filter((key) => !allowed.has(key));
}

function nonEmptyStrings(value) {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.length > 0);
}

function shortPatterns(fact) {
  const groups = fact?.patternGroups ?? (fact?.patterns ? [fact.patterns] : []);
  if (!Array.isArray(groups)) return [];
  return groups.flat().filter((pattern) => typeof pattern === "string" && pattern.trim().length < MINIMUM_PATTERN_LENGTH);
}

function invalidRegExpSources(sources) {
  return sources.filter((source) => {
    try {
      new RegExp(source, "i");
      return false;
    } catch {
      return true;
    }
  });
}

export function validateFixtures(data) {
  const errors = [];
  if (!data || data.version !== 1) errors.push("version must be 1");
  if (typeof data?.description !== "string" || !data.description.toLowerCase().includes("synthetic")) {
    errors.push("description must declare synthetic provenance");
  }
  const dimensions = data?.rubric?.dimensions;
  if (!Array.isArray(dimensions) || dimensions.length !== KNOWN_DIMENSIONS.size ||
      new Set(dimensions).size !== KNOWN_DIMENSIONS.size || dimensions.some((item) => !KNOWN_DIMENSIONS.has(item))) {
    errors.push(`rubric.dimensions must contain exactly: ${[...KNOWN_DIMENSIONS].join(", ")}`);
  }
  if (!Array.isArray(data?.cases) || data.cases.length < 10) errors.push("at least 10 cases are required");
  const caseIds = new Set();
  for (const [caseIndex, testCase] of (data?.cases || []).entries()) {
    const at = `cases[${caseIndex}]`;
    const extras = unknownKeys(testCase, CASE_KEYS);
    if (extras.length) errors.push(`${at} has unknown fields: ${extras.join(", ")}`);
    if (typeof testCase?.id !== "string" || !testCase.id) errors.push(`${at}.id is required`);
    else if (caseIds.has(testCase.id)) errors.push(`${at}.id is duplicated`);
    else caseIds.add(testCase.id);
    if (typeof testCase?.category !== "string" || !testCase.category) errors.push(`${at}.category is required`);
    if (typeof testCase?.prompt !== "string" || !testCase.prompt) errors.push(`${at}.prompt is required`);
    if (!Array.isArray(testCase?.requiredFacts) || testCase.requiredFacts.length === 0) {
      errors.push(`${at}.requiredFacts must be a non-empty array`);
    }
    const factIds = new Set();
    for (const [factIndex, fact] of (testCase?.requiredFacts || []).entries()) {
      const factAt = `${at}.requiredFacts[${factIndex}]`;
      const factExtras = unknownKeys(fact, FACT_KEYS);
      if (factExtras.length) errors.push(`${factAt} has unknown fields: ${factExtras.join(", ")}`);
      if (typeof fact?.id !== "string" || !fact.id) errors.push(`${factAt}.id is required`);
      else if (factIds.has(fact.id)) errors.push(`${factAt}.id is duplicated`);
      else factIds.add(fact.id);
      const hasPatterns = nonEmptyStrings(fact?.patterns);
      const hasGroups = Array.isArray(fact?.patternGroups) && fact.patternGroups.length > 0 &&
        fact.patternGroups.every(nonEmptyStrings);
      if (hasPatterns === hasGroups) errors.push(`${factAt} must have exactly one of patterns or patternGroups`);
      const short = shortPatterns(fact);
      if (short.length) {
        errors.push(`${factAt} has patterns shorter than ${MINIMUM_PATTERN_LENGTH} characters: ${short.join(", ")}`);
      }
    }
    if (!nonEmptyStrings(testCase?.forbiddenFacts)) errors.push(`${at}.forbiddenFacts must contain non-empty strings`);
    if (testCase?.forbiddenPatterns !== undefined) {
      if (!nonEmptyStrings(testCase.forbiddenPatterns) ||
          new Set(testCase.forbiddenPatterns).size !== testCase.forbiddenPatterns.length) {
        errors.push(`${at}.forbiddenPatterns must contain unique non-empty strings`);
      } else {
        const invalid = invalidRegExpSources(testCase.forbiddenPatterns);
        if (invalid.length) errors.push(`${at}.forbiddenPatterns has invalid regular expressions: ${invalid.join(", ")}`);
      }
    }
    if (!Array.isArray(testCase?.allowedEnglish) || testCase.allowedEnglish.some((item) => typeof item !== "string" || !item)) {
      errors.push(`${at}.allowedEnglish must contain only non-empty strings`);
    }
    if (typeof testCase?.mustExpressUncertainty !== "boolean") errors.push(`${at}.mustExpressUncertainty must be boolean`);
    if (!Array.isArray(testCase?.uncertaintyPatterns) || testCase.uncertaintyPatterns.some((item) => typeof item !== "string" || !item) ||
        (testCase?.mustExpressUncertainty && testCase.uncertaintyPatterns.length === 0)) {
      errors.push(`${at}.uncertaintyPatterns is invalid`);
    }
    if (!Array.isArray(testCase?.rubricDimensions) || testCase.rubricDimensions.length === 0 ||
        new Set(testCase.rubricDimensions).size !== testCase.rubricDimensions.length ||
        testCase.rubricDimensions.some((item) => !KNOWN_DIMENSIONS.has(item))) {
      errors.push(`${at}.rubricDimensions must contain unique known dimensions`);
    } else if (!testCase.rubricDimensions.includes("natural_korean") || !testCase.rubricDimensions.includes("factual_clarity")) {
      errors.push(`${at}.rubricDimensions must include natural_korean and factual_clarity`);
    }
  }
  return errors;
}

function normalize(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase();
}

function factPresent(text, fact) {
  const target = normalize(text);
  if (fact.patternGroups) return fact.patternGroups.every((group) => group.some((pattern) => target.includes(normalize(pattern))));
  return fact.patterns.every((pattern) => target.includes(normalize(pattern)));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTechnicalSpans(text) {
  return text.replace(/`[^`]*`/g, " ").replace(/https?:\/\/\S+/gi, " ");
}

function countUnnecessaryEnglish(text, allowedEnglish) {
  let cleaned = stripTechnicalSpans(text);
  // Without the boundaries an allowed term such as "A" also deletes the "a" in
  // "Bash", leaving fragments that are then counted as unnecessary English.
  for (const term of allowedEnglish) {
    cleaned = cleaned.replace(new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(term)}(?![A-Za-z0-9_-])`, "gi"), " ");
  }
  const tokens = cleaned.match(/[A-Za-z][A-Za-z0-9_-]*/g) || [];
  const unnecessary = tokens.filter((token) => !GLOBAL_ALLOWED_ENGLISH.has(token.toLowerCase()));
  return { count: unnecessary.length, tokens: [...new Set(unnecessary.map((token) => token.toLowerCase()))] };
}

function repeatedSentences(text) {
  const counts = new Map();
  for (const sentence of normalize(text).split(/[.!?。！？\n]+/).map((item) => item.replace(/\s+/g, " ").trim()).filter((item) => item.length >= 12)) {
    counts.set(sentence, (counts.get(sentence) || 0) + 1);
  }
  return [...counts].filter(([, count]) => count > 1).map(([sentence, count]) => ({ sentence, count }));
}

export function scoreOutput(testCase, output) {
  const text = String(output ?? "");
  const required = testCase.requiredFacts.map((fact) => ({ id: fact.id, present: factPresent(text, fact) }));
  const forbiddenMatches = testCase.forbiddenFacts.filter((fact) => normalize(text).includes(normalize(fact)));
  const forbiddenPatternMatches = (testCase.forbiddenPatterns ?? []).filter((source) => new RegExp(source, "i").test(text));
  const lines = text.split(/\r?\n/);
  const koreanChars = (text.match(/[가-힣]/g) || []).length;
  const kanaChars = (text.match(/[\u3040-\u30ff]/g) || []).length;
  const uncertaintyPresent = !testCase.mustExpressUncertainty ||
    testCase.uncertaintyPatterns.some((pattern) => normalize(text).includes(normalize(pattern)));
  const missingRequired = required.filter((fact) => !fact.present).map((fact) => fact.id);
  const repeated = repeatedSentences(text);
  return {
    caseId: testCase.id,
    chars: text.length,
    lines: lines.length,
    koreanChars,
    kanaChars,
    koreanPresent: koreanChars > 0,
    unnecessaryEnglish: countUnnecessaryEnglish(text, testCase.allowedEnglish),
    structure: {
      headings: lines.filter((line) => /^\s*#{1,6}\s+/.test(line)).length,
      bullets: lines.filter((line) => /^\s*(?:[-*+] |\d+\. )/.test(line)).length,
      nestedBullets: lines.filter((line) => /^\s{2,}(?:[-*+] |\d+\. )/.test(line)).length,
      tableRows: lines.filter((line) => /^\s*\|.*\|\s*$/.test(line)).length
    },
    repetition: { duplicateSentenceCount: repeated.length, duplicates: repeated },
    facts: {
      requiredFactRetention: required.length ? (required.length - missingRequired.length) / required.length : 0,
      missingRequired,
      forbiddenMatches,
      forbiddenPatternMatches,
      uncertaintyPresent
    },
    absolutePass: missingRequired.length === 0 && forbiddenMatches.length === 0 && forbiddenPatternMatches.length === 0 &&
      uncertaintyPresent && koreanChars > 0 && kanaChars === 0
  };
}

function runKey(value) {
  return [value.modelRequested, value.effort, value.caseId, value.repetition].join("|");
}

function expectedKeys(matrix, caseMap) {
  if (!matrix || typeof matrix !== "object") throw new Error("responses.expectedMatrix is required");
  if (typeof matrix.modelRequested !== "string" || !matrix.modelRequested || typeof matrix.effort !== "string" || !matrix.effort ||
      !Array.isArray(matrix.caseIds) || matrix.caseIds.length === 0 || new Set(matrix.caseIds).size !== matrix.caseIds.length ||
      !Number.isInteger(matrix.repetitions) || matrix.repetitions < 1) {
    throw new Error("responses.expectedMatrix is invalid");
  }
  const unknown = matrix.caseIds.filter((caseId) => !caseMap.has(caseId));
  if (unknown.length) throw new Error(`responses.expectedMatrix references unknown case: ${unknown.join(", ")}`);
  return matrix.caseIds.flatMap((caseId) => Array.from({ length: matrix.repetitions }, (_, index) =>
    runKey({ ...matrix, caseId, repetition: index + 1 })));
}

export function scoreRuns(fixtures, responses, ratings = null) {
  if (!Array.isArray(responses?.runs)) throw new Error("responses.runs must be an array");
  const caseMap = new Map(fixtures.cases.map((item) => [item.id, item]));
  const expected = expectedKeys(responses.expectedMatrix, caseMap);
  const expectedSet = new Set(expected);
  const actual = new Set();
  for (const [index, run] of responses.runs.entries()) {
    if (!caseMap.has(run.caseId)) throw new Error(`responses.runs[${index}] references unknown case: ${run.caseId}`);
    if (run.modelRequested !== responses.expectedMatrix.modelRequested || run.effort !== responses.expectedMatrix.effort ||
        !Number.isInteger(run.repetition) || run.repetition < 1 || typeof run.output !== "string") {
      throw new Error(`responses.runs[${index}] does not match the expected matrix`);
    }
    const key = runKey(run);
    if (actual.has(key)) throw new Error(`responses.runs[${index}] is duplicated: ${key}`);
    actual.add(key);
  }
  const missing = expected.filter((key) => !actual.has(key));
  const unexpected = [...actual].filter((key) => !expectedSet.has(key));
  if (missing.length || unexpected.length) {
    throw new Error(`response matrix is incomplete or unexpected (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`);
  }

  const ratingMap = new Map();
  if (ratings !== null) {
    if (!Array.isArray(ratings?.ratings)) throw new Error("ratings.ratings must be an array");
    for (const [index, rating] of ratings.ratings.entries()) {
      const key = runKey(rating);
      if (ratingMap.has(key)) throw new Error(`ratings.ratings[${index}] is duplicated: ${key}`);
      ratingMap.set(key, rating);
    }
  }
  const results = responses.runs.map((run) => {
    const testCase = caseMap.get(run.caseId);
    let humanRating = null;
    if (ratings !== null) {
      humanRating = ratingMap.get(runKey(run));
      if (!humanRating) throw new Error(`missing human rating for run: ${runKey(run)}`);
      for (const dimension of testCase.rubricDimensions) {
        const value = humanRating.scores?.[dimension];
        if (!Number.isInteger(value) || value < 1 || value > 5) throw new Error(`rating ${runKey(run)} needs an integer 1-5 for ${dimension}`);
      }
    }
    const runMetadata = {
      caseId: run.caseId,
      modelRequested: run.modelRequested,
      effort: run.effort,
      repetition: run.repetition,
      ...(typeof run.claudeVersion === "string" ? { claudeVersion: run.claudeVersion } : {}),
      ...(Array.isArray(run.resolvedModels) ? { resolvedModels: run.resolvedModels } : {})
    };
    return { ...runMetadata, score: scoreOutput(testCase, run.output), ...(humanRating ? { humanRating } : {}) };
  });
  const passing = results.filter((item) => item.score.absolutePass).length;
  return {
    version: 1,
    summary: {
      total: results.length,
      absolutePass: passing,
      absoluteFail: results.length - passing,
      passRate: results.length ? passing / results.length : 0,
      complete: true,
      overallPass: passing === results.length
    },
    results
  };
}

export function formatText(report) {
  const lines = [
    "Korean response quality evaluation",
    `Runs: ${report.summary.total}, pass: ${report.summary.absolutePass}, fail: ${report.summary.absoluteFail}`,
    `Overall: ${report.summary.overallPass ? "PASS" : "FAIL"}`
  ];
  for (const result of report.results) {
    const score = result.score;
    lines.push(`${score.absolutePass ? "PASS" : "FAIL"} ${result.caseId} — ${Math.round(score.facts.requiredFactRetention * 100)}% facts, ${score.kanaChars} kana, ${score.unnecessaryEnglish.count} unnecessary English`);
  }
  return `${lines.join("\n")}\n`;
}

function sha256Bytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

export function hashDirectory(directory) {
  const root = path.resolve(directory);
  if (!fs.statSync(root).isDirectory()) throw new Error("--plugin must name a directory");
  const records = [];
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("plugin directory must not contain symbolic links");
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) records.push(`${relative}\0${sha256File(absolute)}\n`);
      else throw new Error("plugin directory contains an unsupported entry");
    }
  };
  visit(root);
  if (records.length === 0) throw new Error("plugin directory is empty");
  return sha256Bytes(records.join(""));
}

function styleName(stylePath) {
  const source = fs.readFileSync(stylePath, "utf8");
  const match = source.match(/^---\s*\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$[\s\S]*?^---\s*$/m);
  return match?.[1]?.trim() || null;
}

function canonicalProspectivePath(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalBase = fs.realpathSync(existing);
  return path.join(canonicalBase, ...suffix);
}

export function assertEvidencePathSafe(outputPath) {
  const requested = path.resolve(outputPath);
  if (fs.existsSync(requested) && fs.lstatSync(requested).isSymbolicLink()) throw new Error("refusing a symbolic-link evidence path");
  const resolved = canonicalProspectivePath(requested);
  let probe = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (fs.statSync(probe).isFile()) probe = path.dirname(probe);
  const git = spawnSync("git", ["-C", probe, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 10000 });
  if (git.status !== 0) return resolved;
  const root = fs.realpathSync(git.stdout.trim());
  const relative = path.relative(root, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) throw new Error("raw model evidence must be written outside a Git worktree");
  return resolved;
}

export function writePrivateJsonAtomic(outputPath, payload) {
  const initiallyResolved = assertEvidencePathSafe(outputPath);
  const directory = path.dirname(initiallyResolved);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const resolved = assertEvidencePathSafe(outputPath);
  if (resolved !== initiallyResolved) throw new Error("evidence path changed while its directory was created");
  const temporary = path.join(directory, `.${path.basename(resolved)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, resolved);
    fs.chmodSync(resolved, 0o600);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
  }
}

function getClaudeVersion(executable, env) {
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 10000, env });
  if (result.status !== 0) throw new Error("Claude version check failed");
  return result.stdout.trim();
}

function extractClaudeResult(stdout) {
  try {
    const envelope = JSON.parse(stdout);
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || typeof envelope.result !== "string") {
      throw new Error("Claude response JSON does not contain a string result");
    }
    return {
      output: envelope.result,
      resolvedModels: envelope.modelUsage && typeof envelope.modelUsage === "object" ? Object.keys(envelope.modelUsage) : []
    };
  } catch (error) {
    throw new Error(`Claude returned invalid JSON: ${error.message}`);
  }
}

function spawnHard(executable, arguments_, options) {
  return new Promise((resolve) => {
    const child = spawn(executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let error = null;
    let timedOut = false;
    let overflow = false;
    const killTree = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch (killError) {
        if (killError.code !== "ESRCH") error ||= killError;
      }
    };
    const collect = (stream, chunk) => {
      sizes[stream] += chunk.length;
      if (sizes[stream] > options.maxBuffer) {
        overflow = true;
        killTree();
        return;
      }
      chunks[stream].push(chunk);
    };
    child.stdout.on("data", (chunk) => collect("stdout", chunk));
    child.stderr.on("data", (chunk) => collect("stderr", chunk));
    child.on("error", (spawnError) => { error = spawnError; });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeout);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal,
        error: error || (timedOut ? Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) :
          overflow ? Object.assign(new Error("maxBuffer exceeded"), { code: "ENOBUFS" }) : null),
        stdout: Buffer.concat(chunks.stdout).toString(options.encoding),
        stderr: Buffer.concat(chunks.stderr).toString(options.encoding)
      });
    });
  });
}

const REQUIRED_EXPECTATIONS = [
  ["expect-claude-version", "claudeVersion", "execution"],
  ["expect-model", "requestedModel", "execution"],
  ["expect-effort", "effort", "execution"],
  ["expect-style-name", "styleName", "execution"],
  ["expect-style-setting-value", "styleSettingValue", "execution"],
  ["expect-plugin-sha256", "pluginSha256", "identity"],
  ["expect-style-sha256", "styleSha256", "identity"],
  ["expect-config-sha256", "configSha256", "identity"]
];

export function validateRequiredEvidence(responses, args) {
  if (responses?.status !== "complete") throw new Error("responses.status must be complete");
  const missing = REQUIRED_EXPECTATIONS.map(([flag]) => flag).filter((flag) => typeof args[flag] !== "string" || !args[flag]);
  if (missing.length) throw new Error(`--require-pass needs explicit expectations: ${missing.map((flag) => `--${flag}`).join(", ")}`);
  for (const flag of ["expect-plugin-sha256", "expect-style-sha256", "expect-config-sha256"]) {
    if (!/^[a-f0-9]{64}$/.test(args[flag])) throw new Error(`--${flag} must be a lowercase SHA-256`);
  }
  const expectedExecutionKeys = REQUIRED_EXPECTATIONS.filter(([, , section]) => section === "execution").map(([, field]) => field).sort();
  const expectedIdentityKeys = REQUIRED_EXPECTATIONS.filter(([, , section]) => section === "identity").map(([, field]) => field).sort();
  if (!responses.execution || !sameJson(Object.keys(responses.execution).sort(), expectedExecutionKeys)) {
    throw new Error("responses.execution must contain exactly the required identity fields");
  }
  if (!responses.identity || !sameJson(Object.keys(responses.identity).sort(), expectedIdentityKeys)) {
    throw new Error("responses.identity must contain exactly the required identity fields");
  }
  for (const [flag, field, section] of REQUIRED_EXPECTATIONS) {
    if (responses?.[section]?.[field] !== args[flag]) {
      throw new Error(`responses.${section}.${field} does not match --${flag}`);
    }
  }
  if (responses.expectedMatrix?.modelRequested !== args["expect-model"] ||
      responses.expectedMatrix?.effort !== args["expect-effort"]) {
    throw new Error("responses.expectedMatrix does not match the expected model and effort");
  }
  for (const [index, run] of (responses.runs || []).entries()) {
    if (run.claudeVersion !== args["expect-claude-version"]) {
      throw new Error(`responses.runs[${index}].claudeVersion does not match --expect-claude-version`);
    }
  }
}

function defaultOutputPath() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "korean-plain-evidence-"));
  fs.chmodSync(directory, 0o700);
  return path.join(directory, "responses.json");
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateResumeEvidence(previous, expectedMatrix, execution, identity) {
  if (!previous || !["planned", "running", "failed"].includes(previous.status)) {
    throw new Error("--resume requires planned, running, or failed evidence");
  }
  if (!sameJson(previous.expectedMatrix, expectedMatrix) || !sameJson(previous.execution, execution) || !sameJson(previous.identity, identity)) {
    throw new Error("--resume evidence does not match the requested execution identity");
  }
  if (!Array.isArray(previous.runs)) throw new Error("--resume evidence runs must be an array");
  const allowed = new Set(expectedMatrix.caseIds.flatMap((caseId) => Array.from({ length: expectedMatrix.repetitions }, (_, index) =>
    runKey({ modelRequested: expectedMatrix.modelRequested, effort: expectedMatrix.effort, caseId, repetition: index + 1 }))));
  const seen = new Set();
  for (const [index, run] of previous.runs.entries()) {
    const key = runKey(run);
    if (!allowed.has(key) || seen.has(key) || run.claudeVersion !== execution.claudeVersion ||
        typeof run.output !== "string" || !Array.isArray(run.resolvedModels)) {
      throw new Error(`--resume evidence has an invalid completed run at index ${index}`);
    }
    seen.add(key);
  }
  return seen;
}

function readRunJournal(journalPath) {
  if (!fs.existsSync(journalPath)) return [];
  const source = fs.readFileSync(journalPath, "utf8");
  const lines = source.split("\n").filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`--resume journal line ${index + 1} is not valid JSON: ${error.message}`);
    }
  });
}

async function runModel(fixtures, args) {
  if (!args.allowModelCalls) throw new Error("model calls require --allow-model-calls");
  if (!args.model || !args.effort) throw new Error("--model and --effort are required");
  if (!args.plugin || !args.style) throw new Error("--plugin and --style are required");
  const repetitions = Number(args.repetitions || 1);
  const timeoutSeconds = Number(args.timeout || 180);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) throw new Error("--repetitions must be an integer from 1 to 10");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error("--timeout must be an integer from 1 to 3600 seconds");
  const pluginPath = fs.realpathSync(path.resolve(args.plugin));
  const stylePath = fs.realpathSync(path.resolve(args.style));
  const styleRelative = path.relative(pluginPath, stylePath);
  if (styleRelative.startsWith("..") || path.isAbsolute(styleRelative)) throw new Error("--style must be inside --plugin");
  const selectedStyleName = styleName(stylePath);
  if (selectedStyleName !== STYLE_NAME) throw new Error(`style name must be ${STYLE_NAME}`);
  const requestedCases = new Set(args.case);
  const unknownCases = [...requestedCases].filter((caseId) => !fixtures.cases.some((item) => item.id === caseId));
  if (unknownCases.length) throw new Error(`unknown fixture cases: ${unknownCases.join(", ")}`);
  const selected = args.case.length ? fixtures.cases.filter((item) => requestedCases.has(item.id)) : fixtures.cases;
  const outputPath = assertEvidencePathSafe(args.output || defaultOutputPath());
  if (args.resume && !args.output) throw new Error("--resume requires --output");
  const executable = args.claude || "claude";
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), "korean-plain-run-"));
  const projectDir = path.join(sandboxRoot, "project");
  fs.mkdirSync(projectDir, { mode: 0o700 });
  const settingsPath = path.join(sandboxRoot, "settings.json");
  fs.writeFileSync(settingsPath, `${JSON.stringify({ outputStyle: STYLE_SETTING_VALUE }, null, 2)}\n`, { mode: 0o600 });
  const identity = {
    pluginSha256: hashDirectory(pluginPath),
    styleSha256: sha256File(stylePath),
    configSha256: sha256File(settingsPath)
  };
  // Authentication remains owned by the caller's normal Claude installation.
  // Settings are narrowed independently: the temporary project has no project
  // settings, and this explicit file contains only the selected output style.
  const env = { ...process.env };
  const claudeVersion = getClaudeVersion(executable, env);
  const expectedMatrix = {
    modelRequested: args.model,
    effort: args.effort,
    caseIds: selected.map((item) => item.id),
    repetitions
  };
  const execution = {
    claudeVersion,
    requestedModel: args.model,
    effort: args.effort,
    styleName: selectedStyleName,
    styleSettingValue: STYLE_SETTING_VALUE
  };
  const journalPath = `${outputPath}.runs.jsonl`;
  const previous = args.resume ? readJson(outputPath, "resume evidence") : null;
  const runs = previous ? structuredClone(previous.runs) : [];
  let completed = previous ? validateResumeEvidence(previous, expectedMatrix, execution, identity) : new Set();
  if (args.resume) {
    for (const run of readRunJournal(journalPath)) {
      const key = runKey(run);
      if (completed.has(key)) {
        const existing = runs.find((item) => runKey(item) === key);
        if (!sameJson(existing, run)) throw new Error(`--resume journal conflicts with completed run: ${key}`);
        continue;
      }
      runs.push(run);
    }
    completed = validateResumeEvidence({ ...previous, runs }, expectedMatrix, execution, identity);
  } else if (fs.existsSync(journalPath)) {
    fs.rmSync(journalPath, { force: true });
  }
  const checkpoint = (status, extra = {}) => writePrivateJsonAtomic(outputPath, {
    version: 1,
    status,
    expectedMatrix,
    execution,
    identity,
    runs,
    ...extra
  });
  const appendRun = (run) => {
    fs.appendFileSync(journalPath, `${JSON.stringify(run)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(journalPath, 0o600);
  };
  try {
    checkpoint(runs.length ? "running" : "planned");
    for (const testCase of selected) {
      for (let repetition = 1; repetition <= repetitions; repetition++) {
        const key = runKey({ modelRequested: args.model, effort: args.effort, caseId: testCase.id, repetition });
        if (completed.has(key)) continue;
        const prompt = `응답 품질 평가입니다. 도구나 외부 정보를 사용하지 말고, 주어진 사실만으로 한국어 답변을 작성하세요.\n\n${testCase.prompt}`;
        const claudeArgs = [
          "-p", "--max-turns", "1", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
          "--disable-slash-commands", "--output-format", "json", "--model", args.model, "--effort", args.effort,
          "--settings", settingsPath, "--setting-sources", "project", "--plugin-dir", pluginPath, prompt
        ];
        const result = await spawnHard(executable, claudeArgs, {
          cwd: projectDir,
          env,
          encoding: "utf8",
          timeout: timeoutSeconds * 1000,
          maxBuffer: 10 * 1024 * 1024
        });
        if (result.error?.code === "ETIMEDOUT") throw new Error(`Claude call timed out for case ${testCase.id}`);
        if (result.error || result.status !== 0) throw new Error(`Claude call failed for case ${testCase.id}`);
        const parsed = extractClaudeResult(result.stdout);
        const run = {
          caseId: testCase.id,
          modelRequested: args.model,
          effort: args.effort,
          repetition,
          claudeVersion,
          resolvedModels: parsed.resolvedModels,
          output: parsed.output
        };
        appendRun(run);
        runs.push(run);
        completed.add(key);
      }
    }
    checkpoint("complete");
    if (fs.existsSync(journalPath)) fs.rmSync(journalPath, { force: true });
  } catch (error) {
    checkpoint("failed", { error: { message: error.message } });
    throw error;
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
  return { outputPath, runs };
}

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0];
    if (!command || command === "help") usage();
    const fixtures = readJson(path.resolve(args.fixtures || DEFAULT_FIXTURES), "fixtures");
    const errors = validateFixtures(fixtures);
    if (errors.length) throw new Error(`fixture validation failed:\n- ${errors.join("\n- ")}`);
    if (command === "validate") {
      console.log(`Fixture validation passed: ${fixtures.cases.length} cases`);
      return;
    }
    if (command === "score") {
      if (!args.responses) throw new Error("--responses is required");
      const responses = readJson(path.resolve(args.responses), "responses");
      const ratings = args.ratings ? readJson(path.resolve(args.ratings), "ratings") : null;
      if (args.requirePass) validateRequiredEvidence(responses, args);
      const report = scoreRuns(fixtures, responses, ratings);
      console.log(args.format === "json" ? JSON.stringify(report, null, 2) : formatText(report));
      if (args.requirePass && !report.summary.overallPass) process.exitCode = 1;
      return;
    }
    if (command === "run") {
      const result = await runModel(fixtures, args);
      console.log(`Wrote ${result.runs.length} model runs to ${result.outputPath}`);
      return;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exitCode = 2;
  }
}

// process.argv[1] is absent under `node -e`, where this module is imported for
// its exports rather than run as the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
