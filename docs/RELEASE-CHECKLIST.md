# Release checklist

## 공개 전

- [ ] release version과 CHANGELOG, release note가 일치한다.
- [ ] marketplace root와 plugin directory가 `claude plugin validate --strict`를 통과한다.
- [ ] plugin tree가 manifest와 output style만 포함하며 symlink나 실행 파일이 없다.
- [ ] 모든 결정적 contract test와 합성 fixture 평가가 통과한다.
- [ ] 격리된 user scope와 project scope에서 설치, `/config` 선택, `/clear`, `Default` 복귀, disable, uninstall, marketplace remove를 검증한다.
- [ ] 설치 전후 diff에서 installer-managed marketplace 선언과 `enabledPlugins`, 사용자가 선택한 `outputStyle`을 구분한다.
- [ ] working tree와 전체 Git history, commit message, annotated tag, tag archive의 공개 allowlist와 민감 정보 검사가 통과한다.
- [ ] Claude Code 2.1.223에서 대표 모델 실행을 opt-in으로 수행하고 정제 집계만 기록한다.
- [ ] 원시 model output과 임시 evidence가 Git 추적 대상 밖에 있고 mode `0600`인지 확인한다.
- [ ] clean `main`의 release commit과 annotated `v0.1.0` tag가 같은 commit을 가리킨다.

## 공개와 rollback

공개 전에 remote 생성, push, release 생성을 별도의 외부 변경으로 취급합니다. 문제가 발견되면 marketplace 안내 중단, 후속 수정 release, GitHub release 표시 변경 등으로 신규 설치를 막거나 교정할 수 있습니다. 그러나 이미 만들어진 public clone, fork, cache와 내려받은 파일은 완전히 회수할 수 없습니다. 민감 정보는 삭제 commit만으로 해결되지 않으므로 공개 전에 history 전체를 검사해야 합니다.

Community Marketplace 제출과 다른 비공개 저장소에 release를 vendor하는 작업은 v0.1.0 완료 범위에 포함하지 않습니다. v0.1.0은 별도의 업로드 release asset을 요구하지 않습니다.
