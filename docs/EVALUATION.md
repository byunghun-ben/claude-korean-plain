# 평가 방법

Korean Plain의 평가는 결정적 gate와 선택적인 모델 실행을 분리합니다. 모델 결과가 좋아 보여도 결정적 gate를 대신할 수 없습니다.

## 결정적 gate

합성 fixture는 보존해야 할 사실, 생성하면 안 되는 사실, 불확실성 표현, 한국어 유지 여부를 선언합니다. 다음 검사는 모델이나 네트워크를 호출하지 않습니다.

```sh
node scripts/evaluate.mjs validate
node tests/evaluate.test.mjs
node scripts/evaluate.mjs score --responses /path/to/responses.json
```

평가기에는 누락·중복 run, 알 수 없는 case, required fact 손실, forbidden fact 생성, 불확실성 손실, 일본어 kana 유출을 거부하는 검사가 있습니다. 구조와 불필요한 영어는 관찰 지표로 남기되 사실 보존의 절대 통과 조건과 섞지 않습니다.

## 선택적인 유료 모델 실행

`run`은 명시적인 `--allow-model-calls` 없이는 모델을 호출하지 않습니다. 실행에는 비용이 들 수 있고, 실제 Claude executable이 필요합니다.

```sh
EVIDENCE_DIR="$(mktemp -d)"
node scripts/evaluate.mjs run \
  --allow-model-calls \
  --model sonnet \
  --effort high \
  --case qa-gap \
  --plugin plugins/korean-plain \
  --style plugins/korean-plain/output-styles/korean-plain.md \
  --output "$EVIDENCE_DIR/responses.json"
PLUGIN_SHA="$(node -e 'import("./scripts/evaluate.mjs").then(m => console.log(m.hashDirectory("plugins/korean-plain")))')"
STYLE_SHA="$(shasum -a 256 plugins/korean-plain/output-styles/korean-plain.md | awk '{print $1}')"
CONFIG_SHA="$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(JSON.stringify({outputStyle:"korean-plain:Korean Plain"},null,2)+"\n").digest("hex"))')"
node scripts/evaluate.mjs score \
  --responses "$EVIDENCE_DIR/responses.json" \
  --require-pass \
  --expect-claude-version "2.1.223 (Claude Code)" \
  --expect-model sonnet \
  --expect-effort high \
  --expect-style-name "Korean Plain" \
  --expect-style-setting-value "korean-plain:Korean Plain" \
  --expect-plugin-sha256 "$PLUGIN_SHA" \
  --expect-style-sha256 "$STYLE_SHA" \
  --expect-config-sha256 "$CONFIG_SHA"
```

case ID는 fixture의 현재 값을 사용해야 합니다. 원시 model output은 Git worktree 밖의 임시 경로에만 mode `0600`으로 기록되며 공개하거나 commit하지 않습니다. 실행 증거에는 Claude Code version, 요청 model과 effort, style 이름과 SHA-256, plugin identity가 포함됩니다.

## 공개 가능한 결과

문서에는 실행 환경과 정제한 집계만 남깁니다. 예를 들면 실행 수, required fact 보존율, forbidden fact 검출 수, 불확실성 보존 여부, 전체 통과 여부입니다. prompt, 원시 응답, 전체 transcript, 인증 정보, 개인 정보는 공개하지 않습니다.

Claude Code 2.1.223에서 검증한 결과만 release gate에 사용합니다. 모델 결과는 시점에 따라 달라질 수 있으므로 재현 가능한 결정적 검사와 별도로 해석합니다.

## v0.1.0 공개 전 대표 모델 결과

2026-08-12에 `qa-gap` 합성 case를 각 조합으로 한 번 실행했습니다. 두 실행 모두 Claude Code `2.1.223 (Claude Code)`, style `Korean Plain`, style SHA-256 `2a811c2cdba566e531d66272edf6a4d0e7d6d25859312c2c6163ec2d87682759`를 사용했습니다.

| 요청 model | effort | 실행 | required fact | forbidden fact | 불확실성 | 한국어·kana | 결과 |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| Sonnet | high | 1 | 100% | 0건 | 보존 | 한국어 있음·kana 0자 | PASS |
| Opus | xhigh | 1 | 100% | 0건 | 보존 | 한국어 있음·kana 0자 | PASS |

이전 실행은 `/config`가 저장하는 qualified 값(`korean-plain:Korean Plain`)을 평가 설정에 사용하지 않아 최종 release gate 증거로 인정하지 않습니다. v0.1.0 최종 후보에서는 위 값을 적용해 Sonnet/high와 Opus/xhigh를 다시 실행하고, HEAD와 세 SHA-256에 결합한 외부 mode `0600` attestation이 둘 모두의 통과를 증명해야 합니다. 이 표는 정제한 집계이며 prompt와 원시 응답은 포함하지 않습니다.
