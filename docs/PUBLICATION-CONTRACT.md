# Publication Contract

This contract defines the complete public surface of this repository. The
publication check is fail-closed: a path or component that is not explicitly
allowed below must not be published.

## Path allowlist

Only these repository-relative files are allowed:

- `.gitignore`
- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `CONTRIBUTING.md`
- `SECURITY.md`
- `.claude-plugin/marketplace.json`
- `.github/ISSUE_TEMPLATE/bug-report.yml`
- `.github/ISSUE_TEMPLATE/config.yml`
- `.github/workflows/ci.yml`
- `plugins/korean-plain/.claude-plugin/plugin.json`
- `plugins/korean-plain/output-styles/korean-plain.md`
- `fixtures/README.md`
- `fixtures/claude-response-quality-cases.json`
- `scripts/evaluate.mjs`
- `scripts/check-public-boundary.mjs`
- `scripts/release-gate.mjs`
- `tests/plugin-contract.test.mjs`
- `tests/evaluate.test.mjs`
- `tests/install-e2e.mjs`
- `tests/config-picker.exp`
- `tests/fixtures/user-settings.json`
- `tests/fixtures/project-settings.json`
- `tests/fixtures/project-mcp.json`
- `tests/docs-contract.test.mjs`
- `tests/run-all.mjs`
- `tests/public-boundary.test.mjs`
- `tests/release-gate.test.mjs`
- `docs/PROVENANCE.md`
- `docs/PUBLICATION-CONTRACT.md`
- `docs/EVALUATION.md`
- `docs/RELEASE-CHECKLIST.md`
- `docs/releases/v0.1.0.md`

Directories exist only to contain the allowlisted files. Empty placeholders,
nested version-control metadata, generated archives, binaries, and release
assets are not allowed.

## Allowed plugin components

The public plugin contains exactly one output style named `korean-plain` and
the minimum marketplace and plugin manifests needed to distribute it. The
allowlisted evaluation, boundary-check, release-gate, test, documentation, and
continuous-integration files may support that component.

The style sets `force-for-plugin: true`, so it applies while the plugin is
enabled instead of requiring a separate selection.

Hooks, commands, agents, skills, MCP or LSP server configuration, bundled
dependencies, telemetry, and installers are not allowed.

## Prohibited data and sources

The repository must not contain:

- symbolic links of any kind;
- raw model output, conversation transcripts, prompt histories, or temporary
  evaluation evidence;
- real customer, user, account, product-sensitive, or personally identifying
  data;
- credentials, tokens, keys, cookies, environment files, secret-shaped values,
  or private service configuration;
- non-public source artifacts, including files copied from a private
  development harness or another non-public repository;
- non-public infrastructure and operational records;
- editor settings, OS metadata, caches, coverage reports, or local orchestration
  state.

Synthetic fixtures must be written for this project, contain no copied raw
responses, and use obviously fictional identifiers. Evaluation reports may
publish aggregate conclusions, but not the raw evidence used to reach them.
