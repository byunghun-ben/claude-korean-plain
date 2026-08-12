# 기여하기

Korean Plain은 읽기 쉬운 한국어와 사실 보존을 함께 지키는 작은 output style입니다. 변경은 재현 가능한 regression에서 시작합니다.

## 응답 품질 변경

1. 실제 대화 원문 대신 비밀과 개인 정보를 제거한 최소 합성 입력을 만듭니다.
2. `fixtures/claude-response-quality-cases.json`에 재현 fixture를 먼저 추가합니다. 반드시 보존할 사실과 생성하면 안 되는 사실을 함께 선언합니다.
3. 새 fixture가 기존 동작의 문제를 재현하는지 확인합니다.
4. style 또는 평가기를 최소 범위로 수정합니다.
5. 결정적 검사를 실행합니다.

```sh
node scripts/evaluate.mjs validate
node tests/evaluate.test.mjs
node tests/plugin-contract.test.mjs
node tests/docs-contract.test.mjs
```

테스트를 삭제하거나 assertion을 약하게 만들어 통과시키지 않습니다. 모델 실행은 선택 사항이며 결정적 검사를 대신하지 않습니다. 실행 방법과 증거 취급은 [docs/EVALUATION.md](docs/EVALUATION.md)를 따릅니다.

## 문서와 배포 변경

- 공개 명령, 설정 범위, 지원 범위가 바뀌면 README와 문서 계약 테스트를 함께 고칩니다.
- plugin은 output style만 포함해야 합니다. 새 component나 런타임 의존성 제안은 먼저 issue에서 범위를 합의합니다.
- 변경 전에 [docs/RELEASE-CHECKLIST.md](docs/RELEASE-CHECKLIST.md)의 공개 경계를 확인합니다.

Issue나 pull request에는 secret, 인증 정보, 개인 정보, 원시 대화 transcript를 넣지 마세요. 필요한 사례는 같은 의미를 가진 합성 입력으로 바꿉니다.
