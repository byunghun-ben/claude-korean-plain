# Changelog

이 문서는 사용자에게 보이는 변경을 기록합니다.

## 0.2.0

- 플러그인이 켜져 있는 동안 `Korean Plain`이 자동으로 적용됩니다. 설치 후 `/config`에서 따로 고르지 않아도 됩니다. style이 `force-for-plugin: true`를 사용하므로 `/config`에서 고른 output style보다 우선합니다.
- 끄는 방법은 `claude plugin disable`입니다. 플러그인을 끄면 `/config`에 남아 있던 값이 다시 적용됩니다.
- `Korean Plain` 스타일 본문에서 호응이 맞지 않는 문장을 고쳤습니다.
- 불확실성을 밝히라는 지침에 대상 범위를 명시해, 근거 없는 항목을 생략하라는 지침과 충돌로 읽히지 않게 했습니다.
- README에 한국어로 답하는 언어 동작과 `keep-coding-instructions`를 적었습니다.
- 결정적 gate가 output style 등록 여부를 확인하지 않는다는 점을 평가 문서에 남겼습니다.

Claude Code 2.1.228에서 검증했습니다. 대표 모델 실행 결과는 [docs/EVALUATION.md](docs/EVALUATION.md)에 있습니다.

## 0.1.0

- 사실과 불확실성을 보존하는 `Korean Plain` output style을 추가했습니다.
- 단일 output style만 제공하는 Claude Code plugin과 marketplace manifest를 추가했습니다.
- 합성 fixture, 결정적 평가기, 설치 검증, 공개 문서를 추가했습니다.

이 버전은 skill, agent, hook, MCP server 또는 실행 파일을 포함하지 않습니다. 별도의 업로드 release asset 없이 Git tag와 저장소 내용으로 배포합니다.
