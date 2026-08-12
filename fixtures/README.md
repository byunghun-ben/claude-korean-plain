# Response-quality fixtures

`claude-response-quality-cases.json` contains invented examples for checking Korean response quality. The prompts are synthetic and do not reproduce conversations, product contracts, operational records, or personal information.

Each case declares facts that must remain, claims that must not appear, allowed English terms, and the dimensions a reviewer may score. Cases that contain unknown information also declare acceptable uncertainty language. The deterministic scorer treats a missing fact, forbidden claim, lost uncertainty, missing Korean text, or Japanese kana as a failure.

Validation and scoring do not contact a model or the network:

```sh
node scripts/evaluate.mjs validate
node scripts/evaluate.mjs score --responses /path/to/evidence.json --require-pass
```

`run` is optional and always requires `--allow-model-calls`. Raw evidence must be written outside every Git worktree. Tests substitute a local fake executable and never make a model call.
