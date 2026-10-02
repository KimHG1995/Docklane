# Development Workflow

Docklane의 개발 흐름은 **작업 단위, 커밋 수, PR 생성 시점, CI 사용 방식**을 명확히 제한한다.

목적:

- Git history를 읽기 쉽게 유지
- 동일 PR에서 불필요한 workflow run 감소
- CI를 formatter/debugger로 사용하는 패턴 방지
- 최신 head의 검증 결과만 신뢰
- mutation 변경의 안전 조건 누락 방지

## 1. Standard Flow

```text
latest main
  ↓
single-purpose branch
  ↓
implementation completed
  ↓
format / type / test preflight
  ↓
batch commit
  ↓
open PR
  ↓
CI
  ↓
review / one batched fix if needed
  ↓
latest-head green
  ↓
squash merge
  ↓
main validation
```

## 2. Branch Rule

- 항상 최신 `main`에서 생성한다.
- 하나의 branch에는 하나의 작업 목적만 둔다.
- 이미 존재하는 branch 이름을 재사용하기 전에 상태를 확인한다.
- merge된 오래된 branch를 다음 작업의 기반으로 사용하지 않는다.
- `main`에 직접 기능 커밋을 만들지 않는다.

## 3. Commit Rule

기본:

```text
one coherent task
  -> one batch commit
```

여러 커밋이 필요한 경우에도 논리적 이유가 있어야 한다.

피해야 할 패턴:

```text
file A change -> commit
file B change -> commit
file C change -> commit
gofmt A -> commit
gofmt B -> commit
type fix -> commit
```

자동화/AI 작업은 가능한 경우 blob/tree를 구성한 뒤 한 번의 commit으로 branch ref를 갱신한다.

## 4. PR Creation Rule

PR은 코드 작성 시작 시점이 아니라 **review 가능한 상태**에서 생성한다.

PR 생성 전 최소 확인:

- scope 완료
- formatting 완료
- contract/schema 동기화
- tests 준비
- documentation 영향 검토
- secret 검토

PR을 CI를 얻기 위한 임시 실행 버튼처럼 사용하지 않는다.

## 5. CI Rule

Workflow는 PR과 `main` push에서 실행되지만, 모든 컴포넌트를 무조건 빌드하지 않는다.

변경 경로를 먼저 분류한 뒤 영향을 받는 API/Web/Agent job만 실행한다. 문서-only 변경은 runtime build를 생략한다. 상세 기준은 [CI/CD Change Scope Policy](CI_CD_POLICY.md)를 따른다.

동일 PR에 새 commit이 들어오면 이전 run은 취소될 수 있다. merge 판단은 항상 **latest head**의 결과만 사용한다.

실패 시:

```text
collect full failure logs
  ↓
identify root cause(s)
  ↓
fix related issues together
  ↓
one follow-up commit
  ↓
rerun latest head
```

다음 방식은 피한다.

```text
guess one fix
  -> push
  -> wait CI
  -> guess next fix
  -> push
  -> wait CI
```

## 6. CI Result Meaning

PR branch에서 과거 run이 failed여도 최신 head가 green이면 현재 코드는 검증된 상태다.

`main`에서 merge commit에 대해 validation이 다시 실행되는 것은 의도된 동작이다. 단, 변경 영향이 없는 component job은 skip될 수 있다.

```text
PR latest head ✅
  ↓ squash merge
main push validation ✅
```

## 7. Merge Rule

다음 조건을 만족한 경우에만 merge한다.

- PR scope가 단일 목적
- latest head CI success
- unresolved review issue 없음
- contract/docs 영향 반영
- mutation인 경우 safety checklist 충족

기본 merge 전략은 squash merge다.

## 8. Mutation-specific Gate

새 mutation은 최소 다음 모델을 가져야 한다.

```text
resolve canonical target
  ↓
coordinate affected resource locks
  ↓
persist intent
  ↓
precondition check
  ↓
execute
  ↓
inspect/reconcile
  ↓
verify convergence
  ↓
SUCCESS / FAILED / NEEDS_ATTENTION
```

CI green만으로 runtime safety가 증명된다고 가정하지 않는다. race, response loss, process restart, external mutation 시나리오를 테스트에 포함한다.


## 9. CI Noise Budget

CI 실행 횟수 자체도 개발 품질의 일부로 본다. 실패를 숨기는 것이 아니라, **로컬 또는 정적 검증으로 잡을 수 있는 실패를 Actions까지 올리지 않는 것**이 목표다.

기본 원칙:

```text
implementation
  ↓
local/static preflight
  ↓
review complete diff
  ↓
single push
  ↓
CI validation
```

금지에 가까운 패턴:

```text
guess
  -> push
  -> CI failure
  -> guess
  -> push
  -> CI failure
```

특히 다음 항목은 PR push 전에 확인한다.

- TypeScript type/test/build
- Go fmt/vet/test/build
- shell `bash -n`
- workflow YAML 구조와 referenced path
- 인증서/secret/file path 존재 가정
- Docker port/network 접근 경로
- process lifecycle과 cleanup
- fixture/test 기대값이 변경된 정책과 일치하는지

## 10. Product PR vs Acceptance PR

새 Operational/Functional PoC나 GitHub Actions harness는 제품 코드와 원칙적으로 분리한다.

### PR A — Product

포함:

- runtime/product code
- unit test
- deterministic integration regression
- 기존 CI/PoC 호환성 수정

완료 조건:

- 기존 validation green
- 기존 mTLS/DB/Agent PoC 등 영향 범위 green
- 새 heavy harness 없이도 코드 정책이 테스트로 설명됨

### PR B — Acceptance

포함:

- DinD topology
- network partition/resource pressure
- TLS/certificate orchestration
- process kill/restart
- backup/restore drill
- 새 GitHub Actions workflow 또는 heavy scenario
- acceptance evidence
- acceptance 결과를 반영하는 문서

완료 조건:

- shell/workflow static preflight
- 실제 acceptance 성공
- evidence 생성
- 문서와 run 번호 정리
- 이후 prose-only commit으로 동일 heavy workflow를 다시 돌리지 않도록 최종 상태를 한 번에 push

제품 코드와 acceptance를 한 PR에 묶어도 되는 경우는 새 환경 구성 없이 빠르고 deterministic한 테스트만 추가하는 경우로 제한한다.

## 11. Failure Classification

CI 실패는 수정 전에 다음 네 종류 중 하나로 분류한다.

| 종류 | 예 | 처리 |
| --- | --- | --- |
| product | runtime logic, contract, type error | 제품 코드 수정 |
| regression test | 기대값이 새 정책과 불일치 | 테스트와 정책 재검토 후 수정 |
| harness | port, TLS path, Docker topology, cleanup | 제품 코드와 분리하여 harness 수정 |
| external | runner/provider/network outage | 코드 변경 없이 재실행 여부 판단 |

harness 실패를 product failure처럼 취급해 runtime 코드를 임의로 변경하지 않는다.
