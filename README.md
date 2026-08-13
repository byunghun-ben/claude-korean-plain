# Korean Plain

Korean Plain은 Claude Code의 답변을 자연스럽고 읽기 쉬운 한국어로 다듬는 output style 플러그인입니다. 사실, 불확실성, 검증 경계를 보존하면서 번역투와 불필요한 구조를 줄입니다. 답변을 무조건 짧게 만드는 도구는 아닙니다.

이 저장소는 MIT License로 배포됩니다. Claude Code 2.1.228에서 검증했습니다. 다른 버전의 호환성은 아직 검증하지 않았습니다.

## 여러 언어를 오가는 경우

Korean Plain `v0.2.0`은 계속 사용할 수 있습니다. 한국어로만 답하도록 고정하는 대신, 사용자가 입력하거나 요청한 언어에 맞춰 답하는 방식을 원한다면 더 넓은 범위의 [Plain Language `v0.1.0`](https://github.com/byunghun-ben/claude-plain-language/releases/tag/v0.1.0)을 선택할 수 있습니다.

자동으로 이전되는 것은 아닙니다. 사용자가 직접 전환해야 합니다. Korean Plain을 제거할 필요는 없지만, 두 플러그인 모두 output style을 강제하므로 동시에 활성화하면 안 됩니다. Korean Plain을 설치된 상태로 남겨 두고 비활성화한 다음 Plain Language를 설치하면 쉽게 되돌릴 수 있습니다.

```sh
claude plugin disable korean-plain@claude-korean-plain --scope user
claude plugin marketplace add --scope user https://github.com/byunghun-ben/claude-plain-language.git
claude plugin install --scope user plain-language@claude-plain-language
```

Korean Plain 자체의 배포물과 ID는 바뀌지 않았습니다. 단독 설치 검증 범위는 [Korean Plain `v0.2.0`](https://github.com/byunghun-ben/claude-korean-plain/releases/tag/v0.2.0)과 [Plain Language 격리 설치 검증 기록](https://github.com/byunghun-ben/claude-plain-language/blob/v0.1.0/docs/verification/lifecycle.md)에서 확인할 수 있습니다.

## 설치

기본 user scope로 설치하면 다음 명령을 실행합니다.

```sh
claude plugin marketplace add https://github.com/byunghun-ben/claude-korean-plain.git --scope user
claude plugin install korean-plain@claude-korean-plain --scope user
```

한 프로젝트에만 설치하려면 그 프로젝트 디렉터리에서 두 명령 모두 project scope로 실행합니다.

```sh
claude plugin marketplace add https://github.com/byunghun-ben/claude-korean-plain.git --scope project
claude plugin install korean-plain@claude-korean-plain --scope project
```

scope에 따라 설치기가 관리하는 marketplace 선언과 `enabledPlugins`는 user 설정(`~/.claude/settings.json`) 또는 project 설정(`.claude/settings.json`)에 기록될 수 있습니다.

## 적용과 해제

설치하고 `/clear`로 대화를 비우거나 새 세션을 시작하면 적용됩니다. `/config`에서 따로 고를 필요가 없습니다.

이 플러그인은 `force-for-plugin: true`를 사용합니다. 플러그인이 켜져 있는 동안 이 style이 자동으로 적용되고, `/config`에서 고른 output style보다 우선합니다. `outputStyle` 설정을 `Default`로 두어도 이 style이 적용됩니다. 설치가 `outputStyle` 설정을 대신 바꾸지는 않습니다. 적용은 설정 파일이 아니라 실행 중에 일어납니다.

끄는 방법은 플러그인을 비활성화하는 것입니다. 그 뒤 `/clear` 또는 새 세션을 사용합니다.

```sh
claude plugin disable korean-plain@claude-korean-plain --scope user
```

여러 플러그인이 같은 방식으로 output style을 강제하면 먼저 로드된 것이 적용됩니다.

`/config`의 Output style 항목은 저장된 설정값을 보여 줍니다. 이 플러그인이 켜져 있으면 그 값이 `Default`여도 실제로는 이 style이 적용되므로, 화면에 보이는 값과 실제 적용이 다를 수 있습니다.

## 답변 변화 예시

아래는 이 스타일이 목표로 하는 변화의 예시입니다. 같은 입력에도 실제 문장은 달라질 수 있습니다.

| 기준 | 적용 전 | 적용 후 |
| --- | --- | --- |
| 사실 보존 | “API에 해당 필드가 없습니다.” | “확인한 응답에서는 해당 필드를 찾지 못했습니다.” |
| 번역투 완화 | “이것은 다음을 수행하는 것이 권장됩니다.” | “다음과 같이 진행하는 편이 좋습니다.” |
| 불필요한 영어 제거 | “Validation gate에서 failure가 발생했습니다.” | “검증 단계에서 실패했습니다.” |
| 절제된 구조 | 짧은 답도 여러 제목과 요약으로 반복 | 결론을 먼저 쓰고, 필요한 근거만 짧게 덧붙임 |

## 적용 범위와 한계

- Korean Plain은 skill이 아니므로 호출할 slash command가 없습니다. 플러그인이 켜져 있는 동안 적용되는 output style입니다.
- 사용자가 다른 언어를 요청하지 않는 한 한국어로 답합니다. 영어로 질문해도 한국어 답이 옵니다.
- `keep-coding-instructions: true`를 사용하므로 Claude Code의 코딩 관련 기본 지침은 그대로 유지됩니다.
- 이 style은 주 대화의 system prompt를 바꿉니다. 일반 subagent에는 적용되지 않습니다. 다만 부모 대화를 fork한 agent는 부모 system prompt를 상속합니다.
- global `CLAUDE.md`, permissions, hooks, MCP 설정을 추가하거나 변경하지 않습니다.
- 설치기는 선택한 scope의 marketplace 선언과 `enabledPlugins`를 관리합니다. `outputStyle` 설정은 사용자가 `/config`에서 직접 바꿀 때만 기록되며, 이 플러그인이 켜져 있는 동안에는 그 값이 적용되지 않습니다.
- 더 짧은 답이 아니라, 독자가 먼저 이해할 수 있고 사실과 불확실성을 잃지 않는 한국어를 목표로 합니다.

## 비활성화와 제거

user scope 설치를 잠시 끄거나 완전히 제거하려면 다음 순서로 실행합니다.

```sh
claude plugin disable korean-plain@claude-korean-plain --scope user
claude plugin uninstall korean-plain@claude-korean-plain --scope user
claude plugin marketplace remove claude-korean-plain --scope user
```

project scope 설치라면 같은 프로젝트 디렉터리에서 `--scope project`를 사용합니다.

```sh
claude plugin disable korean-plain@claude-korean-plain --scope project
claude plugin uninstall korean-plain@claude-korean-plain --scope project
claude plugin marketplace remove claude-korean-plain --scope project
```

비활성화만 해도 style은 더 이상 적용되지 않고 설치 상태는 남습니다. uninstall은 플러그인을 제거하고, marketplace remove는 marketplace 선언을 제거합니다. `/config`에 남아 있던 `outputStyle` 값은 이 플러그인을 끈 뒤부터 다시 적용됩니다.

## 개발

평가 방식은 [docs/EVALUATION.md](docs/EVALUATION.md), 기여 절차는 [CONTRIBUTING.md](CONTRIBUTING.md), 보안 제보 지침은 [SECURITY.md](SECURITY.md)를 참고하세요.
